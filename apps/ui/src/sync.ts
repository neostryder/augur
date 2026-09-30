// Desktop-to-phone sync. The desktop encrypts its snapshot with AES-GCM under a key that only
// it and the paired phone know, then stores the ciphertext on the relay. The relay cannot read it.
import { migratePolicy } from '@augur/core';
import type { AlertConfig, AppConfig, GenericProviderDef, Host, HttpRequest, LayoutConfig, PolicyConfig, ProviderSettings, Shell, Snapshot } from '@augur/core';
import type { HistoryRow } from './core';

/** The desktop settings a newly paired phone starts from. No secrets: keys never leave the desktop. */
export interface SharedConfig {
  providers: Array<{ id: string; enabled: boolean; settings: ProviderSettings }>;
  custom: GenericProviderDef[];
  layout: LayoutConfig;
  alerts: Omit<AlertConfig, 'enabled'>;
}

export interface SyncPayload {
  snapshot: Snapshot;
  history: HistoryRow[];
  config?: SharedConfig;
  /** API keys for providers the phone can read itself, keyed `<providerId>.<fieldKey>`. */
  secrets?: Record<string, string>;
}

export function sharedConfig(config: AppConfig): SharedConfig {
  const { enabled: _enabled, ...alerts } = config.alerts;
  return { providers: config.providers.map(({ id, enabled, settings }) => ({ id, enabled, settings })), custom: config.custom, layout: config.layout, alerts };
}

/**
 * Starts a newly paired phone from the desktop's settings: provider order, which ones show, colors,
 * hidden meters, theme and alert levels. The phone's own alert switch stays off until turned on there,
 * since notifications need the phone's permission.
 */
export function applySharedConfig(config: AppConfig, shared: SharedConfig): AppConfig {
  const byId = new Map(config.providers.map((p) => [p.id, p]));
  const custom = [...shared.custom, ...config.custom.filter((d) => !shared.custom.some((s) => s.id === d.id))];
  const ordered = shared.providers.map((s) => ({ ...(byId.get(s.id) ?? { id: s.id, settings: {} }), enabled: s.enabled, settings: { ...s.settings } }));
  const rest = config.providers.filter((p) => !shared.providers.some((s) => s.id === p.id));
  return { ...config, custom, providers: [...ordered, ...rest], layout: structuredClone(shared.layout), alerts: { ...structuredClone(shared.alerts), enabled: config.alerts.enabled } };
}

export interface SyncLink {
  relay: string;
  channel: string;
}

const KEY_SECRET = 'sync.key';
const WRITE_SECRET = 'sync.writeSecret';
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Version 2 gzips the JSON before encrypting it: a week of history is about 1 MB as JSON and a small fraction of that compressed.
async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: ArrayBuffer): Promise<string> {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

async function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Creates a new channel on the desktop and returns the link the phone opens. */
export async function createPairing(shell: Shell, relay: string, pwaUrl: string): Promise<{ link: SyncLink; pairUrl: string }> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const writeSecret = b64(crypto.getRandomValues(new Uint8Array(32)));
  const channel = await sha256Hex(writeSecret);
  await shell.setSecret(KEY_SECRET, b64(key));
  await shell.setSecret(WRITE_SECRET, writeSecret);
  const link = { relay: relay.replace(/\/$/, ''), channel };
  return { link, pairUrl: pairingUrl(pwaUrl, link, b64(key)) };
}

/**
 * The key rides in the URL fragment, which browsers never send to a server. Every character is
 * URL-safe, so a camera app that re-encodes the link still hands over the same text.
 */
export function pairingUrl(pwaUrl: string, link: SyncLink, key: string): string {
  return `${pwaUrl.replace(/#.*$/, '')}#pair?r=${encodeURIComponent(link.relay)}&c=${link.channel}&k=${key}`;
}

/** Reads a pairing link in the current form or the older `|`-separated one, raw or percent-encoded. */
export function parsePairing(text: string): (SyncLink & { key: string }) | null {
  const hash = text.slice(text.indexOf('#') + 1);
  if (hash.startsWith('pair?')) {
    const q = new URLSearchParams(hash.slice(5));
    const relay = q.get('r'), channel = q.get('c'), key = q.get('k');
    return relay && channel && /^[0-9a-f]{64}$/.test(channel) && key && /^[A-Za-z0-9_-]+$/.test(key) ? { relay, channel, key } : null;
  }
  let plain = hash;
  try { plain = decodeURIComponent(hash); } catch { /* keep as is */ }
  const m = plain.match(/^pair=([^|]+)\|([0-9a-f]{64})\|([A-Za-z0-9_-]+)$/);
  return m ? { relay: m[1]!, channel: m[2]!, key: m[3]! } : null;
}

export async function pushSnapshot(host: Host, link: SyncLink, snapshot: Snapshot, history: HistoryRow[], config?: SharedConfig, secrets?: Record<string, string>): Promise<void> {
  const [keyText, writeSecret] = await Promise.all([host.secret(KEY_SECRET), host.secret(WRITE_SECRET)]);
  if (!keyText || !writeSecret) return;
  const cut = Date.now() - 7 * 86400e3;
  const payload = JSON.stringify({ snapshot, history: history.filter((r) => new Date(r.t).getTime() >= cut), config, secrets } satisfies SyncPayload);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(unb64(keyText)), await gzip(payload)));
  const res = await host.http({
    url: `${link.relay}/sync/${link.channel}`, method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-sync-secret': writeSecret },
    body: JSON.stringify({ v: 2, iv: b64(iv), data: b64(data) }),
  });
  if (res.status !== 200) throw new SyncUploadError(res.status);
}

