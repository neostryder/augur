// augur-jev-gateway: `serve` (the default) runs the listener, `token <name>` adds a consumer and prints its token once, `check` reports the settings.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigFile, augurHome, configPath, parseConfig } from './config.js';
import { readKey } from './key.js';
import { createGateway } from './server.js';

const log = (msg: string) => { try { mkdirSync(augurHome(), { recursive: true }); appendFileSync(join(augurHome(), 'jev-gateway.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* logging is best effort */ } };

function addToken(name: string): string {
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(name)) throw new Error('A consumer name is 1 to 48 letters, digits, dots, dashes or underscores.');
  const path = configPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const token = `jgw_${randomBytes(32).toString('base64url')}`;
  const consumers = { ...((raw.consumers ?? {}) as Record<string, string>), [name]: createHash('sha256').update(token).digest('hex') };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...raw, consumers }, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return token;
}

async function serve(): Promise<void> {
  const file = new ConfigFile();
  const { config, problems } = file.get();
  for (const p of problems) log(`settings: ${p}`);
  const { server } = createGateway({ configFile: file });
  server.on('error', e => { log(`listener error: ${(e as Error).message}`); console.error((e as Error).message); process.exit(1); });
  server.listen(config.port, config.host, () => {
    const a = server.address();
    log(`listening on ${config.host}:${typeof a === 'object' && a ? a.port : config.port}, model ${config.model}`);
  });
  const quit = (s: string) => { log(`received ${s}`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', () => quit('SIGINT')); process.on('SIGTERM', () => quit('SIGTERM'));
  process.on('uncaughtException', e => { log(`stopped by an uncaught error: ${e.stack ?? e.message}`); process.exit(1); });
  process.on('unhandledRejection', e => { log(`stopped by an unhandled rejection: ${(e as Error)?.stack ?? String(e)}`); process.exit(1); });
}

const [cmd = 'serve', arg] = process.argv.slice(2);
if (cmd === 'serve') void serve();
else if (cmd === 'token') {
  if (!arg) { console.error('usage: jev-gateway token <consumer name>'); process.exit(2); }
  console.log(addToken(arg));
} else if (cmd === 'check') {
  let raw: unknown = {};
  try { if (existsSync(configPath())) raw = JSON.parse(readFileSync(configPath(), 'utf8')); } catch (e) { console.error(`The settings file is not valid JSON: ${(e as Error).message}`); process.exit(1); }
  const { config, problems } = parseConfig(raw);
  console.log(JSON.stringify({ file: configPath(), host: config.host, port: config.port, model: config.model, pins: config.pins, defaultTier: config.defaultTier, consumers: Object.keys(config.consumers),
    requireToken: config.requireToken, laya: config.laya.map(s => s.name), hostedKey: readKey(config.key) !== null, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
} else { console.error('usage: jev-gateway [serve | token <name> | check]'); process.exit(2); }
