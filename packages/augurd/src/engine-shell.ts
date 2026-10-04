// Everything the usage engine needs from the computer, built from Node for the background service. It keeps the window app's files where the
// window app keeps them, so moving the engine into the service carries every setting, reading and alert over unchanged.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { compareVersions } from '@augur/core';
import type { AlertFeed, AppConfig, EngineShell, Host, HttpRequest, HttpResponse, ModelCatalog, Platform, Snapshot, UpdateInfo } from '@augur/core';
import { claudeInstall, claudeRemove, claudeStatus, defaultClaudePaths, type ClaudePaths } from './claude-install.js';
import { atomicWrite, readText, resolveHomePath } from './home-files.js';
import { createKeyStore, runHelper, type KeyStore } from './keystore.js';
import { appDirs } from './paths.js';
import type { ViewHub } from './views.js';

const execute = promisify(execFile);
const LATEST_URL = 'https://github.com/neostryder/augur/releases/latest/download/latest.json';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const BWS_TTL_MS = 10 * 60 * 1000;

declare const __AUGUR_VERSION__: string | undefined;
export const SERVICE_VERSION = typeof __AUGUR_VERSION__ === 'string' ? __AUGUR_VERSION__ : '0.0.0-dev';

/** The push services a phone's browser hands out: Chrome and Android, Safari on iPhone and Mac, Firefox, and Edge. */
export function isPushService(host: string): boolean {
  return host === 'fcm.googleapis.com' || host === 'web.push.apple.com' || host.endsWith('.push.apple.com')
    || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
}

/** HTTPS only, and a redirect is followed only to another HTTPS address. */
export async function httpsRequest(req: HttpRequest, defaultTimeoutMs = 30000): Promise<HttpResponse> {
  let url = new URL(req.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(req.timeoutMs ?? defaultTimeoutMs, 1), 300000));
  try {
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:') throw new Error('HTTPS is required');
      const res = await fetch(url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, redirect: 'manual', signal: controller.signal });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && hop < 10) { url = new URL(location, url); continue; }
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() };
    }
  } catch (e) {
    throw new Error((e as Error).message === 'HTTPS is required' ? 'HTTPS is required' : 'HTTP request failed');
  } finally { clearTimeout(timer); }
}

/** Finds an allowed program on PATH, with the places Windows installers put them when PATH lacks them. */
function program(command: 'grok' | 'bws' | 'gh'): string {
  if (process.platform !== 'win32') return command;
  const fallback = { grok: join(homedir(), '.grok', 'bin', 'grok.exe'), bws: join(homedir(), '.local', 'bin', 'bws.exe'), gh: 'C:/Program Files/GitHub CLI/gh.exe' }[command];
  const onPath = (process.env.PATH ?? '').split(';').some(d => d && existsSync(join(d, `${command}.exe`)));
  return onPath || !existsSync(fallback) ? command : fallback;
}

const isUuid = (s: string | undefined) => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export interface EngineShellOptions {
  views: ViewHub;
  env?: NodeJS.ProcessEnv;
  dirs?: { config: string; data: string };
  keys?: KeyStore;
  /** The Claude install paths; the default looks beside this file. */
  claude?: (appExe: string) => ClaudePaths;
  version?: string;
  log?: (message: string) => void;
}

export interface NodeEngineShell extends EngineShell { kind: 'desktop'; keys: KeyStore; dirs: { config: string; data: string } }

