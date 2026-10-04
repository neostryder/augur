// Builds the dispatch service for a packaged install: plain JavaScript files, a copy of the Node runtime, launchers for the augur and augur-mcp
// commands, and on Windows the job host and credential reader, in dist/service. Nothing in there needs tsx, node_modules or a source checkout.
// Run with `pnpm build:service`. AUGUR_NODE names a different runtime to copy, such as a universal macOS build made with lipo.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'service');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entries = {
  augurd: join(root, 'packages/augurd/src/main.ts'),
  runner: join(root, 'packages/augurd/src/runner.ts'),
  'api-call': join(root, 'packages/augurd/src/adapters/api-call.ts'),
  augur: join(root, 'packages/dispatch-cli/src/main.ts'),
  'augur-mcp': join(root, 'packages/mcp/src/main.ts'),
};
// Adapters kept on one computer are bundled beside the service when their folder is present, and are absent from every other build.
const localDir = join(root, 'packages/augurd/src/adapters/private');
if (existsSync(join(localDir, 'index.ts'))) {
  entries['local-adapters'] = join(localDir, 'index.ts');
  // A local adapter that runs its work in a child process names that script `<something>-call.ts`.
  for (const f of readdirSync(localDir)) if (f.endsWith('-call.ts')) entries[f.slice(0, -3)] = join(localDir, f);
}
await build({
  entryPoints: entries, outdir: out, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24',
  // A bundled file that uses require() (a CommonJS dependency) needs one; nothing here does today, but a later dependency might.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none', logLevel: 'warning', define: { __AUGUR_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')).version) },
});

if (process.platform === 'win32') {
  const host = join(root, 'packages/augurd/native/bin/jobhost.exe'), cred = join(root, 'packages/augurd/native/bin/credread.exe');
  if (!existsSync(host) || !existsSync(cred)) execFileSync('pnpm', ['--filter', '@augur/augurd', 'build:jobhost'], { cwd: root, stdio: 'inherit', windowsHide: true, shell: true });
  copyFileSync(host, join(out, 'jobhost.exe'));
  copyFileSync(cred, join(out, 'credread.exe'));
}
// The runtime is copied under its own name so an installer can tell the service's processes from anyone else's node.
const runtime = process.env.AUGUR_NODE || process.execPath;
if (process.platform === 'win32') {
  copyFileSync(runtime, join(out, 'augur-node.exe'));
  writeFileSync(join(out, 'augur.cmd'), '@"%~dp0augur-node.exe" "%~dp0augur.mjs" %*\r\n');
  writeFileSync(join(out, 'augur-mcp.cmd'), '@"%~dp0augur-node.exe" "%~dp0augur-mcp.mjs" %*\r\n');
} else {
  copyFileSync(runtime, join(out, 'augur-node'));
  chmodSync(join(out, 'augur-node'), 0o755);
  // A launcher reached through a link (such as /usr/bin/augur) finds the service folder from the link's target.
  const launcher = (script) => `#!/bin/sh\nhere=$(dirname "$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")")\nexec "$here/augur-node" "$here/${script}" "$@"\n`;
  for (const [name, script] of [['augur', 'augur.mjs'], ['augur-mcp', 'augur-mcp.mjs']]) {
    writeFileSync(join(out, name), launcher(script));
    chmodSync(join(out, name), 0o755);
  }
}
const size = (f) => (statSync(join(out, f)).size / 1024).toFixed(0) + ' KB';
console.log(`built dist/service: ${Object.keys(entries).map(n => `${n}.mjs ${size(n + '.mjs')}`).join(', ')}`);
