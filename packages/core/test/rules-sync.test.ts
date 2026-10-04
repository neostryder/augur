import { emptyPolicy, fieldPath, mergePolicy, policyDigest, setField } from '../src/index.js';
import type { Host, HttpRequest, PolicyConfig } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import { createPairing, pullRules, pushRules } from '../src/sync.js';

/** A relay in memory: PUT stores under the path when the secret hashes to the channel, GET returns it. */
function relay() {
  const blobs = new Map<string, string>(), puts: string[] = [];
  const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const http = async (req: HttpRequest) => {
    const channel = req.url.split('/sync/')[1]!;
    if (req.method === 'PUT') {
      if (await sha(req.headers?.['x-sync-secret'] ?? '') !== channel) return { status: 403, headers: {}, body: '' };
      blobs.set(channel, req.body ?? ''); puts.push(channel);
      return { status: 200, headers: {}, body: '' };
    }
    const b = blobs.get(channel);
    return b === undefined ? { status: 404, headers: {}, body: '' } : { status: 200, headers: {}, body: b };
  };
  return { http, blobs, puts };
}

const device = (r: ReturnType<typeof relay>, secrets: Map<string, string>): Host => ({ platform: 'windows', http: r.http as Host['http'], secret: async (n: string) => secrets.get(n) ?? null });
const LINK = { relay: 'https://relay.example', channel: 'a'.repeat(64) };

describe('syncing rules between paired devices', () => {
  async function pair() {
    const r = relay(), desk = new Map<string, string>(), phone = new Map<string, string>();
    const shell = { setSecret: async (n: string, v: string) => { desk.set(n, v); } } as never;
    const { pairUrl } = await createPairing(shell, LINK.relay, 'https://pwa.example');
    phone.set('sync.key', new URL(pairUrl).hash.match(/k=([A-Za-z0-9_-]+)/)![1]!);
    return { r, desk: device(r, desk), phone: device(r, phone), stranger: device(r, new Map([['sync.key', 'AAAA' + 'B'.repeat(39)]])) };
  }
  const cost = fieldPath('codex', 'codex/sol', 'cost');
  const policy = (): PolicyConfig => { const p = emptyPolicy(); p.providers.codex = { defaults: {}, models: { 'codex/sol': { id: 'sol', source: 'manual', status: 'confirmed', rule: {}, firstSeen: '2026-09-29T00:00:00.000Z' } } }; return p; };

  it('lets the other device read what one uploaded, and nothing before an upload', async () => {
    const { desk, phone } = await pair();
    expect(await pullRules(phone, LINK)).toBeNull();
    const p = policy();
    setField(p, cost, 'cheap', 'desktop', new Date('2026-09-29T12:00:00Z'));
    await pushRules(desk, LINK, p);
    const got = await pullRules(phone, LINK);
    expect(got?.stamps).toEqual(p.stamps);
    expect(got?.providers.codex!.models['codex/sol']!.rule.cost).toBe('cheap');
  });

  it('lets the phone upload too, on the same channel, and merges an edit made with a slow clock', async () => {
    const { r, desk, phone } = await pair();
    const p = policy();
    setField(p, cost, 'cheap', 'desktop', new Date('2026-09-29T12:00:00Z'));
    await pushRules(desk, LINK, p);
    const onPhone = mergePolicy(policy(), (await pullRules(phone, LINK))!);
    setField(onPhone, cost, 'moderate', 'phone', new Date('2026-09-29T09:00:00Z'));
    await pushRules(phone, LINK, onPhone);
    expect(new Set(r.puts).size).toBe(1);
    const back = mergePolicy(p, (await pullRules(desk, LINK))!);
    expect(back.providers.codex!.models['codex/sol']!.rule.cost).toBe('moderate');
    expect(policyDigest(back)).toBe(policyDigest(onPhone));
  });

  it('keeps the rules on a channel of their own, unreadable without the pairing key', async () => {
    const { r, desk, stranger } = await pair();
    await pushRules(desk, LINK, policy());
    expect([...r.blobs.keys()]).not.toContain(LINK.channel);
    await expect(pullRules(stranger, LINK)).resolves.toBeNull();
  });
});
