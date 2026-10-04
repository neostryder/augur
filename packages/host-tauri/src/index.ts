import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import type { Host, Platform, Shell, TrayUpdate, UpdateInfo } from '@augur/core';

let pendingUpdate: Update | null = null;
let engineListener: Promise<() => void> | null = null;

function platform(): Platform {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('macintosh') || agent.includes('mac os')) return 'macos';
  return 'linux';
}

let notificationPermission: Promise<boolean> | undefined;

// The usage engine, with its settings, keys and readings, runs in the background service. The window app reaches it through engineLink, so these
// parts of the shell are never called here.
const serviceOnly = (): Promise<never> => Promise.reject(new Error('The Augur service handles this, not the window app.'));

export function createTauriShell(): Shell {
  const host: Host = {
    platform: platform(),
    webSession: (site: string, options?: { fresh?: boolean }) => invoke<Record<string, unknown> | null>('web_session_read', { site, fresh: options?.fresh === true }),
    http: serviceOnly,
    secret: serviceOnly,
    readHomeFile: (path: string) => invoke<string | null>('read_home_file', { path }),
    writeHomeFileAtomic: (path: string, text: string) => invoke<void>('write_home_file_atomic', { path, text }),
    now: () => new Date(),
  };

  return {
    kind: 'desktop',
    host,
    loadConfig: serviceOnly,
    saveConfig: serviceOnly,
    setSecret: serviceOnly,
    deleteSecret: serviceOnly,
    hasSecret: serviceOnly,
    loadSnapshot: serviceOnly,
    saveSnapshot: serviceOnly,
    loadHistory: serviceOnly,
    saveHistory: serviceOnly,
    loadAlertState: serviceOnly,
    saveAlertState: serviceOnly,
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
    showPopup: () => invoke<void>('show_popup'),
    popupPinned: () => invoke<boolean>('popup_pinned'),
    setPopupPinned: (pinned: boolean) => invoke<void>('set_popup_pinned', { pinned }),
    startPopupDrag: () => invoke<void>('start_popup_drag'),
    dispatch: (args: string[]) => invoke<{ code: number; stdout: string; stderr: string }>('dispatch_cli', { args }),
    async engineLink(onLine: (line: string) => void) {
      void engineListener?.then((stop) => stop());
      engineListener = listen<string>('engine-line', (e) => onLine(e.payload));
      await engineListener;
      await invoke<void>('engine_start');
      return { send: (line: string) => invoke<void>('engine_send', { line }) };
    },
    getAutostart: () => isEnabled(),
    setAutostart: (on: boolean) => on ? enable() : disable(),
    setHotkey: (accelerator: string | null) => invoke<void>('set_hotkey', { accelerator }),
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
