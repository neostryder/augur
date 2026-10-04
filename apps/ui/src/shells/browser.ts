// Shell for the PWA and for plain-browser development. Keys stay on this device: they are
// encrypted with a non-extractable AES key that never leaves IndexedDB. Provider calls go
// through a stateless relay when one is configured, because most usage APIs do not allow
// cross-origin browser requests.
import { unb64url } from '@augur/core';
import type { AlertFeed, AppConfig, HttpRequest, HttpResponse, ModelCatalog, PushStatus, PushSubscriptionInfo, Shell, Snapshot } from '@augur/core';

const LS = { config: 'augur.config', snapshot: 'augur.snapshot', history: 'augur.history', alerts: 'augur.alerts', relay: 'augur.relay', models: 'augur.models', feed: 'augur.feed' };

function readLS<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}
function writeLS(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('augur', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    if (value === undefined) tx.objectStore('kv').delete(key); else tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let keyPromise: Promise<CryptoKey> | null = null;
function deviceKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const existing = await idbGet<CryptoKey>('device-key');
    if (existing) return existing;
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idbSet('device-key', k);
    return k;
  })();
  return keyPromise;
}

async function seal(text: string): Promise<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), new TextEncoder().encode(text));
  return { iv, data };
}
async function unseal(box: { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, await deviceKey(), box.data);
  return new TextDecoder().decode(plain);
}

// The web app is served by the relay Worker itself, so the page's own address is the relay unless one was entered.
export function relayUrl(): string { return localStorage.getItem(LS.relay) ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '' : location.origin); }
export function setRelayUrl(url: string): void { localStorage.setItem(LS.relay, url.trim()); }

async function http(req: HttpRequest): Promise<HttpResponse> {
  const relay = relayUrl();
  const timeout = AbortSignal.timeout(req.timeoutMs ?? 15000);
  if (relay) {
    const r = await fetch(relay.replace(/\/$/, '') + '/fetch', {
      method: 'POST', signal: timeout, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: req.url, method: req.method ?? 'GET', headers: req.headers ?? {}, body: req.body }),
    });
    if (!r.ok) throw new Error(`Relay answered ${r.status}`);
    return (await r.json()) as HttpResponse;
  }
  try {
    const init: RequestInit = { method: req.method ?? 'GET', signal: timeout };
    if (req.headers) init.headers = req.headers;
    if (req.body !== undefined) init.body = req.body;
    const r = await fetch(req.url, init);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { status: r.status, headers, body: await r.text() };
  } catch {
    throw new Error('The browser blocked this request. Set a relay in settings.');
  }
}

export function createBrowserShell(): Shell {
  const handlers = new Map<string, Set<() => void>>();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handlers.get('popup-shown')?.forEach((h) => h());
  });
  return {
    kind: 'pwa',
    host: {
      platform: 'browser',
      http,
      async secret(name) {
        const box = await idbGet<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }>('secret:' + name);
        return box ? unseal(box) : null;
      },
    },
    async loadConfig() { return readLS<AppConfig>(LS.config); },
    async saveConfig(c) { writeLS(LS.config, c); },
    async setSecret(name, value) { await idbSet('secret:' + name, await seal(value)); },
    async deleteSecret(name) { await idbSet('secret:' + name, undefined); },
    async hasSecret(name) { return (await idbGet('secret:' + name)) !== undefined; },
    async loadSnapshot() { return readLS<Snapshot>(LS.snapshot); },
    async saveSnapshot(s) { writeLS(LS.snapshot, s); },
    async loadHistory() { return readLS<Record<string, unknown>[]>(LS.history) ?? []; },
    async saveHistory(rows) { writeLS(LS.history, rows); },
    async loadAlertState() { return readLS<Record<string, unknown>>(LS.alerts) ?? {}; },
    async saveAlertState(s) { writeLS(LS.alerts, s); },
    async loadModelCatalog() { return readLS<ModelCatalog>(LS.models); },
    async saveModelCatalog(c) { writeLS(LS.models, c); },
    async loadAlertFeed() { return readLS<AlertFeed>(LS.feed); },
    async saveAlertFeed(f) { writeLS(LS.feed, f); },
    async pushStatus(): Promise<PushStatus> {
      const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
      if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone) return 'needs-install';
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      const reg = await navigator.serviceWorker.getRegistration();
      return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
    },
    async subscribePush(vapidPublicKey: string): Promise<PushSubscriptionInfo | null> {
      if ((await Notification.requestPermission()) !== 'granted') return null;
      const reg = await navigator.serviceWorker.ready;
      const old = await reg.pushManager.getSubscription();
      // A subscription made for another desktop's key cannot be reused, so it is replaced.
      if (old) await old.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64url(vapidPublicKey) });
      return sub.toJSON() as PushSubscriptionInfo;
    },
    async unsubscribePush() {
      const reg = await navigator.serviceWorker?.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    },
    async notify(title, body) {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(title, { body, icon: 'icon-192.png' });
      else new Notification(title, { body });
    },
    async openUrl(url) { window.open(url, '_blank', 'noopener'); },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
  };
}