export class SyncUploadError extends Error {
  constructor(readonly status: number) { super(`Sync upload failed (${status})`); }
}

/** Phone side: reads a `#pair=` fragment once, stores it, and clears it from the address bar. */
export async function acceptPairingFromUrl(shell: Shell): Promise<SyncLink | null> {
  if (!location.hash.startsWith('#pair')) return null;
  const link = parsePairing(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  return link ? acceptPairing(shell, link) : null;
}

/** Stores the pairing key from a link the phone opened or scanned. */
export async function acceptPairing(shell: Shell, link: SyncLink & { key: string }): Promise<SyncLink> {
  await shell.setSecret(KEY_SECRET, link.key);
  return { relay: link.relay, channel: link.channel };
}

export async function pullSnapshot(host: Host, link: SyncLink): Promise<SyncPayload | null> {
  const keyText = await host.secret(KEY_SECRET);
  if (!keyText) return null;
  const r = await fetch(`${link.relay}/sync/${link.channel}`, { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Sync download failed (${r.status})`);
  const box = (await r.json()) as { v?: number; iv: string; data: string };
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await aesKey(unb64(keyText)), unb64(box.data));
  return JSON.parse(box.v === 2 ? await gunzip(plain) : new TextDecoder().decode(plain));
}

/**
 * Rules travel on a second relay channel that both devices can write. Its secret is derived from the pairing key, which only the two devices hold,
 * so no extra secret is stored or sent, and the relay sees only ciphertext under an unguessable name.
 */
async function rulesChannel(host: Host): Promise<{ key: Uint8Array<ArrayBuffer>; secret: string; channel: string } | null> {
  const keyText = await host.secret(KEY_SECRET);
  if (!keyText) return null;
  const key = unb64(keyText);
  const mac = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = b64(new Uint8Array(await crypto.subtle.sign('HMAC', mac, new TextEncoder().encode('augur rules channel v1'))));
  return { key, secret, channel: await sha256Hex(secret) };
}

/**
 * The phone talks to the relay directly, since the relay's own /fetch proxy only reaches the providers' hosts. The desktop goes through its shell.
 * A 404 is an answer here, not a failure.
 */
async function relayCall(host: Host, direct: boolean, url: string, init: Omit<HttpRequest, 'url'>): Promise<{ status: number; body: string }> {
  if (!direct) return host.http({ url, ...init });
  const r = await fetch(url, { method: init.method ?? 'GET', ...(init.headers ? { headers: init.headers } : {}), ...(init.body !== undefined ? { body: init.body } : {}), cache: 'no-store' });
  return { status: r.status, body: await r.text() };
}

/** Uploads this device's rules for the other device to merge. `direct` is true on the phone. */
export async function pushRules(host: Host, link: SyncLink, policy: PolicyConfig, direct = false): Promise<void> {
  const rc = await rulesChannel(host);
  if (!rc) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(rc.key), await gzip(JSON.stringify({ policy }))));
  const res = await relayCall(host, direct, `${link.relay}/sync/${rc.channel}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-sync-secret': rc.secret },
    body: JSON.stringify({ v: 2, iv: b64(iv), data: b64(data) }) });
  if (res.status !== 200) throw new SyncUploadError(res.status);
}

/** The other device's rules: null when none have been uploaded yet, and a rejection when the relay could not be reached. */
export async function pullRules(host: Host, link: SyncLink, direct = false): Promise<PolicyConfig | null> {
  const rc = await rulesChannel(host);
  if (!rc) return null;
  const res = await relayCall(host, direct, `${link.relay}/sync/${rc.channel}`, { method: 'GET' });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Rules download failed (${res.status})`);
  const box = JSON.parse(res.body) as { iv: string; data: string };
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await aesKey(rc.key), unb64(box.data));
  const parsed = JSON.parse(await gunzip(plain)) as { policy?: unknown };
  return parsed.policy ? migratePolicy(parsed.policy) : null;
}

/** Phone side: asks the paired desktop to read every provider now. Returns the relay's time of the request. */
export async function askDesktop(link: SyncLink): Promise<number | null> {
  const r = await fetch(`${link.relay}/sync/${link.channel}/ask`, { method: 'POST', cache: 'no-store' });
  if (!r.ok) return null;
  const { at } = (await r.json()) as { at?: number };
  return typeof at === 'number' ? at : null;
}

/** Desktop side: the time of the phone's latest refresh request, 0 when there is none, or null when the relay did not answer. */
export async function readAsk(host: Host, link: SyncLink): Promise<number | null> {
  const res = await host.http({ url: `${link.relay}/sync/${link.channel}/ask`, method: 'GET' });
  if (res.status === 404) return 0;
  if (res.status !== 200) return null;
  const at = (JSON.parse(res.body) as { at?: number }).at;
  return typeof at === 'number' ? at : null;
}

/**
 * Merges the desktop's providers into the phone's own snapshot. The phone's own reading wins while
 * it is good; when the phone's own read failed, a good reading from the desktop is shown instead.
 */
export function mergeSynced(own: Snapshot, synced: Snapshot, ownIds: Set<string>): Snapshot {
  const providers = { ...own.providers };
  for (const [id, p] of Object.entries(synced.providers)) {
    const mine = providers[id];
    const useDesktop = !ownIds.has(id) || (!!mine && !mine.ok && p.ok);
    if (useDesktop) providers[id] = { ...p, notes: { ...(p.notes ?? {}), fromDesktop: true } };
  }
  return { ...own, providers };
}
