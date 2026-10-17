import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { LearnSettings } from './decisions.js';

export interface DecisionSettings {
  /** Who answers the typed questions behind `augur pick --task`: Laya servers, Jev with the person's own key, or nobody. */
  backend: 'laya' | 'jev' | 'none';
  servers?: Array<{ name: string; url: string }>;
  /** A second backend asked the same questions and only compared with the first. */
  shadow?: 'laya' | 'jev' | null;
  /** Address of a Jev gateway for the Jev backend to ask in place of TypeSafe. Empty means ask TypeSafe with the person's own key. */
  gateway?: string;
}

export interface RunnerSettings {
  /** Folder of charter files. Empty uses the charter folder in the Augur home when that folder exists. */
  charterDir: string;
  /** `keep` leaves each harness's ambient context on. `trim` turns it off where the harness has a switch. */
  ambient: 'keep' | 'trim';
  /** `off` leaves a job that failed after it started. `on` retries it on the route's fallback list when the failure can be retried. */
  failover: 'off' | 'on';
}

export interface WebSettings {
  /** Serve the web app from the service. Off by default: nothing listens on the network until the owner turns it on. */
  enabled: boolean;
  /** The address to listen on. Loopback by default, so only this computer can connect; 0.0.0.0 or a LAN address opens it to the network. */
  host: string;
  port: number;
  /** Host names besides this computer's own that a request may use, for a name that points here (a DNS name or a tunnel). */
  allowedHosts: string[];
  /** A certificate and key (PEM files) to serve HTTPS with. Without them the web app is plain HTTP. */
  tlsCert: string;
  tlsKey: string;
  /** Make and keep a self-signed certificate in the service's data folder and serve HTTPS with it. Ignored when tlsCert and tlsKey are set. */
  tlsAuto: boolean;
}

export interface ServiceConfig {
  /** Days a finished job's folder (logs and results) is kept. Job records stay. */
  retentionDays: number;
  /** Keep the prompt of each job in its folder. Off by default. */
  persistPrompts: boolean;
  /** Charter folder and whether a harness's own instructions stay on. */
  runner: RunnerSettings;
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
  /** Run the usage engine (provider readings, alerts, phone sync) in the service. The window app and the terminal app show it. AUGURD_ENGINE=0 or 1 overrides it for one start. */
  engine: boolean;
  web: WebSettings;
}

export const DEFAULT_CONFIG: ServiceConfig = { retentionDays: 30, persistPrompts: false, maxConcurrent: 8, maxDepth: 2, maxDescendants: 16,
  jobhostPath: null, adapters: ['codex-exec'], requirePick: true, promptRoots: [], verifyNamed: 'enforce', decision: { backend: 'none' }, learn: { recordTasks: false }, runnerStaleS: 20, engine: true,
  web: { enabled: false, host: '127.0.0.1', port: 7420, allowedHosts: [], tlsCert: '', tlsKey: '', tlsAuto: false },
  runner: { charterDir: '', ambient: 'keep', failover: 'off' } };

/** The launcher built by `pnpm build:jobhost` sits beside the package's sources, and a packaged install places it next to the service. */
export function defaultJobhost(): string | null {
  if (process.platform !== 'win32') return null;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '..', 'native', 'bin', 'jobhost.exe'), join(here, 'jobhost.exe')]) if (existsSync(p)) return p;
  return null;
}

const num = (v: unknown, d: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d;

function runnerSettings(v: unknown): RunnerSettings {
  const d = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    charterDir: typeof d.charterDir === 'string' ? d.charterDir.trim() : '',
    ambient: d.ambient === 'trim' ? 'trim' : 'keep',
    failover: d.failover === 'on' ? 'on' : 'off',
  };
}

/** A gateway address is an http or https URL with a host. The loader and the settings editor share this. */
export function gatewayAddress(v: string): boolean {
  try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch { return false; }
}

function decisionSettings(v: unknown): DecisionSettings {
  const d = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const kind = (x: unknown) => (x === 'laya' || x === 'jev' ? x : null);
  const servers = Array.isArray(d.servers) ? d.servers.filter((s): s is { name: string; url: string } => typeof s?.name === 'string' && typeof s?.url === 'string') : undefined;
  const gateway = typeof d.gateway === 'string' ? d.gateway.trim() : '';
  return { backend: kind(d.backend) ?? 'none', ...(servers?.length ? { servers } : {}), shadow: kind(d.shadow), ...(gatewayAddress(gateway) ? { gateway } : {}) };
}

/** A bind address: an IP literal, or a plain host name. The loader and the settings editor share this, so a typo is refused instead of silently replaced. */
export function plainHost(v: string): boolean {
  return isIP(v) !== 0 || /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(v);
}

function webSettings(v: unknown): WebSettings {
  const d = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>, c = DEFAULT_CONFIG.web;
  const names = (x: unknown) => (Array.isArray(x) ? x : typeof x === 'string' ? x.split(',') : []).map(h => String(h).trim().toLowerCase()).filter(h => h && plainHost(h));
  return {
    enabled: d.enabled === true,
    host: typeof d.host === 'string' && plainHost(d.host.trim()) ? d.host.trim() : c.host,
    port: num(d.port, c.port, 1024, 65535),
    allowedHosts: names(d.allowedHosts),
    tlsCert: typeof d.tlsCert === 'string' ? d.tlsCert.trim() : '',
    tlsKey: typeof d.tlsKey === 'string' ? d.tlsKey.trim() : '',
    tlsAuto: d.tlsAuto === true,
  };
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
    runner: runnerSettings(raw.runner),
    learn: { recordTasks: (raw.learn as { recordTasks?: unknown } | undefined)?.recordTasks === true },
    runnerStaleS: num(raw.runnerStaleS, c.runnerStaleS, 5, 600),
    engine: typeof raw.engine === 'boolean' ? raw.engine : c.engine,
    web: webSettings(raw.web),
  };
}
