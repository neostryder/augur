// Packs dist/terminal (made by `pnpm build:terminal`) into the release tarball: augur-terminal-<version>.tar.gz, or with --macos
// augur-terminal-<version>-macos.tar.gz for the package that carries its own Node runtime. Everything sits under one folder named for the file.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dist', 'terminal');
if (!existsSync(join(src, 'augur.mjs'))) throw new Error('Run pnpm build:terminal first.');
const macos = process.argv.includes('--macos');
if (macos !== existsSync(join(src, 'augur-node'))) throw new Error(macos ? 'The macOS package needs augur-node; set AUGUR_NODE when building.' : 'This build carries a runtime; pack it with --macos.');
const version = readFileSync(join(src, 'VERSION'), 'utf8').trim();
const name = `augur-terminal-${version}`;
const stage = join(root, 'dist', 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(src, join(stage, name), { recursive: true });
const file = `${name}${macos ? '-macos' : ''}.tar.gz`;
// Relative paths from the staging folder, because GNU tar reads a drive letter such as C: as a remote host name.
execFileSync('tar', ['-czf', `../${file}`, name], { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log(`packed dist/${file}`);
