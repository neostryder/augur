// Reading and changing the service's config.json one setting at a time, for `augur config`. Each setting has a type and a range, and a value that the
// loader would silently replace with its default is refused here instead, so a typo never looks like it worked.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ADAPTERS } from './adapters/index.js';
import { DEFAULT_CONFIG, loadConfig, plainHost, gatewayAddress } from './config.js';
import type { ServiceConfig } from './config.js';

export interface ConfigKey {
  key: string;
  label: string;
  help: string;
  kind: 'number' | 'bool' | 'choice' | 'list' | 'text';
  choices?: string[];
  min?: number;
  max?: number;
  /** A setting that lowers what the service checks. The app never changes it; a person does, with the command or by editing the file. */
  weakens?: boolean;
  /** For a text setting: null when the value is fine, or what is wrong with it. */
  check?(text: string): string | null;
}

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: 'retentionDays', label: 'Keep finished jobs', help: "Logs and results stay on disk this many days after a job ends, 30 by default. The job's record stays.", kind: 'number', min: 0, max: 3650 },
  { key: 'persistPrompts', label: 'Keep prompts', help: "Saves each job's prompt in its folder. Off by default, so a prompt is deleted as soon as the job starts.", kind: 'bool' },
  { key: 'runner.charterDir', label: 'Charter folder', help: "Folder of standing instructions put in front of every job's prompt. Empty uses the charter folder in the Augur home when there is one. With no folder, jobs get no charter.", kind: 'text' },
  { key: 'runner.ambient', label: 'Harness context', help: "keep, the default, leaves each harness's own instructions, tools and plugins on. trim turns them off for Codex and Copilot. A route's ambient option overrides this.", kind: 'choice', choices: ['keep', 'trim'] },
  { key: 'runner.failover', label: 'Retry on failure', help: "on runs a failed job again on its route's next fallback when a spawn error, a provider limit or a read-only timeout stopped it. off, the default, leaves the failure as it is.", kind: 'choice', choices: ['off', 'on'] },
  { key: 'maxConcurrent', label: 'Jobs at once', help: 'How many jobs run together while the rest wait. 8 by default.', kind: 'number', min: 1, max: 64 },
  { key: 'maxDepth', label: 'Nesting depth', help: 'How many levels deep jobs may start jobs of their own. 2 by default.', kind: 'number', min: 0, max: 8 },
  { key: 'maxDescendants', label: 'Jobs one job can start', help: 'The most that one job, and the jobs it starts, can add up to. 16 by default.', kind: 'number', min: 0, max: 256 },
  { key: 'decision.backend', label: 'Task classifier', help: 'Answers the questions behind augur pick --task. Laya runs on your own machines, Jev is a hosted service that uses your key, and none turns it off.', kind: 'choice', choices: ['none', 'laya', 'jev'] },
  { key: 'decision.shadow', label: 'Compare with', help: 'Asks a second classifier the same questions and logs how it differs. Its answers are never used.', kind: 'choice', choices: ['none', 'laya', 'jev'] },
  { key: 'decision.gateway', label: 'Jev gateway address', help: 'When this is set, the Jev classifier asks this gateway instead of TypeSafe, so Augur needs no TypeSafe key of its own. Leave it empty to use your own key, and restart the service after you change it.', kind: 'text',
    check: t => (!t || gatewayAddress(t) ? null : 'decision.gateway is an http or https address, such as http://127.0.0.1:8020.') },
  { key: 'learn.recordTasks', label: 'Keep task text', help: 'Saves the text of each pick request, when its data tier allows, for training a classifier. Off by default.', kind: 'bool' },
  { key: 'adapters', label: 'Adapters', help: 'The adapters a route may use, separated by commas. codex-exec by default. The exec adapter runs any command a route names.', kind: 'list', choices: ALL_ADAPTERS.map(a => a.id) },
  { key: 'requirePick', label: 'Require a pick', help: 'Refuses a job unless its model was picked for the caller in the last hour. On by default.', kind: 'bool', weakens: true },
  { key: 'verifyNamed', label: 'Named-model claims', help: 'What happens when a caller says a person named the model. Off takes their word, record notes when it cannot be confirmed, and enforce refuses the job.', kind: 'choice', choices: ['off', 'record', 'enforce'], weakens: true },
  { key: 'web.enabled', label: 'Web app', help: "Serves Augur's web app from this service, so a browser on this computer or your network can open it. The link, with its sign-in token, comes from augur web. Off by default.", kind: 'bool', weakens: true },
  { key: 'web.host', label: 'Web app address', help: '127.0.0.1 by default, which only this computer can reach. 0.0.0.0 or the network address of this computer opens it to your network, where anyone who has the token can use Augur; serve HTTPS (web.tlsCert and web.tlsKey) or keep it behind a tunnel you trust.', kind: 'text', weakens: true,
    check: t => (plainHost(t) ? null : 'web.host is an IP address or a plain host name.') },
  { key: 'web.port', label: 'Web app port', help: '7420 by default.', kind: 'number', min: 1024, max: 65535 },
  { key: 'web.allowedHosts', label: 'Web app host names', help: 'Names besides this computer that requests may use, separated by commas, such as a DNS name or tunnel address that points here. Requests with any other host name are refused.', kind: 'text', weakens: true,
    check: t => (t.split(',').map(s => s.trim()).filter(Boolean).every(plainHost) ? null : 'web.allowedHosts is a comma-separated list of host names.') },
  { key: 'web.tlsCert', label: 'Web app certificate', help: 'Path of a PEM certificate chain. With web.tlsKey, the web app is served over HTTPS.', kind: 'text' },
  { key: 'web.tlsKey', label: 'Web app key', help: 'Path of the PEM private key for web.tlsCert.', kind: 'text' },
];

