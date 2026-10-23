import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ChatEvent, RouteConfig } from '@augur/dispatch-protocol';
import { ChatService, classifyFile, titleFrom, type Caller } from '../src/chat/service.js';
import { policySource } from '../src/sources.js';
import { makeEnv, type Env } from './harness.js';

const envs: Env[] = [], services: ChatService[] = [];
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const e of envs.splice(0)) e.dispose(); });

const route = (over: Record<string, unknown> = {}): RouteConfig => ({ model: 'test/text', adapter: 'openai-api', options: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKeyEnv: 'CHAT_TEST_KEY', ...over } } as RouteConfig);

function scripted(lines: Array<Record<string, unknown>>, seen: Array<{ args: string[]; stdin: string }> = []): Caller {
  return (args, stdin) => {
    seen.push({ args, stdin });
    async function* gen() { for (const l of lines) yield l; }
    return { events: gen(), stop() { /* nothing to stop */ } };
  };
}

function make(caller: Caller, routes: Record<string, RouteConfig> = { text: route() }) {
  const env = makeEnv();
  envs.push(env);
  env.writePolicy();
  const policy = policySource(join(env.home, 'policy.json'));
  const svc = new ChatService({ dir: env.dir, routes: () => routes, adapters: new Set(['openai-api', 'anthropic-api']), policy: () => policy.read(), usage: () => null, log: () => undefined, caller });
  services.push(svc);
  return svc;
}

const collect = async (g: AsyncGenerator<ChatEvent>) => { const out: ChatEvent[] = []; for await (const e of g) out.push(e); return out; };

describe('chat service', () => {
  it('lists chat routes with their settings and the rules verdict', async () => {
    const svc = make(scripted([]));
    const [m] = await svc.models();
    expect(m!.route).toBe('text');
    expect(m!.usable).toBe(true);
    expect(m!.settings.some(s => s.key === 'temperature' && s.tooltip.length > 20)).toBe(true);
  });

  it('streams a reply, saves it, and titles the chat from the first message', async () => {
    const seen: Array<{ args: string[]; stdin: string }> = [];
    const svc = make(scripted([{ t: 'think', text: 'hm' }, { t: 'delta', text: 'Hello ' }, { t: 'delta', text: 'there' }, { t: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }, { t: 'done' }], seen));
    const chat = svc.create({ route: 'text', tier: 'internal', settings: { temperature: 0.4, system: 'Be kind.' } });
    const events = await collect(svc.send({ chat: chat.id, text: 'say hello to the world please' }));
    expect(events.map(e => e.t)).toEqual(['start', 'think', 'delta', 'delta', 'usage', 'title', 'done']);
    const done = events.at(-1) as Extract<ChatEvent, { t: 'done' }>;
    expect(done.message.text).toBe('Hello there');
    expect(done.message.reasoning).toBe('hm');
    expect(done.message.state).toBe('done');
    const sent = JSON.parse(seen[0]!.stdin);
    expect(sent.system).toBe('Be kind.');
    expect(sent.body).toEqual({ temperature: 0.4 });
    expect(sent.messages).toEqual([{ role: 'user', text: 'say hello to the world please', files: [] }]);
    expect(svc.get(chat.id)!.title).toBe('say hello to the world please');
  });

  it('answers an existing message again as a new branch', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }]));
    const chat = svc.create({ route: 'text', tier: 'internal' });
    const first = await collect(svc.send({ chat: chat.id, text: 'q' }));
    const user = (first[0] as Extract<ChatEvent, { t: 'start' }>).user;
    await collect(svc.send({ chat: chat.id, retry: user.id, text: '' }));
    const tree = svc.get(chat.id)!.tree;
    expect(tree.filter(m => m.parent === user.id).length).toBe(2);
  });

  it('records a failed reply as an error state', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'par' }, { t: 'error', message: 'HTTP 500' }]));
    const chat = svc.create({ route: 'text', tier: 'internal' });
    const events = await collect(svc.send({ chat: chat.id, text: 'q' }));
    expect(events.some(e => e.t === 'error')).toBe(true);
    const done = events.at(-1) as Extract<ChatEvent, { t: 'done' }>;
    expect(done.message.state).toBe('error');
    expect(done.message.text).toBe('par');
  });

  it('refuses a tier the model is not cleared for, and a tier drop once messages exist', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }]));
    expect(() => svc.create({ route: 'text', tier: 'regulated' })).toThrow();
    const chat = svc.create({ route: 'text', tier: 'internal' });
    await collect(svc.send({ chat: chat.id, text: 'q' }));
    expect(() => svc.update(chat.id, { tier: 'public' })).toThrow(/lower data tier/);
    expect(svc.update(chat.id, { pinned: true }).pinned).toBe(true);
  });

  it('keeps temporary chats in memory only and refuses images for a model that cannot see', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }]), { text: route({ vision: false }) });
    const chat = svc.create({ route: 'text', tier: 'internal', temporary: true });
    expect(svc.list().find(c => c.id === chat.id)?.temporary).toBe(true);
    expect(svc.saved.get(chat.id)).toBeNull();
    const f = svc.upload(chat.id, 'pic.png', 'image/png', new Uint8Array([1, 2, 3]));
    const events = await collect(svc.send({ chat: chat.id, text: 'look', files: [f.id] }));
    expect(events.some(e => e.t === 'error' && /cannot see images/.test(e.message))).toBe(true);
  });

  it('cleans uploaded names and sorts files by kind', () => {
    const svc = make(scripted([]));
    const chat = svc.create({ route: 'text', tier: 'internal' });
    const f = svc.upload(chat.id, '..\\evil/<name>.txt', '', new Uint8Array([65]));
    expect(f.name).not.toMatch(/[\\/<>]/);
    expect(f.kind).toBe('text');
    expect(() => svc.upload(chat.id, 'x', '', new Uint8Array())).toThrow(/empty/);
    expect(classifyFile('a.mp3', '').kind).toBe('audio');
    expect(classifyFile('a.bin', '').kind).toBe('file');
    expect(titleFrom('   ')).toBe('New chat');
  });
});
