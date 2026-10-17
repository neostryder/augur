// The gateway's settings: one JSON file, read again whenever it changes, so a model or a limit is one edit and no restart.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_TIERS } from '@augur/core';
import type { DataTier } from '@augur/core';
import type { Server } from '@augur/decision';

export interface KeySource {
  /** Environment variables tried in order. Defaults to TYPESAFE_API_KEY, then JEV_API_KEY. */
  env?: string[];
  /** A file whose whole content is the key. */
  file?: string;
  /** A command (program, then arguments) whose output is the key. */
  command?: string[];
}

export interface GatewayConfig {
  /** Where the listener binds. Loopback unless the setting says otherwise, and any other address requires consumer tokens. */
  host: string;
  port: number;
  /** The model alias sent upstream for every hosted request. */
  model: string;
  /** Exact model ids a caller may name itself, such as a versioned id behind a calibrated threshold. Anything else is replaced by `model`. */
  pins: string[];
  /** The hosted System One endpoint. */
  endpoint: string;
  /** The tier of a request that names none. Hosted calls are allowed for public and internal only. */
  defaultTier: DataTier;
  /** Consumer name to the SHA-256 (hex) of its token. */
  consumers: Record<string, string>;
  /** Extra words that mark a request as student data when it names no tier, such as the name of a school or a course code. `private-terms.json` in the Augur folder adds more. */
  contentTerms: string[];
  /** With this off, a loopback caller needs no token. */
  requireToken: boolean;
  /** Laya servers tried in order for local-only requests and for a request that names a laya model. */
  laya: Server[];
  /** The model sent to Laya when a local-only request names none. */
  layaModel: string;
  key: KeySource;
  /** Where the usage rows go. One JSON line per request and never any request text. */
  usageLog: string;
  /** Hosted retries on 429, 529 and 5xx, after the first try. */
  retries: number;
  timeoutMs: number;
  maxBodyMb: number;
}

/** A request in one of these tiers may go to the hosted model. */
export const HOSTED_TIERS: readonly DataTier[] = ['public', 'internal'];

export const augurHome = (env: NodeJS.ProcessEnv = process.env): string => env.AUGUR_HOME ?? join(homedir(), '.augur');
export const configPath = (env: NodeJS.ProcessEnv = process.env): string => env.JEV_GATEWAY_CONFIG ?? join(augurHome(env), 'jev-gateway.json');

export function defaults(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return { host: '127.0.0.1', port: 8020, model: 'jev-preview', pins: [], endpoint: 'https://api.typesafe.ai/v1/systemone', defaultTier: 'internal',
    consumers: {}, contentTerms: [], requireToken: false, laya: [{ name: 'local', url: 'http://127.0.0.1:8010' }], layaModel: 'laya', key: {},
    usageLog: join(augurHome(env), 'jev-gateway-usage.jsonl'), retries: 2, timeoutMs: 60000, maxBodyMb: 32 };
}

export const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\./.test(host);
const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const strs = (v: unknown): string[] | undefined => Array.isArray(v) && v.every(x => typeof x === 'string' && x) ? v as string[] : undefined;

