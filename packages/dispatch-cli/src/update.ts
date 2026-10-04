// `augur update`: what each kind of install does about a newer version. A copy put in place by the macOS install script downloads the new
// release, checks it against the release's checksums and swaps it in. A package or the window app says how to update with its own tool.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { compareVersions } from '@augur/core';

export type InstallKind = 'script' | 'pacman' | 'app' | 'source';
export interface Install { kind: InstallKind; /** The folder the script install keeps its versions in. */ root: string | null; /** The folder this copy runs from. */ dir: string }

const REPO = 'https://github.com/neostryder/augur/releases';
/** How many versions the script install keeps, so a login entry that still points at the old one keeps working until it is rewritten. */
const KEEP = 2;

/** Tells how this copy was installed from where its files sit. */
export function installOf(scriptDir: string): Install {
  let dir = scriptDir;
  try { dir = realpathSync(scriptDir); } catch { /* a folder that is gone reads as it is */ }
  const parent = dirname(dir), root = dirname(parent);
  if (basename(parent) === 'versions' && existsSync(join(root, 'install.json'))) return { kind: 'script', root, dir };
  if (dir === '/usr/lib/augur') return { kind: 'pacman', root: null, dir };
  if (basename(dir) === 'service') return { kind: 'app', root: null, dir };
  return { kind: 'source', root: null, dir };
}

/** The words after "Version x is available." on the settings page, and what `augur update` prints for installs it does not manage. */
export function updateAdvice(kind: InstallKind): string {
  switch (kind) {
    case 'script': return 'Run augur update to install it.';
    case 'pacman': return 'Build the new augur-terminal package to install it, with makepkg -si from the updated PKGBUILD.';
    case 'app': return 'The Augur app installs updates from its settings.';
    default: return 'Pull the new source and build it again.';
  }
}

export interface UpdateDeps {
  /** The version this copy is. */
  current: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fetchText(url: string): Promise<string>;
  fetchTo(url: string, file: string): Promise<void>;
  /** Unpacks a tarball into a folder. */
  untar(file: string, into: string): void;
  /** Stops the service so the new version starts in its place, and rewrites the login entry when there is one. */
  afterSwap(newDir: string): Promise<string>;
}

export interface UpdateResult { ok: boolean; changed: boolean; message: string; version?: string }

const sha256 = async (file: string): Promise<string> => {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
};

/** The checksum a SHA256SUMS.txt line gives for a file name. */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return null;
}

export async function updateScriptInstall(install: Install, deps: UpdateDeps, force = false): Promise<UpdateResult> {
  if (install.kind !== 'script' || !install.root) return { ok: false, changed: false, message: updateAdvice(install.kind) };
  if (deps.platform !== 'darwin') return { ok: false, changed: false, message: 'The script install is for macOS.' };
  const base = deps.env.AUGUR_RELEASE_URL ?? REPO;
  let latest: string;
  try {
    const feed = JSON.parse(await deps.fetchText(`${base}/latest/download/latest.json`)) as { version?: string };
    latest = String(feed.version ?? '').replace(/^v/, '');
  } catch (e) { return { ok: false, changed: false, message: `Could not read the latest version (${(e as Error).message}).` }; }
  if (!latest) return { ok: false, changed: false, message: 'The release list does not name a version.' };
  if (!force && compareVersions(latest, deps.current) <= 0) return { ok: true, changed: false, message: `Version ${deps.current} is the latest.`, version: deps.current };

  const name = `augur-terminal-${latest}-macos.tar.gz`, tag = `${base}/download/v${latest}`;
  const work = mkdtempSync(join(install.root, '.update-'));
  try {
    const sums = await deps.fetchText(`${tag}/SHA256SUMS.txt`);
    const want = checksumFor(sums, name);
    if (!want) return { ok: false, changed: false, message: `${name} has no checksum in the release, so it was not installed.` };
    const file = join(work, name);
    await deps.fetchTo(`${tag}/${name}`, file);
    if (await sha256(file) !== want) return { ok: false, changed: false, message: `The download of ${name} does not match its checksum, so it was not installed.` };
    const stage = join(work, 'unpacked');
    mkdirSync(stage);
    deps.untar(file, stage);
    const unpacked = join(stage, `augur-terminal-${latest}`);
    if (!existsSync(join(unpacked, 'augur.mjs'))) return { ok: false, changed: false, message: `${name} does not hold an Augur install, so it was not installed.` };
    const versions = join(install.root, 'versions'), target = join(versions, latest);
    mkdirSync(versions, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(unpacked, target);
    // A link swapped by renaming a new one over it, so the command is never missing.
    const link = join(install.root, 'current'), next = join(install.root, '.current-new');
    rmSync(next, { force: true, recursive: true });
    // A Windows junction needs an absolute target and cannot be renamed over another, so there the old one goes first. The script install itself is macOS only.
    symlinkSync(process.platform === 'win32' ? target : join('versions', latest), next, 'junction');
    if (process.platform === 'win32') rmSync(link, { force: true, recursive: true });
    renameSync(next, link);
    writeFileSync(join(install.root, 'install.json'), JSON.stringify({ method: 'script', version: latest }) + '\n');
    prune(versions, latest);
    const after = await deps.afterSwap(target);
    return { ok: true, changed: true, version: latest, message: `Updated to version ${latest}. ${after}`.trim() };
  } catch (e) {
    return { ok: false, changed: false, message: `The update did not finish: ${(e as Error).message}. The installed version is unchanged.` };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Removes all but the newest few versions, never the one just installed. */
function prune(versions: string, keep: string): void {
  const all = readdirSync(versions).filter((v) => /^\d/.test(v)).sort(compareVersions).reverse();
  for (const v of all.slice(KEEP)) if (v !== keep) rmSync(join(versions, v), { recursive: true, force: true });
}

/** Real network and tar for `augur update`; tests give their own. */
export const realFetch = {
  async fetchText(url: string): Promise<string> {
    const r = await fetch(url, { headers: { 'User-Agent': 'augur' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.text();
  },
  async fetchTo(url: string, file: string): Promise<void> {
    const r = await fetch(url, { headers: { 'User-Agent': 'augur' }, redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`${url} answered ${r.status}`);
    await pipeline(Readable.fromWeb(r.body as never), createWriteStream(file));
  },
  untar(file: string, into: string): void {
    const r = spawnSync('tar', ['-xzf', file, '-C', into], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  },
};

export const versionOf = (dir: string): string | null => {
  try { return readFileSync(join(dir, 'VERSION'), 'utf8').trim(); } catch { return null; }
};
