import { readFile, writeFile } from 'node:fs/promises';
import { createNodeHost } from '../src/hosts/node.js';
import { collect } from '../src/engine.js';
import { defaultConfig, migrateConfig } from '../src/config.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const configPath = option('--config') ?? args.find(arg => !arg.startsWith('--') && !args.some((value, i) => i > 0 && value === arg && args[i - 1]?.startsWith('--')));
const output = option('--output');
const map = Object.fromEntries((option('--secret-map') ?? '').split(',').filter(Boolean).map(part => {
  const at = part.indexOf('='); return [part.slice(0, at), part.slice(at + 1)];
}));
const config = configPath ? migrateConfig(JSON.parse(await readFile(configPath, 'utf8'))) : defaultConfig();
const snapshot = await collect(createNodeHost({ bwsProject: option('--bws'), secretMap: map }), config);
if (output) await writeFile(output, JSON.stringify(snapshot, null, 2), 'utf8');
const summary = Object.values(snapshot.providers).map(provider => `${provider.name}: ${provider.ok ? 'ok' : provider.stale ? 'stale' : provider.error}`).join(' | ');
console.log(summary);