/** Reads a settings object over the defaults. A value of the wrong shape keeps the default, and the problems come back so a caller can log them. */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): { config: GatewayConfig; problems: string[] } {
  const d = defaults(env), problems: string[] = [], r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const c: GatewayConfig = { ...d };
  const take = <K extends keyof GatewayConfig>(k: K, v: GatewayConfig[K] | undefined, why: string) => { if (r[k] === undefined) return; if (v === undefined) problems.push(`${k}: ${why}`); else c[k] = v; };
  take('host', str(r.host), 'expected an address');
  take('port', Number.isInteger(r.port) && (r.port as number) >= 0 && (r.port as number) < 65536 ? r.port as number : undefined, 'expected a port number');
  take('model', str(r.model), 'expected a model alias');
  take('pins', strs(r.pins), 'expected a list of model ids');
  take('endpoint', typeof r.endpoint === 'string' && /^https:\/\//.test(r.endpoint) ? r.endpoint.replace(/\/+$/, '') : undefined, 'the endpoint must start with https://');
  take('defaultTier', (DATA_TIERS as readonly unknown[]).includes(r.defaultTier) ? r.defaultTier as DataTier : undefined, `expected one of ${DATA_TIERS.join(', ')}`);
  if (r.consumers !== undefined) {
    const o = r.consumers;
    if (o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))) c.consumers = o as Record<string, string>;
    else problems.push('consumers: expected names mapped to the SHA-256 of a token');
  }
  take('contentTerms', strs(r.contentTerms), 'expected a list of words');
  take('requireToken', typeof r.requireToken === 'boolean' ? r.requireToken : undefined, 'expected true or false');
  if (r.laya !== undefined) {
    const l = r.laya;
    if (Array.isArray(l) && l.every(s => s && typeof s === 'object' && typeof (s as Server).name === 'string' && /^https?:\/\//.test(String((s as Server).url)))) c.laya = l as Server[];
    else problems.push('laya: expected a list of { name, url }');
  }
  take('layaModel', str(r.layaModel), 'expected a model name');
  if (r.key !== undefined) {
    const k = r.key as Record<string, unknown>;
    if (k && typeof k === 'object' && !Array.isArray(k)) c.key = { ...(strs(k.env) ? { env: strs(k.env) as string[] } : {}), ...(str(k.file) ? { file: str(k.file) as string } : {}), ...(strs(k.command) ? { command: strs(k.command) as string[] } : {}) };
    else problems.push('key: expected { env, file, command }');
  }
  take('usageLog', str(r.usageLog), 'expected a path');
  take('retries', Number.isInteger(r.retries) && (r.retries as number) >= 0 && (r.retries as number) <= 5 ? r.retries as number : undefined, 'expected 0 to 5');
  take('timeoutMs', typeof r.timeoutMs === 'number' && r.timeoutMs >= 1000 && r.timeoutMs <= 600000 ? r.timeoutMs : undefined, 'expected 1000 to 600000');
  take('maxBodyMb', typeof r.maxBodyMb === 'number' && r.maxBodyMb > 0 && r.maxBodyMb <= 32 ? r.maxBodyMb : undefined, 'expected a number up to 32');
  // Off this computer the listener needs tokens, whatever the file says.
  if (!isLoopback(c.host)) {
    if (!c.requireToken) problems.push('requireToken: a listener on a non-loopback address always requires a token');
    c.requireToken = true;
  }
  if (c.requireToken && !Object.keys(c.consumers).length) problems.push('consumers: tokens are required and none is set, so every request will be refused');
  return { config: c, problems };
}

/** The settings file, re-read when its modified time changes. A missing file yields the defaults, and a broken one keeps the last good settings. `onProblems` hears each re-read that found any, so an edit that breaks the file after startup is not silent. */
export class ConfigFile {
  private seen = -1;
  private cached: { config: GatewayConfig; problems: string[] };
  constructor(private path: string = configPath(), private env: NodeJS.ProcessEnv = process.env, private onProblems?: (problems: string[]) => void) { this.cached = parseConfig({}, env); }
  get(): { config: GatewayConfig; problems: string[] } {
    let m = 0;
    try { m = existsSync(this.path) ? statSync(this.path).mtimeMs : 0; } catch { return this.cached; }
    if (m === this.seen) return this.cached;
    this.seen = m;
    if (!m) { this.cached = parseConfig({}, this.env); return this.cached; }
    try { this.cached = parseConfig(JSON.parse(readFileSync(this.path, 'utf8')), this.env); }
    catch (e) { this.cached = { config: this.cached.config, problems: [`the settings file is not valid JSON (${(e as Error).message}); the last good settings stay in use`] }; }
    if (this.cached.problems.length) { try { this.onProblems?.(this.cached.problems); } catch { /* a logging failure must not stop a request */ } }
    return this.cached;
  }
}
