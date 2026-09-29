import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  /** Seconds after which a runner with no heartbeat counts as gone. */
  runnerStaleS: number;
}

export const DEFAULT_CONFIG: ServiceConfig = { retentionDays: 30, persistPrompts: false, maxConcurrent: 8, maxDepth: 2, maxDescendants: 16,
  jobhostPath: null, adapters: ['codex-exec'], runnerStaleS: 20 };

const num = (v: unknown, d: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d;

export function loadConfig(dir: string): ServiceConfig {
  const path = join(dir, 'config.json');
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) { try { raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { raw = {}; } }
  const c = DEFAULT_CONFIG;
  return {
    retentionDays: num(raw.retentionDays, c.retentionDays, 0, 3650), persistPrompts: raw.persistPrompts === true,
    maxConcurrent: num(raw.maxConcurrent, c.maxConcurrent, 1, 64), maxDepth: num(raw.maxDepth, c.maxDepth, 0, 8),
    maxDescendants: num(raw.maxDescendants, c.maxDescendants, 0, 256),
    jobhostPath: typeof raw.jobhostPath === 'string' ? raw.jobhostPath : null,
    adapters: Array.isArray(raw.adapters) ? raw.adapters.filter((a): a is string => typeof a === 'string') : c.adapters,
    runnerStaleS: num(raw.runnerStaleS, c.runnerStaleS, 5, 600),
  };
}
