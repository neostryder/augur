import { describe, expect, it } from 'vitest';
import { defaultConfig, migrateConfig, unb64url } from '@augur/core';
import type { AppConfig, Shell } from '@augur/core';
import { FeedKeeper, type Raise } from '../src/feed-keeper';

function fakeShell() {
  const files = new Map<string, string>(), secrets = new Map<string, string>();
  const notified: string[] = [], pushed: Array<{ endpoint: string; headers: Record<string, string>; body: Uint8Array }> = [];
  let pushStatus = 201;
  const shell = {
    kind: 'desktop',
    host: {
      platform: 'windows',
      http: async () => ({ status: 200, headers: {}, body: '' }),
      secret: async (n: string) => secrets.get(n) ?? null,
      readHomeFile: async (p: string) => files.get(p) ?? null,
      writeHomeFileAtomic: async (p: string, t: string) => { files.set(p, t); },
    },
    setSecret: async (n: string, v: string) => { secrets.set(n, v); },
    notify: async (title: string) => { notified.push(title); },
    sendWebPush: async (endpoint: string, headers: Record<string, string>, body: Uint8Array) => { pushed.push({ endpoint, headers, body }); return pushStatus; },
  } as unknown as Shell;
  return { shell, files, secrets, notified, pushed, setPushStatus: (s: number) => { pushStatus = s; } };
}

const config = (): AppConfig => {
  const c = migrateConfig(defaultConfig());
  c.alerts.enabled = true;
  c.exportPath = '.augur/usage.json';
  return c;
};
const item = (id: string, kind: Raise['kind'] = 'percent'): Raise => ({ id, kind, severity: 'warn', title: 'Claude', body: id, clears: { when: 'never' } });
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: '', auth: '' } };

async function phoneKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { ...sub, keys: { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) } };
}

describe('the desktop alert feed', () => {
  it('sends each kind where the outlet grid says and writes the kept ones beside the export file', async () => {
    const f = fakeShell(), c = config();
    const keeper = new FeedKeeper(f.shell, () => c, () => 'https://augur.example.com');
    expect(await keeper.raise([item('a'), item('u', 'update'), item('r', 'refresh')])).toBe(true);
    // Update and refresh skip the computer's notifications by default.
    expect(f.notified).toEqual(['Claude']);
    const saved = JSON.parse(f.files.get('.augur/alerts.json')!);
    expect(saved.alerts.map((a: { id: string }) => a.id)).toEqual(['r', 'u', 'a']);
    expect(saved.alerts.find((a: { id: string }) => a.id === 'u').outlets).toEqual(['augur']);
  });

  it('does not repeat an alert already in the feed, and raises nothing while alerts are off', async () => {
    const f = fakeShell(), c = config();
    const keeper = new FeedKeeper(f.shell, () => c, () => 'https://augur.example.com');
    await keeper.raise([item('a')]);
    expect(await keeper.raise([item('a')])).toBe(false);
    expect(f.notified.length).toBe(1);
    c.alerts.enabled = false;
    expect(await keeper.raise([item('b')])).toBe(false);
  });

  it('keeps an alert out of the feed when neither the bell nor Claude Code wants it', async () => {
    const f = fakeShell(), c = config();
    c.alerts.outlets.percent = { system: true, augur: false, claude: false, phone: false };
    const keeper = new FeedKeeper(f.shell, () => c, () => 'https://augur.example.com');
    expect(await keeper.raise([item('a')])).toBe(false);
    expect(f.notified).toEqual(['Claude']);
    expect(keeper.feed.alerts).toEqual([]);
  });

  it('applies acks from Claude Code and empties a long acks file only when nothing new was added', async () => {
    const f = fakeShell(), c = config();
    const keeper = new FeedKeeper(f.shell, () => c, () => 'https://augur.example.com');
    await keeper.raise([item('a'), item('b')]);
    f.files.set('.augur/alerts-acks.jsonl', '{"id":"a","by":"claude"}\n');
    expect(await keeper.checkAcks()).toBe(true);
    expect(keeper.feed.alerts.map((a) => a.id)).toEqual(['b']);
    expect(f.files.get('.augur/alerts-acks.jsonl')).toContain('"a"');
    f.files.set('.augur/alerts-acks.jsonl', Array.from({ length: 250 }, (_, i) => `{"id":"x${i}"}`).join('\n'));
    await keeper.checkAcks();
    expect(f.files.get('.augur/alerts-acks.jsonl')).toBe('');
  });

  it('pushes to the paired phone with a VAPID key it makes once, and forgets a subscription the push service dropped', async () => {
    const f = fakeShell(), c = config();
    const keeper = new FeedKeeper(f.shell, () => c, () => 'https://augur.example.com');
    expect(await keeper.mergePhone({ acks: [], push: await phoneKeys() })).toBe(false);
    await keeper.raise([item('a')]);
    expect(f.pushed.length).toBe(1);
    expect(f.pushed[0]!.headers.authorization).toMatch(/^vapid t=.+, k=/);
    const key = await keeper.pushKey();
    expect(unb64url(key!).length).toBe(65);
    expect(JSON.parse(f.secrets.get('push.vapid')!).publicKey).toBe(key);
    f.setPushStatus(410);
    await keeper.raise([item('b')]);
    expect(keeper.phonePush).toBeNull();
    await keeper.raise([item('c')]);
    expect(f.pushed.length).toBe(2);
  });

  it('takes dismissals from the phone', async () => {
    const f = fakeShell(), c = config();
    const keeper = new FeedKeeper(f.shell, () => c, () => 'https://augur.example.com');
    await keeper.raise([item('a'), item('b')]);
    expect(await keeper.mergePhone({ acks: ['b', 'gone'], push: null })).toBe(true);
    expect(keeper.feed.alerts.map((a) => a.id)).toEqual(['a']);
  });
});
