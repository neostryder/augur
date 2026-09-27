import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import type { AppConfig, Host, HttpRequest, HttpResponse, Platform, Snapshot } from '@augur/core';
import type { Shell, TrayUpdate, UpdateInfo } from '@augur/core';

let pendingUpdate: Update | null = null;

function platform(): Platform {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('macintosh') || agent.includes('mac os')) return 'macos';
  return 'linux';
}

function parseJson<T>(text: string | null): T | null {
  return text === null ? null : JSON.parse(text) as T;
}

let notificationPermission: Promise<boolean> | undefined;

// Secrets missing from the keychain can come from a Bitwarden Secrets Manager project, when the
// config maps them. The list is held in memory for a few minutes and never written anywhere.
let bwsCache: { at: number; project: string; values: Record<string, string> } | null = null;
const BWS_TTL_MS = 10 * 60 * 1000;

async function bwsSecret(name: string): Promise<string | null> {
  const config = parseJson<AppConfig>(await invoke<string | null>('load_json', { kind: 'config' }));
  const source = config?.secretSources?.bws;
  const key = source?.map[name];
  if (!source || !key) return null;
  if (!bwsCache || bwsCache.project !== source.projectId || Date.now() - bwsCache.at > BWS_TTL_MS) {
    const out = await invoke<{ code: number; stdout: string }>('run_command', {
      command: 'bws', args: ['secret', 'list', source.projectId, '-o', 'json'], timeoutMs: 30000,
    });
    if (out.code !== 0) return null;
    const values: Record<string, string> = {};
    for (const item of JSON.parse(out.stdout) as Array<{ key: string; value: string }>) values[item.key] = item.value;
    bwsCache = { at: Date.now(), project: source.projectId, values };
  }
  return bwsCache.values[key] ?? null;
}

export function createTauriShell(): Shell {
  const host: Host = {
    platform: platform(),
    webSession: (site: string) => invoke<Record<string, unknown> | null>('web_session_read', { site }),
    http: (req: HttpRequest): Promise<HttpResponse> => invoke('http_request', {
      url: req.url,
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      body: req.body ?? null,
      timeoutMs: req.timeoutMs ?? null,
    }),
    secret: async (name: string) => (await invoke<string | null>('secret_get', { name })) ?? bwsSecret(name).catch(() => null),
    readHomeFile: (path: string) => invoke<string | null>('read_home_file', { path }),
    writeHomeFileAtomic: (path: string, text: string) => invoke<void>('write_home_file_atomic', { path, text }),
    run: (command: string, args: string[], timeoutMs?: number) => invoke('run_command', { command, args, timeoutMs: timeoutMs ?? null }),
    keychainGet: (service: string, account?: string) => invoke<string | null>('keychain_get', { service, account: account ?? null }),
    keychainSet: (service: string, account: string, value: string) => invoke<void>('keychain_set', { service, account, value }),
    now: () => new Date(),
  };

  const load = (kind: string) => invoke<string | null>('load_json', { kind });
  const save = (kind: string, value: unknown) => invoke<void>('save_json', { kind, text: JSON.stringify(value) });

  return {
    kind: 'desktop',
    host,
    loadConfig: async () => parseJson<AppConfig>(await load('config')),
    saveConfig: (config: AppConfig) => save('config', config),
    setSecret: (name: string, value: string) => invoke<void>('secret_set', { name, value }),
    deleteSecret: (name: string) => invoke<void>('secret_delete', { name }),
    hasSecret: async (name: string) => (await invoke<boolean>('secret_has', { name })) || (await bwsSecret(name).catch(() => null)) !== null,
    loadSnapshot: async () => parseJson<Snapshot>(await load('snapshot')),
    saveSnapshot: (snapshot: Snapshot) => save('snapshot', snapshot),
    loadHistory: async () => {
      const text = await invoke<string | null>('load_history');
      return text?.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) ?? [];
    },
    saveHistory: (rows: Record<string, unknown>[]) => invoke<void>('save_history', {
      text: rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
    }),
    loadAlertState: async () => parseJson<Record<string, unknown>>(await load('alert-state')) ?? {},
    saveAlertState: (state: Record<string, unknown>) => save('alert-state', state),
    exportSnapshot: (homeRelativePath: string, json: string) => invoke<void>('write_home_file_atomic', { path: homeRelativePath, text: json }),
    notify: async (title: string, body: string) => {
      notificationPermission ??= (async () => (await isPermissionGranted()) || (await requestPermission()) === 'granted')();
      if (await notificationPermission) sendNotification({ title, body });
    },
    openUrl: (url: string) => openUrl(url),
    trayIconSize: () => invoke<number>('tray_icon_size'),
    setTray: (update: TrayUpdate) => invoke<void>('set_tray', {
      pngBase64: update.pngBase64 ?? null,
      tooltip: update.tooltip ?? null,
      title: update.title ?? null,
    }),
    setPopupHeight: (cssPixels: number) => invoke<void>('set_popup_height', { cssPx: cssPixels }),
    setPopupSize: (cssWidth: number, cssHeight: number) => invoke<void>('set_popup_size', { cssWidth, cssHeight, dpr: devicePixelRatio }),
    maxPopupHeight: () => invoke<number>('max_popup_height', { dpr: devicePixelRatio }),
    hidePopup: () => invoke<void>('hide_popup'),
    getAutostart: () => isEnabled(),
    setAutostart: (on: boolean) => on ? enable() : disable(),
    appVersion: () => getVersion(),
    openSignIn: (site: string) => invoke<void>('web_session_sign_in', { site }),
    checkUpdate: async (): Promise<UpdateInfo | null> => {
      pendingUpdate = await check();
      return pendingUpdate ? { version: pendingUpdate.version, notes: pendingUpdate.body, date: pendingUpdate.date } : null;
    },
    installUpdate: async () => {
      const update = pendingUpdate ?? await check();
      if (!update) return;
      await update.downloadAndInstall();
      await relaunch();
    },
    on: (event, handler) => {
      let closed = false;
      let unlisten: (() => void) | undefined;
      void listen(event, handler).then(stop => {
        if (closed) stop();
        else unlisten = stop;
      });
      return () => { closed = true; unlisten?.(); };
    },
  };
}
