// Reading and changing the service's config.json one setting at a time, for `augur config`. Each setting has a type and a range, and a value that the
// loader would silently replace with its default is refused here instead, so a typo never looks like it worked.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ADAPTERS } from './adapters/index.js';
import { DEFAULT_CONFIG, loadConfig } from './config.js';
import type { ServiceConfig } from './config.js';

export interface ConfigKey {
  key: string;
  label: string;
  help: string;
  kind: 'number' | 'bool' | 'choice' | 'list';
  choices?: string[];
  min?: number;
  max?: number;
  /** A setting that lowers what the service checks. The app never changes it; a person does, with the command or by editing the file. */
  weakens?: boolean;
}

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: 'retentionDays', label: 'Keep finished jobs', help: "Logs and results stay on disk this many days after a job ends, 30 by default. The job's record stays.", kind: 'number', min: 0, max: 3650 },
  { key: 'persistPrompts', label: 'Keep prompts', help: "Saves each job's prompt in its folder. Off by default, so a prompt is deleted as soon as the job starts.", kind: 'bool' },
  { key: 'maxConcurrent', label: 'Jobs at once', help: 'How many jobs run together while the rest wait. 8 by default.', kind: 'number', min: 1, max: 64 },
  { key: 'maxDepth', label: 'Nesting depth', help: 'How many levels deep jobs may start jobs of their own. 2 by default.', kind: 'number', min: 0, max: 8 },
  { key: 'maxDescendants', label: 'Jobs one job can start', help: 'The most that one job, and the jobs it starts, can add up to. 16 by default.', kind: 'number', min: 0, max: 256 },
  { key: 'decision.backend', label: 'Task classifier', help: 'Answers the questions behind augur pick --task. Laya runs on your own machines, Jev is a hosted service that uses your key, and none turns it off.', kind: 'choice', choices: ['none', 'laya', 'jev'] },
  { key: 'decision.shadow', label: 'Compare with', help: 'Asks a second classifier the same questions and logs how it differs. Its answers are never used.', kind: 'choice', choices: ['none', 'laya', 'jev'] },
  { key: 'learn.recordTasks', label: 'Keep task text', help: 'Saves the text of each pick request, when its data tier allows, for training a classifier. Off by default.', kind: 'bool' },
  { key: 'adapters', label: 'Adapters', help: 'The adapters a route may use, separated by commas. codex-exec by default. The exec adapter runs any command a route names.', kind: 'list', choices: ALL_ADAPTERS.map(a => a.id) },
  { key: 'requirePick', label: 'Require a pick', help: 'Refuses a job unless its model was picked for the caller in the last hour. On by default.', kind: 'bool', weakens: true },
  { key: 'verifyNamed', label: 'Named-model claims', help: 'What happens when a caller says a person named the model. Off takes their word, record notes when it cannot be confirmed, and enforce refuses the job.', kind: 'choice', choices: ['off', 'record', 'enforce'], weakens: true },
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
    case 'learn.recordTasks': return String(config.learn.recordTasks);
    case 'adapters': return config.adapters.join(',');
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
