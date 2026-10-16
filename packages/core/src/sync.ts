// Desktop-to-phone sync. The desktop encrypts its snapshot with AES-GCM under a key that only
// it and the paired phone know, then stores the ciphertext on the relay. The relay cannot read it.
import { isPushSubscription } from './webpush.js';
import { migratePolicy, type PolicyConfig } from './policy.js';
import type { AlertConfig, AppConfig, GenericProviderDef, Host, HttpRequest, LayoutConfig, ProviderSettings, Snapshot } from './types.js';
import type { FeedAlert } from './feed.js';
import type { PushSubscriptionInfo } from './webpush.js';
import type { HistoryRow } from './history.js';
import { withCompactFleet } from './fleet.js';
import { keyMayGoTo } from './net.js';

/** The shared relay and web app. It serves the phone app and forwards its requests, so a fresh install can pair a phone without setup. */
export const HOSTED = 'https://augur.rpgm.tools';

/** Stores a secret where the device keeps them: the keychain on the desktop, the browser's store on the phone. */
export interface SecretWriter { setSecret(name: string, value: string): Promise<void> }

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
  /** The desktop's alert feed: the alerts kept for the bell. */
  alerts?: FeedAlert[];
  /** The desktop's public VAPID key, which the phone subscribes to push with. */
  pushKey?: string;
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

/** What the relay stores for a channel. */
interface Box { v?: number; iv: string; data: string }

// Version 3 binds the channel name into the encryption as additional data, so a relay that moves a box from one channel to another cannot have it accepted there.
const aad = (channel: string) => new TextEncoder().encode(`augur sync v3|${channel}`);

async function seal(key: Uint8Array<ArrayBuffer>, channel: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(channel) }, await aesKey(key), await gzip(text)));
  return JSON.stringify({ v: 3, iv: b64(iv), data: b64(data) });
}

/** Opens a box from `channel`. Boxes written before version 3 carry no channel binding and are still read, so an update on one device does not cut the other off. */
async function open(key: Uint8Array<ArrayBuffer>, channel: string, box: Box): Promise<string> {
  if (!box || typeof box.iv !== 'string' || typeof box.data !== 'string') throw new Error('Sync data is malformed');
  const params: AesGcmParams = box.v === 3 ? { name: 'AES-GCM', iv: unb64(box.iv), additionalData: aad(channel) } : { name: 'AES-GCM', iv: unb64(box.iv) };
  const plain = await crypto.subtle.decrypt(params, await aesKey(key), unb64(box.data));
  return box.v === 2 || box.v === 3 ? gunzip(plain) : new TextDecoder().decode(plain);
}

/** Whether a snapshot stamped `at` is newer than the newest one already applied. A relay that serves an old box again is not newer. */
export function isNewerSnapshot(seen: string | null | undefined, at: unknown): boolean {
  const next = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(next)) return false;
  const last = seen ? Date.parse(seen) : NaN;
  return !Number.isFinite(last) || next > last;
}

