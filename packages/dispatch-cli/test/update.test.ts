import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PINNED_KEY, verifyMinisign } from '../src/minisign.js';
import { checksumFor, installOf, realFetch, updateAdvice, updateScriptInstall, type UpdateDeps } from '../src/update.js';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'augur-update-')); cleanup.push(d); return d; };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A script install of `have` under a temporary root, with the folder layout the install script makes. */
function scriptInstall(have = '1.3.0', more: string[] = []) {
  const root = temp();
  for (const v of [have, ...more]) { mkdirSync(join(root, 'versions', v), { recursive: true }); writeFileSync(join(root, 'versions', v, 'augur.mjs'), ''); }
  writeFileSync(join(root, 'install.json'), '{"method":"script"}\n');
  return { root, install: installOf(join(root, 'versions', have)) };
}

/** A throwaway signing key, with the public key and signatures written the way minisign writes them. */
const keys = generateKeyPairSync('ed25519');
const keyId = randomBytes(8);
const rawPub = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
const pubFile = `untrusted comment: minisign public key: test\n${Buffer.concat([Buffer.from('Ed'), keyId, rawPub]).toString('base64')}\n`;
export const signSums = (text: string, algo: 'ED' | 'Ed' = 'ED'): string => {
  const signed = algo === 'ED' ? createHash('blake2b512').update(text).digest() : Buffer.from(text);
  return `untrusted comment: signature\n${Buffer.concat([Buffer.from(algo), keyId, edSign(null, signed, keys.privateKey)]).toString('base64')}\ntrusted comment: t\nAAAA\n`;
};
const base64Wrapped = (text: string): string => Buffer.from(text).toString('base64');

const TAR = 'tar bytes';
function deps(over: Partial<UpdateDeps> & { latest?: string; sums?: string; sig?: string | null } = {}) {
  const latest = over.latest ?? '1.4.0', name = `augur-terminal-${latest}-macos.tar.gz`;
  const log: string[] = [];
  const d: UpdateDeps = {
    current: '1.3.0', platform: 'darwin', env: { AUGUR_RELEASE_URL: 'https://example.test/releases' }, pubkey: pubFile,
    async fetchText(url) {
      log.push(url);
      if (url.endsWith('/latest.json')) return JSON.stringify({ version: latest });
      const sums = over.sums ?? `${sha(TAR)}  ${name}\n${'0'.repeat(64)}  other.dmg\n`;
      if (url.endsWith('/SHA256SUMS.txt')) return sums;
      if (url.endsWith('/SHA256SUMS.txt.sig')) { if (over.sig === null) throw new Error('404'); return over.sig ?? signSums(sums); }
      throw new Error('unexpected ' + url);
    },
    async fetchTo(url, file) { log.push(url); writeFileSync(file, TAR); },
    untar(_file, into) { const dir = join(into, `augur-terminal-${latest}`); mkdirSync(dir); writeFileSync(join(dir, 'augur.mjs'), 'new'); writeFileSync(join(dir, 'VERSION'), latest); },
    async afterSwap() { return 'Restarted.'; },
    ...over,
  };
  return { d, log };
}

describe('installOf', () => {
  it('reads a script install from its versions folder and install.json', () => {
    const { root, install } = scriptInstall();
    expect(install.kind).toBe('script');
    expect(install.root).toBe(realpathSync(root));
  });
  it('tells a package, the app and a source checkout apart', () => {
    expect(installOf(temp()).kind).toBe('source');
    const app = join(temp(), 'service'); mkdirSync(app);
    expect(installOf(app).kind).toBe('app');
    // The window app's Arch package leaves a marker beside the service folder, and then pacman owns the install.
    const owned = temp(); mkdirSync(join(owned, 'service'));
    expect(installOf(join(owned, 'service')).kind).toBe('app');
    writeFileSync(join(owned, 'package-manager'), 'pacman');
    expect(installOf(join(owned, 'service')).kind).toBe('pacman');
    // A versions folder without install.json is not a script install.
    const loose = join(temp(), 'versions', '1.0.0'); mkdirSync(loose, { recursive: true });
    expect(installOf(loose).kind).toBe('source');
  });
  it('words the next step for each kind', () => {
    expect(updateAdvice('script')).toBe('Run augur update to install it.');
    expect(updateAdvice('pacman')).toContain('makepkg -si');
    expect(updateAdvice('app')).toContain('settings');
  });
});

describe('verifyMinisign', () => {
  it('accepts both signature algorithms and the base64-wrapped files Tauri writes, and refuses anything else', () => {
    const text = 'a list\n';
    expect(verifyMinisign(text, signSums(text), pubFile)).toBe(true);
    expect(verifyMinisign(text, signSums(text, 'Ed'), pubFile)).toBe(true);
    expect(verifyMinisign(text, base64Wrapped(signSums(text)), base64Wrapped(pubFile))).toBe(true);
    expect(verifyMinisign('another\n', signSums(text), pubFile)).toBe(false);
    expect(verifyMinisign(text, signSums(text), PINNED_KEY)).toBe(false);
    expect(verifyMinisign(text, '', pubFile)).toBe(false);
  });
  it('pins the same key the desktop updater uses', () => {
    const conf = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8')) as { plugins: { updater: { pubkey: string } } };
    expect(PINNED_KEY).toBe(conf.plugins.updater.pubkey);
  });
});

