import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PINNED_KEY } from '../src/minisign.js';

const script = readFileSync(join(__dirname, '..', '..', '..', 'packaging', 'macos', 'install.sh'), 'utf8').replace(/\r\n/g, '\n');
const verifier = /<< 'NODE'\n([\s\S]*?)\nNODE\n/.exec(script)?.[1] ?? '';
const dir = mkdtempSync(join(tmpdir(), 'augur-install-sig-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keys = generateKeyPairSync('ed25519'), id = randomBytes(8);
const raw = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
const pub = Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`).toString('base64');
const sig = (text: string) => `untrusted comment: s\n${Buffer.concat([Buffer.from('ED'), id, sign(null, createHash('blake2b512').update(text).digest(), keys.privateKey)]).toString('base64')}\n`;
const run = (text: string, signature: string, key: string) => {
  writeFileSync(join(dir, 'sums'), text); writeFileSync(join(dir, 'sums.sig'), signature);
  return spawnSync('node', ['-', join(dir, 'sums'), join(dir, 'sums.sig'), key], { input: verifier, encoding: 'utf8' }).status;
};

describe('the install script signature check', () => {
  it('is embedded in the script and pins the updater key', () => {
    expect(verifier.length).toBeGreaterThan(100);
    expect(script).toContain(PINNED_KEY);
  });
  it('accepts a good signature and refuses a changed list, a wrong key, and no signature', () => {
    const text = 'abc  file.tar.gz\n';
    expect(run(text, sig(text), pub)).toBe(0);
    expect(run('abd  file.tar.gz\n', sig(text), pub)).toBe(1);
    expect(run(text, sig(text), PINNED_KEY)).toBe(1);
    expect(run(text, '', pub)).toBe(1);
  });
});