/** Creates a new channel on the desktop and returns the link the phone opens. */
export async function createPairing(shell: SecretWriter, relay: string, pwaUrl: string): Promise<{ link: SyncLink; pairUrl: string }> {
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

/** Reads a pairing link in the current form or the older `|`-separated one, raw or percent-encoded. A link whose relay is not an https address (or a home-network one) is not a pairing link. */
export function parsePairing(text: string): (SyncLink & { key: string }) | null {
  const link = readPairing(text);
  return link && keyMayGoTo(link.relay) ? link : null;
}

function readPairing(text: string): (SyncLink & { key: string }) | null {
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

export async function pushSnapshot(host: Host, link: SyncLink, snapshot: Snapshot, history: HistoryRow[], config?: SharedConfig, secrets?: Record<string, string>,
  extra: Pick<SyncPayload, 'alerts' | 'pushKey'> = {}): Promise<void> {
  const [keyText, writeSecret] = await Promise.all([host.secret(KEY_SECRET), host.secret(WRITE_SECRET)]);
  if (!keyText || !writeSecret) return;
  const cut = Date.now() - 7 * 86400e3;
  const payload = JSON.stringify({ snapshot: withCompactFleet(snapshot), history: history.filter((r) => new Date(r.t).getTime() >= cut), config, secrets, ...extra } satisfies SyncPayload);
  const res = await host.http({
    url: `${link.relay}/sync/${link.channel}`, method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-sync-secret': writeSecret },
    body: await seal(unb64(keyText), link.channel, payload),
  });
  if (res.status !== 200) throw new SyncUploadError(res.status);
}

export class SyncUploadError extends Error {
  constructor(readonly status: number) { super(`Sync upload failed (${status})`); }
}

/** Stores the pairing key from a link the phone opened or scanned. */
export async function acceptPairing(shell: SecretWriter, link: SyncLink & { key: string }): Promise<SyncLink> {
  await shell.setSecret(KEY_SECRET, link.key);
  return { relay: link.relay, channel: link.channel };
}

export async function pullSnapshot(host: Host, link: SyncLink): Promise<SyncPayload | null> {
  const keyText = await host.secret(KEY_SECRET);
  if (!keyText) return null;
  const r = await fetch(`${link.relay}/sync/${link.channel}`, { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Sync download failed (${r.status})`);
  const parsed = JSON.parse(await open(unb64(keyText), link.channel, (await r.json()) as Box)) as Partial<SyncPayload> | null;
  // Anything that is not a desktop snapshot, such as a box moved here from another channel, is not an answer.
  return parsed && typeof parsed === 'object' && parsed.snapshot && typeof parsed.snapshot.generatedAt === 'string' && parsed.snapshot.providers && Array.isArray(parsed.history) ? (parsed as SyncPayload) : null;
}

/**
 * Rules travel on a second relay channel that both devices can write, and the phone's dismissals and push subscription on a third.
 * Their secrets are derived from the pairing key, which only the two devices hold, so no extra secret is stored or sent,
 * and the relay sees only ciphertext under an unguessable name.
 */
async function derivedChannel(host: Host, label: string): Promise<{ key: Uint8Array<ArrayBuffer>; secret: string; channel: string } | null> {
  const keyText = await host.secret(KEY_SECRET);
  if (!keyText) return null;
  const key = unb64(keyText);
  const mac = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = b64(new Uint8Array(await crypto.subtle.sign('HMAC', mac, new TextEncoder().encode(label))));
  return { key, secret, channel: await sha256Hex(secret) };
}
const rulesChannel = (host: Host) => derivedChannel(host, 'augur rules channel v1');
const phoneChannel = (host: Host) => derivedChannel(host, 'augur phone channel v1');

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
  const res = await relayCall(host, direct, `${link.relay}/sync/${rc.channel}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-sync-secret': rc.secret },
    body: await seal(rc.key, rc.channel, JSON.stringify({ policy })) });
  if (res.status !== 200) throw new SyncUploadError(res.status);
}

/** The other device's rules: null when none have been uploaded yet, and a rejection when the relay could not be reached. */
export async function pullRules(host: Host, link: SyncLink, direct = false): Promise<PolicyConfig | null> {
  const rc = await rulesChannel(host);
  if (!rc) return null;
  const res = await relayCall(host, direct, `${link.relay}/sync/${rc.channel}`, { method: 'GET' });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Rules download failed (${res.status})`);
  const parsed = JSON.parse(await open(rc.key, rc.channel, JSON.parse(res.body) as Box)) as { policy?: unknown };
  return parsed.policy ? migratePolicy(parsed.policy) : null;
}

/** What the phone tells the desktop: the alerts dismissed on the phone, newest last, and where to send push notifications. */
export interface PhoneState {
  acks: string[];
  push: PushSubscriptionInfo | null;
}

/** The phone keeps this many dismissals on its channel, far more than the feed ever holds. */
const PHONE_ACKS_KEPT = 200;

/** Phone side: uploads its dismissals and push subscription. The relay takes one write a minute per channel, so a 429 means try again later. */
export async function pushPhoneState(host: Host, link: SyncLink, state: PhoneState): Promise<void> {
  const pc = await phoneChannel(host);
  if (!pc) return;
  const body: PhoneState = { acks: state.acks.slice(-PHONE_ACKS_KEPT), push: state.push };
  const res = await relayCall(host, true, `${link.relay}/sync/${pc.channel}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-sync-secret': pc.secret },
    body: await seal(pc.key, pc.channel, JSON.stringify(body)) });
  if (res.status !== 200) throw new SyncUploadError(res.status);
}

/** Either side: the phone's last upload, null when there is none yet, and a rejection when the relay could not be reached. */
export async function pullPhoneState(host: Host, link: SyncLink, direct = false): Promise<PhoneState | null> {
  const pc = await phoneChannel(host);
  if (!pc) return null;
  const res = await relayCall(host, direct, `${link.relay}/sync/${pc.channel}`, { method: 'GET' });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Phone state download failed (${res.status})`);
  const raw = JSON.parse(await open(pc.key, pc.channel, JSON.parse(res.body) as Box)) as Partial<PhoneState>;
  if (!Array.isArray(raw.acks)) return null;
  return { acks: Array.isArray(raw.acks) ? raw.acks.filter((a): a is string => typeof a === 'string') : [], push: isPushSubscription(raw.push) ? raw.push : null };
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
