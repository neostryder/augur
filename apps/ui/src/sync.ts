// Desktop-to-phone sync. The desktop encrypts its snapshot with AES-GCM under a key that only
// it and the paired phone know, then stores the ciphertext on the relay. The relay cannot read it.
import type { Host, Shell, Snapshot } from '@augur/core';
import type { HistoryRow } from './core';

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
  // The key rides in the URL fragment, which browsers never send to a server.
  const pairUrl = `${pwaUrl.replace(/#.*$/, '')}#pair=${encodeURIComponent(link.relay)}|${channel}|${b64(key)}`;
  return { link, pairUrl };
}

export async function pushSnapshot(host: Host, link: SyncLink, snapshot: Snapshot, history: HistoryRow[]): Promise<void> {
  const [keyText, writeSecret] = await Promise.all([host.secret(KEY_SECRET), host.secret(WRITE_SECRET)]);
  if (!keyText || !writeSecret) return;
  const cut = Date.now() - 7 * 86400e3;
  const payload = JSON.stringify({ snapshot, history: history.filter((r) => new Date(r.t).getTime() >= cut) });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(unb64(keyText)), new TextEncoder().encode(payload)));
  const res = await host.http({
    url: `${link.relay}/sync/${link.channel}`, method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-sync-secret': writeSecret },
    body: JSON.stringify({ v: 1, iv: b64(iv), data: b64(data) }),
  });
  if (res.status !== 200) throw new Error(`Sync upload failed (${res.status})`);
}

/** Phone side: reads a `#pair=` fragment once, stores it, and clears it from the address bar. */
export async function acceptPairingFromUrl(shell: Shell): Promise<SyncLink | null> {
  const m = location.hash.match(/^#pair=([^|]+)\|([0-9a-f]{64})\|([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  await shell.setSecret(KEY_SECRET, m[3]!);
  return { relay: decodeURIComponent(m[1]!), channel: m[2]! };
}

export async function pullSnapshot(host: Host, link: SyncLink): Promise<{ snapshot: Snapshot; history: HistoryRow[] } | null> {
  const keyText = await host.secret(KEY_SECRET);
  if (!keyText) return null;
  const r = await fetch(`${link.relay}/sync/${link.channel}`, { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Sync download failed (${r.status})`);
  const box = (await r.json()) as { iv: string; data: string };
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await aesKey(unb64(keyText)), unb64(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Merges the desktop's providers into the phone's own snapshot; the phone's own fetches win. */
export function mergeSynced(own: Snapshot, synced: Snapshot, ownIds: Set<string>): Snapshot {
  const providers = { ...own.providers };
  for (const [id, p] of Object.entries(synced.providers)) {
    if (!ownIds.has(id)) providers[id] = { ...p, notes: { ...(p.notes ?? {}), fromDesktop: true } };
  }
  return { ...own, providers };
}