export function createEngineShell(opts: EngineShellOptions): NodeEngineShell {
  const env = opts.env ?? process.env, dirs = opts.dirs ?? appDirs(env), home = homedir();
  const keys = opts.keys ?? createKeyStore({ dir: dirs.config });
  const views = opts.views, log = opts.log ?? (() => {});
  const claudePaths = () => (opts.claude ?? (exe => defaultClaudePaths(import.meta.url, exe, env)))(views.appExe());
  const file = (name: string) => join(dirs.config, name);
  const loadJson = async <T>(name: string): Promise<T | null> => { const t = readText(file(name)); return t === null ? null : JSON.parse(t) as T; };
  const saveJson = async (name: string, value: unknown) => atomicWrite(file(name), JSON.stringify(value));
  const exportPath = async () => ((await loadJson<AppConfig>('config.json'))?.exportPath ?? null);
  const platform: Platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';

  let bwsCache: { at: number; project: string; values: Record<string, string> } | null = null;
  const bwsSecret = async (name: string): Promise<string | null> => {
    const source = (await loadJson<AppConfig>('config.json'))?.secretSources?.bws, key = source?.map[name];
    if (!source || !key || !isUuid(source.projectId)) return null;
    if (!bwsCache || bwsCache.project !== source.projectId || Date.now() - bwsCache.at > BWS_TTL_MS) {
      const out = await host.run!('bws', ['secret', 'list', source.projectId, '-o', 'json'], 30000);
      const values: Record<string, string> = {};
      for (const item of JSON.parse(out.stdout) as Array<{ key: string; value: string }>) values[item.key] = item.value;
      bwsCache = { at: Date.now(), project: source.projectId, values };
    }
    return bwsCache.values[key] ?? null;
  };

  const host: Host = {
    platform,
    http: req => httpsRequest(req),
    secret: async name => (await keys.get(name).catch(() => null)) ?? bwsSecret(name).catch(() => null),
    readHomeFile: async path => readText(resolveHomePath(home, path, await exportPath())),
    writeHomeFileAtomic: async (path, text) => atomicWrite(resolveHomePath(home, path, await exportPath()), text),
    async run(command, args, timeoutMs = 30000) {
      const allowed = (command === 'grok' && args.length === 1 && args[0] === 'models')
        || (command === 'bws' && args.length === 5 && args[0] === 'secret' && args[1] === 'list' && isUuid(args[2]) && args[3] === '-o' && args[4] === 'json');
      if (!allowed) throw new Error('Command and arguments are not allowed');
      try {
        const r = await execute(program(command as 'grok' | 'bws'), args, { timeout: Math.min(Math.max(timeoutMs, 1), 300000), windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
        return { code: 0, stdout: r.stdout, stderr: r.stderr };
      } catch (e) {
        const x = e as { code?: unknown; stdout?: string; stderr?: string };
        if (typeof x.code !== 'number') throw new Error('Allowed command is unavailable');
        return { code: x.code, stdout: x.stdout ?? '', stderr: x.stderr ?? '' };
      }
    },
    async keychainGet(service, account = userInfo().username) {
      if (service !== CLAUDE_KEYCHAIN_SERVICE) throw new Error('Keychain item is not allowed');
      if (platform !== 'macos') return null;
      const r = await runHelper('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
      return r.code === 0 ? r.stdout.replace(/\n$/, '') || null : null;
    },
    async keychainSet(service, account, value) {
      if (service !== CLAUDE_KEYCHAIN_SERVICE) throw new Error('Keychain item is not allowed');
      if (platform !== 'macos' || /[\r\n]/.test(value)) throw new Error('Keychain unavailable');
      const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const r = await runHelper('security', ['-i'], `add-generic-password -U -s ${q(service)} -a ${q(account || userInfo().username)} -w ${q(value)}\n`);
      if (r.code !== 0 || /error|SecKeychain/i.test(r.stderr)) throw new Error('The keychain item could not be saved');
    },
    async copilotUsage() {
      const notSignedIn = 'Not signed in. Run gh auth login on this computer.';
      const r = await runHelper(program('gh'), ['auth', 'token']);
      const token = r.stdout.trim();
      if (r.code !== 0 || !token) throw new Error(notSignedIn);
      return httpsRequest({ url: 'https://api.github.com/copilot_internal/user', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'augur' }, timeoutMs: 20000 });
    },
    // Provider pages behind a browser sign-in are read by a connected window app; with none connected, those readings are left out.
    async webSession(site, options) {
      if (!views.provider('websession')) return null;
      return (await views.request('websession', 'webSession', { site, fresh: options?.fresh === true }, 90000)) as Record<string, unknown> | null;
    },
    now: () => new Date(),
    env: name => env[name] ?? null,
    log,
  };

  return {
    kind: 'desktop', keys, dirs, host,
    loadConfig: () => loadJson<AppConfig>('config.json'),
    saveConfig: config => saveJson('config.json', config),
    setSecret: (name, value) => keys.set(name, value),
    deleteSecret: name => keys.delete(name),
    hasSecret: async name => (await keys.has(name).catch(() => false)) || (await bwsSecret(name).catch(() => null)) !== null,
    loadSnapshot: () => loadJson<Snapshot>('snapshot.json'),
    saveSnapshot: snapshot => saveJson('snapshot.json', snapshot),
    async loadHistory() {
      const text = readText(join(dirs.data, 'history.jsonl'));
      return text?.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) ?? [];
    },
    async saveHistory(rows) { atomicWrite(join(dirs.data, 'history.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); },
    loadAlertState: async () => (await loadJson<Record<string, unknown>>('alert-state.json')) ?? {},
    saveAlertState: state => saveJson('alert-state.json', state),
    loadModelCatalog: () => loadJson<ModelCatalog>('model-catalog.json'),
    saveModelCatalog: catalog => saveJson('model-catalog.json', catalog),
    loadAlertFeed: () => loadJson<AlertFeed>('alert-feed.json'),
    saveAlertFeed: feed => saveJson('alert-feed.json', feed),
    async sendWebPush(endpoint, headers, body) {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' || !isPushService(url.hostname)) throw new Error('Not a push service address');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try { return (await fetch(url, { method: 'POST', headers, body: Buffer.from(body), redirect: 'manual', signal: controller.signal })).status; }
      catch { throw new Error('Push request failed'); }
      finally { clearTimeout(timer); }
    },
    exportSnapshot: (path, json) => host.writeHomeFileAtomic!(path, json),
    async notify(title, body) {
      if (views.provider('notify')) { await views.request('notify', 'notify', { title, body }, 15000).catch(() => undefined); return; }
      await desktopNotice(title, body);
    },
    claudeStatus: async () => claudeStatus(claudePaths()),
    claudeInstall: async (target, path) => claudeInstall(claudePaths(), target, path),
    claudeRemove: async target => claudeRemove(claudePaths(), target),
    appVersion: async () => opts.version ?? SERVICE_VERSION,
    async checkUpdate(): Promise<UpdateInfo | null> {
      const res = await httpsRequest({ url: LATEST_URL, headers: { Accept: 'application/json', 'User-Agent': 'augur' }, timeoutMs: 20000 });
      if (res.status !== 200) throw new Error(`The release list answered ${res.status}`);
      const latest = JSON.parse(res.body) as { version?: string; notes?: string; pub_date?: string };
      const version = String(latest.version ?? '').replace(/^v/, '');
      if (!version || compareVersions(version, opts.version ?? SERVICE_VERSION) <= 0) return null;
      return { version, ...(latest.notes ? { notes: latest.notes } : {}), ...(latest.pub_date ? { date: latest.pub_date } : {}) };
    },
  };
}

/** A desktop notice with no window app to show it: notify-send on Linux, Notification Center through osascript on macOS. Nothing on Windows. */
export async function desktopNotice(title: string, body: string): Promise<void> {
  if (process.platform === 'linux') await runHelper('notify-send', ['--app-name=Augur', title, body], undefined, 5000);
  else if (process.platform === 'darwin') {
    const s = (t: string) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    await runHelper('osascript', ['-e', `display notification ${s(body)} with title ${s(title)}`], undefined, 5000);
  }
}
