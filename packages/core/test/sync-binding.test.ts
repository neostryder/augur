import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Host, HttpRequest } from '../src/index.js';
import { createPairing, isNewerSnapshot, pullPhoneState, pullRules, pullSnapshot, pushPhoneState, pushRules, pushSnapshot } from '../src/sync.js';
import { emptyPolicy } from '../src/index.js';

const LINK = { relay: 'https://relay.example', channel: 'a'.repeat(64) };
const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

/** A relay in memory that checks the write secret the way the real one does. */
function relay() {
  const blobs = new Map<string, string>(), order: string[] = [];
  const http = async (req: HttpRequest) => {
    const channel = req.url.split('/sync/')[1]!;
    if (req.method === 'PUT') {
      if (await sha(req.headers?.['x-sync-secret'] ?? '') !== channel) return { status: 403, headers: {}, body: '' };
      blobs.set(channel, req.body ?? ''); order.push(channel);
      return { status: 200, headers: {}, body: '' };
    }
    const b = blobs.get(channel);
    return b === undefined ? { status: 404, headers: {}, body: '' } : { status: 200, headers: {}, body: b };
  };
  return { http, blobs, order };
}

async function pair() {
  const r = relay(), desk = new Map<string, string>(), phone = new Map<string, string>();
  const shell = { setSecret: async (n: string, v: string) => { desk.set(n, v); } } as never;
  const { link, pairUrl } = await createPairing(shell, LINK.relay, 'https://pwa.example');
  phone.set('sync.key', new URL(pairUrl).hash.match(/k=([A-Za-z0-9_-]+)/)![1]!);
  const device = (s: Map<string, string>): Host => ({ platform: 'windows', http: r.http as Host['http'], secret: async (n: string) => s.get(n) ?? null });
  return { r, link, desk: device(desk), phone: device(phone), key: phone.get('sync.key')! };
}

const snap = (at: string) => ({ generatedAt: at, providers: {} }) as never;
afterEach(() => vi.unstubAllGlobals());
const serve = (body: string) => vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));

describe('channel binding', () => {
  it('refuses a box the relay moved from one channel to another', async () => {
    const { r, desk, phone, link } = await pair();
    // The phone talks to the relay with fetch, so route fetch to the same in-memory relay.
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const out = await r.http({ url, method: init?.method as 'GET' | 'PUT', headers: init?.headers as Record<string, string>, body: init?.body as string });
      return new Response(out.body || null, { status: out.status });
    });
    await pushRules(desk, link, emptyPolicy());
    await pushPhoneState(phone, link, { acks: ['a1'], push: null });
    const [rules, phoneChannel] = r.order as [string, string];
    expect(await pullPhoneState(phone, link, true)).toMatchObject({ acks: ['a1'] });
    const rulesBox = r.blobs.get(rules)!, phoneBox = r.blobs.get(phoneChannel)!;
    r.blobs.set(phoneChannel, rulesBox);
    await expect(pullPhoneState(phone, link, true)).rejects.toThrow();
    r.blobs.set(phoneChannel, phoneBox);
    r.blobs.set(rules, phoneBox);
    await expect(pullRules(desk, link, false)).rejects.toThrow();
  });

  it('reads a snapshot from its own channel and refuses it under another', async () => {
    const { r, desk, phone, link } = await pair();
    await pushSnapshot(desk, link, snap('2026-10-16T10:00:00.000Z'), []);
    serve(r.blobs.get(link.channel)!);
    expect((await pullSnapshot(phone, link))?.snapshot.generatedAt).toBe('2026-10-16T10:00:00.000Z');
    await expect(pullSnapshot(phone, { ...link, channel: 'b'.repeat(64) })).rejects.toThrow();
  });
});

describe('boxes written before the binding', () => {
  const legacy = async (key: string, payload: unknown) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['encrypt']);
    return JSON.stringify({ iv: b64(iv), data: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(payload))))) });
  };

  it('are still read, so an update on one device does not cut the other off', async () => {
    const { phone, key, link } = await pair();
    serve(await legacy(key, { snapshot: { generatedAt: '2026-10-01T00:00:00.000Z', providers: {} }, history: [] }));
    expect((await pullSnapshot(phone, link))?.snapshot.generatedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('are not taken for a snapshot when they hold something else', async () => {
    const { phone, key, link } = await pair();
    serve(await legacy(key, { policy: {} }));
    expect(await pullSnapshot(phone, link)).toBeNull();
  });
});

describe('isNewerSnapshot', () => {
  it('takes the first snapshot, a later one, and nothing else', () => {
    expect(isNewerSnapshot(null, '2026-10-16T10:00:00.000Z')).toBe(true);
    expect(isNewerSnapshot(undefined, '2026-10-16T10:00:00.000Z')).toBe(true);
    expect(isNewerSnapshot('2026-10-16T10:00:00.000Z', '2026-10-16T10:00:01.000Z')).toBe(true);
    expect(isNewerSnapshot('2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z')).toBe(false);
    expect(isNewerSnapshot('2026-10-16T10:00:00.000Z', '2026-10-15T10:00:00.000Z')).toBe(false);
    expect(isNewerSnapshot(null, 'yesterday')).toBe(false);
    expect(isNewerSnapshot(null, undefined)).toBe(false);
  });
  it('treats an unreadable stored stamp as none', () => { expect(isNewerSnapshot('junk', '2026-10-16T10:00:00.000Z')).toBe(true); });
});
