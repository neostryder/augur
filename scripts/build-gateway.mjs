// Bundles the Jev gateway into one plain JavaScript file that runs on any computer with Node 24 or newer, with no checkout and no node_modules.
// Run with `node scripts/build-gateway.mjs [output folder]`; the default is dist/jev-gateway. Copy the file to the machine and start it with `node jev-gateway.mjs`.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'dist', 'jev-gateway'));
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { 'jev-gateway': join(root, 'packages/jev-gateway/src/main.ts') }, outdir: out, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, legalComments: 'none', logLevel: 'warning',
});
console.log(join(out, 'jev-gateway.mjs'));