const path = (dir: string) => join(dir, 'config.json');

function readRaw(dir: string): Record<string, unknown> {
  if (!existsSync(path(dir))) return {};
  try { const v = JSON.parse(readFileSync(path(dir), 'utf8')) as unknown; return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}

function valueOf(config: ServiceConfig, key: string): string {
  switch (key) {
    case 'decision.backend': return config.decision.backend;
    case 'decision.shadow': return config.decision.shadow ?? 'none';
    case 'decision.gateway': return config.decision.gateway ?? '';
    case 'learn.recordTasks': return String(config.learn.recordTasks);
    case 'runner.charterDir': return config.runner.charterDir;
    case 'runner.ambient': return config.runner.ambient;
    case 'runner.failover': return config.runner.failover;
    case 'adapters': return config.adapters.join(',');
    case 'web.enabled': return String(config.web.enabled);
    case 'web.host': return config.web.host;
    case 'web.port': return String(config.web.port);
    case 'web.allowedHosts': return config.web.allowedHosts.join(',');
    case 'web.tlsCert': return config.web.tlsCert;
    case 'web.tlsKey': return config.web.tlsKey;
    default: return String((config as unknown as Record<string, unknown>)[key]);
  }
}

function defaultOf(key: string): string { return valueOf(DEFAULT_CONFIG, key); }

export interface ConfigLine { key: string; label: string; help: string; kind: ConfigKey['kind']; choices?: string[]; min?: number; max?: number; weakens: boolean; value: string; default: string }

/** Every setting with its current value, from the file as the service would read it. */
export function configLines(dir: string): ConfigLine[] {
  const config = loadConfig(dir);
  return CONFIG_KEYS.map(k => ({ ...k, weakens: k.weakens === true, value: valueOf(config, k.key), default: defaultOf(k.key) }));
}

export type SetResult = { ok: true; value: string } | { ok: false; error: string };

/** Checks a value against a setting's type and range, and returns it as it is stored. */
export function parseValue(k: ConfigKey, text: string): { ok: true; stored: unknown; shown: string } | { ok: false; error: string } {
  const t = text.trim();
  if (k.kind === 'number') {
    const n = Number(t);
    if (t === '' || !Number.isInteger(n) || n < (k.min ?? 0) || n > (k.max ?? Number.MAX_SAFE_INTEGER)) return { ok: false, error: `${k.key} is a whole number from ${k.min} to ${k.max}.` };
    return { ok: true, stored: n, shown: String(n) };
  }
  if (k.kind === 'bool') {
    if (t !== 'true' && t !== 'false') return { ok: false, error: `${k.key} is true or false.` };
    return { ok: true, stored: t === 'true', shown: t };
  }
  if (k.kind === 'choice') {
    if (!(k.choices ?? []).includes(t)) return { ok: false, error: `${k.key} is one of ${(k.choices ?? []).join(', ')}.` };
    return { ok: true, stored: t, shown: t };
  }
  if (k.kind === 'text') { const problem = k.check?.(t) ?? null; return problem ? { ok: false, error: problem } : { ok: true, stored: t, shown: t }; }
  const items = t.split(',').map(s => s.trim()).filter(Boolean);
  const unknown = items.filter(i => !(k.choices ?? []).includes(i));
  if (!items.length || unknown.length) return { ok: false, error: `${k.key} is a comma-separated list from ${(k.choices ?? []).join(', ')}${unknown.length ? `; not known: ${unknown.join(', ')}` : ''}.` };
  return { ok: true, stored: [...new Set(items)], shown: [...new Set(items)].join(',') };
}

/** Writes one setting into config.json, keeping every other key, and returns what the service will read for it. The service reads the file at start, so a running service needs a restart. */
export function setConfigValue(dir: string, key: string, text: string): SetResult {
  const k = CONFIG_KEYS.find(x => x.key === key);
  if (!k) return { ok: false, error: `Unknown setting ${key}. Run augur config to see them.` };
  const parsed = parseValue(k, text);
  if (!parsed.ok) return parsed;
  const raw = readRaw(dir);
  const [head, tail] = key.split('.') as [string, string | undefined];
  if (tail) {
    const inner = typeof raw[head] === 'object' && raw[head] !== null && !Array.isArray(raw[head]) ? { ...(raw[head] as Record<string, unknown>) } : {};
    inner[tail] = key === 'decision.shadow' && parsed.stored === 'none' ? null : parsed.stored;
    raw[head] = inner;
  } else raw[head] = parsed.stored;
  mkdirSync(dir, { recursive: true });
  const tmp = `${path(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, path(dir));
  return { ok: true, value: valueOf(loadConfig(dir), key) };
}
