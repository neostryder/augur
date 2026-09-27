// What the UI needs from the app it runs inside. The desktop shell (Tauri) and the PWA
// each implement this; the UI never talks to Tauri or the browser directly.

import type { AppConfig, Host, Snapshot } from './types.js';

export interface TrayUpdate {
  /** PNG of the tray icon at the requested size, base64 without a data: prefix. */
  pngBase64?: string;
  tooltip?: string;
  /** Short text shown beside the menu-bar icon on macOS, such as "69%". Ignored elsewhere. */
  title?: string;
}

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

export interface Shell {
  kind: 'desktop' | 'pwa';
  host: Host;

  loadConfig(): Promise<AppConfig | null>;
  saveConfig(config: AppConfig): Promise<void>;

  /** Secret values the user enters in setup; stored in the OS keychain on desktop. */
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  hasSecret(name: string): Promise<boolean>;

  loadSnapshot(): Promise<Snapshot | null>;
  saveSnapshot(snapshot: Snapshot): Promise<void>;
  /** History rows as plain JSON objects, oldest first. */
  loadHistory(): Promise<Record<string, unknown>[]>;
  saveHistory(rows: Record<string, unknown>[]): Promise<void>;
  loadAlertState(): Promise<Record<string, unknown>>;
  saveAlertState(state: Record<string, unknown>): Promise<void>;
  /** Writes the snapshot where other local tools can read it. Desktop only. */
  exportSnapshot?(homeRelativePath: string, json: string): Promise<void>;

  notify(title: string, body: string): Promise<void>;
  openUrl(url: string): Promise<void>;

  /** Pixel size the tray wants for its icon at the current display scale. Desktop only. */
  trayIconSize?(): Promise<number>;
  setTray?(update: TrayUpdate): Promise<void>;
  /** Content height in CSS pixels; the shell clamps it to the screen and re-anchors. */
  setPopupHeight?(cssPixels: number): Promise<void>;
  /** Width and height in CSS pixels, for switching between one and two columns. */
  setPopupSize?(cssWidth: number, cssHeight: number): Promise<void>;
  /** Usable screen height in CSS pixels for the monitor the popup opens on. */
  maxPopupHeight?(): Promise<number>;
  hidePopup?(): Promise<void>;
  getAutostart?(): Promise<boolean>;
  setAutostart?(on: boolean): Promise<void>;
  /** Desktop only: the global shortcut that opens and closes the panel. Null turns it off; rejects if it cannot be registered. */
  setHotkey?(accelerator: string | null): Promise<void>;
  /** Opens a window to sign in to a site that webSession reads. */
  openSignIn?(site: string): Promise<void>;
  /** The running app's version. */
  appVersion?(): Promise<string>;
  /** Looks for a newer release; null means this is the latest. */
  checkUpdate?(): Promise<UpdateInfo | null>;
  /** Downloads and installs the newer release, then restarts the app. */
  installUpdate?(): Promise<void>;

  /**
   * Fires when the popup is shown, when the tray menu asks for a refresh or for settings, and when a
   * sign-in window first shows a signed-in account page.
   */
  on(event: 'popup-shown' | 'refresh-requested' | 'settings-requested' | 'web-session-ready', handler: () => void): () => void;
}