describe('checksumFor', () => {
  it('finds the line for a file, with either separator style', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64);
    expect(checksumFor(`${a}  x.dmg\r\n${b} *y.tar.gz\n`, 'y.tar.gz')).toBe(b);
    expect(checksumFor(`${a}  x.dmg\n`, 'z')).toBeNull();
  });
});

describe('updateScriptInstall', () => {
  it('downloads the new version, checks it, swaps the current link and tidies old versions', async () => {
    const { root, install } = scriptInstall('1.3.0', ['1.2.0', '1.1.0']);
    const { d, log } = deps();
    const r = await updateScriptInstall(install, d);
    expect(r).toMatchObject({ ok: true, changed: true, version: '1.4.0' });
    expect(r.message).toBe('Updated to version 1.4.0. Restarted.');
    expect(readFileSync(join(root, 'versions', '1.4.0', 'augur.mjs'), 'utf8')).toBe('new');
    expect(readlinkSync(join(root, 'current')).replace(/\\/g, '/')).toMatch(/1\.4\.0$/);
    expect(readdirSync(join(root, 'versions')).sort()).toEqual(['1.3.0', '1.4.0']);
    expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')).version).toBe('1.4.0');
    expect(readdirSync(root).filter((f) => f.startsWith('.update-'))).toEqual([]);
    expect(log).toEqual(['https://example.test/releases/latest/download/latest.json', 'https://example.test/releases/download/v1.4.0/SHA256SUMS.txt', 'https://example.test/releases/download/v1.4.0/SHA256SUMS.txt.sig', 'https://example.test/releases/download/v1.4.0/augur-terminal-1.4.0-macos.tar.gz']);
  });

  it('does nothing when this is the newest version, unless forced', async () => {
    const { install } = scriptInstall();
    expect(await updateScriptInstall(install, deps({ latest: '1.3.0' }).d)).toMatchObject({ ok: true, changed: false, message: 'Version 1.3.0 is the latest.' });
    expect((await updateScriptInstall(install, deps({ latest: '1.3.0' }).d, true)).changed).toBe(true);
  });

  it('refuses a download that does not match its checksum, and leaves the install as it was', async () => {
    const { root, install } = scriptInstall();
    const r = await updateScriptInstall(install, deps({ sums: `${'0'.repeat(64)}  augur-terminal-1.4.0-macos.tar.gz\n` }).d);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('does not match its checksum');
    expect(existsSync(join(root, 'versions', '1.4.0'))).toBe(false);
    expect(existsSync(join(root, 'current'))).toBe(false);
  });

  it('refuses checksums that are unsigned, signed by another key, or changed after signing', async () => {
    const { root, install } = scriptInstall();
    const name = 'augur-terminal-1.4.0-macos.tar.gz';
    expect((await updateScriptInstall(install, deps({ sig: null }).d)).message).toContain("not signed with Augur's release key");
    expect((await updateScriptInstall(install, deps({ sig: 'garbage' }).d)).message).toContain('not signed');
    const other = generateKeyPairSync('ed25519');
    const forged = `untrusted comment: s\n${Buffer.concat([Buffer.from('ED'), keyId, edSign(null, createHash('blake2b512').update('x').digest(), other.privateKey)]).toString('base64')}\n`;
    expect((await updateScriptInstall(install, deps({ sig: forged }).d)).message).toContain('not signed');
    const signedOnce = signSums(`${sha(TAR)}  ${name}\n`);
    expect((await updateScriptInstall(install, deps({ sums: `${sha('evil')}  ${name}\n`, sig: signedOnce }).d)).message).toContain('not signed');
    expect(existsSync(join(root, 'versions', '1.4.0'))).toBe(false);
    const sums = `${sha(TAR)}  ${name}\n`;
    expect((await updateScriptInstall(install, deps({ sums, sig: base64Wrapped(signSums(sums)) }).d)).ok).toBe(true);
  });

  it('refuses a release with no checksum for the file, or a package without Augur in it', async () => {
    const { install } = scriptInstall();
    expect((await updateScriptInstall(install, deps({ sums: `${'a'.repeat(64)}  other.dmg\n` }).d)).message).toContain('has no checksum');
    const empty = deps({ untar: (_f, into) => { mkdirSync(join(into, 'augur-terminal-1.4.0')); } });
    expect((await updateScriptInstall(install, empty.d)).message).toContain('does not hold an Augur install');
  });

  it('says how to update an install it does not manage, and reports a feed it cannot read', async () => {
    const pkg = { kind: 'pacman' as const, root: null, dir: '/usr/lib/augur' };
    expect(await updateScriptInstall(pkg, deps().d)).toMatchObject({ ok: false, changed: false });
    const { install } = scriptInstall();
    const bad = deps({ fetchText: async () => { throw new Error('offline'); } });
    expect((await updateScriptInstall(install, bad.d)).message).toContain('offline');
    expect((await updateScriptInstall(install, { ...deps().d, platform: 'linux' })).message).toBe('The script install is for macOS.');
  });
});

describe('realFetch', () => {
  it('says why a request failed instead of only that it did', async () => {
    // A port that was just free and is closed again refuses the connection.
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, 'close');
    const failure = await realFetch.fetchText(`http://127.0.0.1:${port}/latest.json`).catch((e: Error) => e);
    expect((failure as Error).message).toMatch(/could not be reached \(ECONNREFUSED\)/);
  });
});
