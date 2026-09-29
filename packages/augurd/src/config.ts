import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LearnSettings } from './decisions.js';

export interface DecisionSettings {
  /** Who answers the typed questions behind `augur pick --task`: Laya servers, Jev with the person's own key, or nobody. */
  backend: 'laya' | 'jev' | 'none';
  servers?: Array<{ name: string; url: string }>;
  /** A second backend asked the same questions and only compared with the first. */
  shadow?: 'laya' | 'jev' | null;
}

export interface ServiceConfig {
  /** Days a finished job's folder (logs and results) is kept. Job records stay. */
  retentionDays: number;
  /** Keep the prompt of each job in its folder. Off by default. */
  persistPrompts: boolean;
  maxConcurrent: number;
  maxDepth: number;
  maxDescendants: number;
  /** Path of the Job Object launcher. Windows uses it to contain every process a job starts. */
  jobhostPath: string | null;
  /** Adapters that may be used. The generic `exec` adapter runs any command a route names, so it is off unless listed here. */
  adapters: string[];
  /** Refuse a job whose model was not picked for its caller within the last hour, unless the caller says the person named it. */
  requirePick: boolean;
  /** Folders besides a job's own working folder that a prompt file may come from. */
  promptRoots: string[];
  /** What to do with a caller's claim that a person named the model: `off` takes it as true, `record` takes it and notes when it cannot be confirmed, `enforce` refuses the job. */
  verifyNamed: 'off' | 'record' | 'enforce';
  decision: DecisionSettings;
  learn: LearnSettings;
  /** Seconds after which a runner with no heartbeat counts as gone. */
  runnerStaleS: number;
}

export const DEFAULT_CONFIG: ServiceConfig = { retentionDays: 30, persistPrompts: false, maxConcurrent: 8, maxDepth: 2, maxDescendants: 16,
  jobhostPath: null, adapters: ['codex-exec'], requirePick: true, promptRoots: [], verifyNamed: 'enforce', decision: { backend: 'none' }, learn: { recordTasks: false }, runnerStaleS: 20 };

/** The launcher built by `pnpm build:jobhost` sits beside the package's sources, and a packaged install places it next to the service. */
export function defaultJobhost(): string | null {
  if (process.platform !== 'win32') return null;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '..', 'native', 'bin', 'jobhost.exe'), join(here, 'jobhost.exe')]) if (existsSync(p)) return p;
  return null;
}

const num = (v: unknown, d: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d;

function decisionSettings(v: unknown): DecisionSettings {
  const d = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const kind = (x: unknown) => (x === 'laya' || x === 'jev' ? x : null);
  const servers = Array.isArray(d.servers) ? d.servers.filter((s): s is { name: string; url: string } => typeof s?.name === 'string' && typeof s?.url === 'string') : undefined;
  return { backend: kind(d.backend) ?? 'none', ...(servers?.length ? { servers } : {}), shadow: kind(d.shadow) };
}

export function loadConfig(dir: string): ServiceConfig {
  const path = join(dir, 'config.json');
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) { try { raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { raw = {}; } }
  const c = DEFAULT_CONFIG;
  return {
    retentionDays: num(raw.retentionDays, c.retentionDays, 0, 3650), persistPrompts: raw.persistPrompts === true,
    maxConcurrent: num(raw.maxConcurrent, c.maxConcurrent, 1, 64), maxDepth: num(raw.maxDepth, c.maxDepth, 0, 8),
    maxDescendants: num(raw.maxDescendants, c.maxDescendants, 0, 256),
    jobhostPath: typeof raw.jobhostPath === 'string' ? raw.jobhostPath : defaultJobhost(),
    adapters: Array.isArray(raw.adapters) ? raw.adapters.filter((a): a is string => typeof a === 'string') : c.adapters,
    requirePick: raw.requirePick !== false, promptRoots: Array.isArray(raw.promptRoots) ? raw.promptRoots.filter((r): r is string => typeof r === 'string') : c.promptRoots,
    verifyNamed: raw.verifyNamed === 'off' || raw.verifyNamed === 'record' || raw.verifyNamed === 'enforce' ? raw.verifyNamed : c.verifyNamed,
    decision: decisionSettings(raw.decision),
    learn: { recordTasks: (raw.learn as { recordTasks?: unknown } | undefined)?.recordTasks === true },
    runnerStaleS: num(raw.runnerStaleS, c.runnerStaleS, 5, 600),
  };
}
