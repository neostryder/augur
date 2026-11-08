import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ChatEvent, RouteConfig } from '@augur/dispatch-protocol';
import { ChatService, classifyFile, titleFrom, type Caller } from '../src/chat/service.js';
import { UserStore } from '../src/chat/users.js';
import { policySource } from '../src/sources.js';
import { makeEnv, type Env } from './harness.js';

const envs: Env[] = [], services: ChatService[] = [], stores: UserStore[] = [];
const owner = { kind: 'owner' } as const;
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const u of stores.splice(0)) u.close(); for (const e of envs.splice(0)) e.dispose(); });

const route = (over: Record<string, unknown> = {}): RouteConfig => ({ model: 'test/text', adapter: 'openai-api', options: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKeyEnv: 'CHAT_TEST_KEY', ...over } } as RouteConfig);

function scripted(lines: Array<Record<string, unknown>>, seen: Array<{ args: string[]; stdin: string }> = []): Caller {
  return (args, stdin) => {
    seen.push({ args, stdin });
    async function* gen() { for (const l of lines) yield l; }
    return { events: gen(), stop() { /* nothing to stop */ } };
  };
}

function make(caller: Caller, routes: Record<string, RouteConfig> = { text: route() }, now?: () => number) {
  const env = makeEnv();
  envs.push(env);
  env.writePolicy();
  const policy = policySource(join(env.home, 'policy.json'));
  const users = new UserStore(null);
  stores.push(users);
  const svc = new ChatService({ users, now, dir: env.dir, routes: () => routes, adapters: new Set(['openai-api', 'anthropic-api']), policy: () => policy.read(), usage: () => null, log: () => undefined, caller });
  services.push(svc);
  return svc;
}

const collect = async (g: AsyncGenerator<ChatEvent>) => { const out: ChatEvent[] = []; for await (const e of g) out.push(e); return out; };

function discovering() {
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  const seen: Array<{ args: string[]; stdin: string }> = [], reply = scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }], seen);
  const svc = make((args, stdin, env) => args.includes('capabilities') ? {
    events: (async function* () { await pending; yield { schema: 1 }; })(), stop() { /* nothing to stop */ },
  } : reply(args, stdin, env), { text: route({ requestClass: 'cogitator' }) });
  return { svc, seen, release };
}

describe('chat service', () => {
  it('lists chat routes with their settings and the rules verdict', async () => {
    const svc = make(scripted([]));
    const [m] = await svc.models(owner);
    expect(m!.route).toBe('text');
    expect(m!.usable).toBe(true);
    expect(m!.settings.some(s => s.key === 'temperature' && s.tooltip.length > 20)).toBe(true);
  });

  it('streams a reply, saves it, and titles the chat from the first message', async () => {
    const seen: Array<{ args: string[]; stdin: string }> = [];
    const svc = make(scripted([{ t: 'think', text: 'hm' }, { t: 'delta', text: 'Hello ' }, { t: 'delta', text: 'there' }, { t: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }, { t: 'done' }], seen));
    const chat = svc.create(owner, { route: 'text', tier: 'internal', settings: { temperature: 0.4, system: 'Be kind.' } });
    const events = await collect(svc.send(owner, { chat: chat.id, text: 'say hello to the world please' }));
    expect(events.map(e => e.t)).toEqual(['start', 'think', 'delta', 'delta', 'usage', 'title', 'done']);
    const done = events.at(-1) as Extract<ChatEvent, { t: 'done' }>;
    expect(done.message.text).toBe('Hello there');
    expect(done.message.reasoning).toBe('hm');
    expect(done.message.state).toBe('done');
    const sent = JSON.parse(seen[0]!.stdin);
    expect(sent.system).toBe('Be kind.');
    expect(sent.body).toEqual({ temperature: 0.4 });
    expect(sent.messages).toEqual([{ role: 'user', text: 'say hello to the world please', files: [] }]);
    expect(svc.get(owner, chat.id)!.title).toBe('say hello to the world please');
  });

  it('answers an existing message again as a new branch', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }]));
    const chat = svc.create(owner, { route: 'text', tier: 'internal' });
    const first = await collect(svc.send(owner, { chat: chat.id, text: 'q' }));
    const user = (first[0] as Extract<ChatEvent, { t: 'start' }>).user;
    await collect(svc.send(owner, { chat: chat.id, retry: user.id, text: '' }));
    const tree = svc.get(owner, chat.id)!.tree;
    expect(tree.filter(m => m.parent === user.id).length).toBe(2);
  });

  it('records a failed reply as an error state', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'par' }, { t: 'error', message: 'HTTP 500' }]));
    const chat = svc.create(owner, { route: 'text', tier: 'internal' });
    const events = await collect(svc.send(owner, { chat: chat.id, text: 'q' }));
    expect(events.some(e => e.t === 'error')).toBe(true);
    const done = events.at(-1) as Extract<ChatEvent, { t: 'done' }>;
    expect(done.message.state).toBe('error');
    expect(done.message.text).toBe('par');
  });

  it('remembers a stop during discovery and clears it before a later send', async () => {
    const { svc, seen, release } = discovering(), chat = svc.create(owner, { route: 'text', tier: 'internal' });
    expect(svc.stop(owner, chat.id)).toBe(false);
    const stream = svc.send(owner, { chat: chat.id, text: 'q' }), first = stream.next();
    expect(await collect(svc.send(owner, { chat: chat.id, text: 'overlap' }))).toEqual([{ t: 'error', message: 'This chat is already writing a reply.' }]);
    expect(svc.stop(owner, chat.id)).toBe(true);
    expect(svc.stop(owner, chat.id)).toBe(true);
    release();
    expect((await first).value).toMatchObject({ t: 'start' });
    const events = await collect(stream);
    expect(events).toEqual([{ t: 'done', message: expect.objectContaining({ state: 'stopped', text: '' }) }]);
    expect((events[0] as Extract<ChatEvent, { t: 'done' }>).message.usage).toBeUndefined();
    expect(svc.get(owner, chat.id)!.tree.at(-1)).toMatchObject({ state: 'stopped', text: '' });
    expect(seen).toEqual([]);
    expect(svc.stop(owner, chat.id)).toBe(false);
    expect((await collect(svc.send(owner, { chat: chat.id, text: 'next' }))).at(-1)).toMatchObject({ t: 'done', message: { state: 'done' } });
    expect(seen).toHaveLength(1);
  });

  it.each(['remove', 'purge', 'orphan', 'close'] as const)('prevents a reply after %s during discovery', async action => {
    const { svc, seen, release } = discovering(), alice = { kind: 'user', user: 'alice' } as const;
    stores.at(-1)!.addUser({ id: 'alice', name: 'Alice', models: ['text'] });
    const chat = svc.create(alice, { route: 'text' }), events = collect(svc.send(alice, { chat: chat.id, text: 'q' }));
    if (action === 'remove') expect(svc.remove(alice, chat.id)).toBe(true);
    else if (action === 'close') { svc.close(); services.splice(services.indexOf(svc), 1); }
    else svc[action](owner, 'alice');
    release();
    if (action === 'close') expect(await events).toEqual([]);
    else expect(await events).toEqual([{ t: 'error', message: 'No such chat.' }]);
    expect(seen).toEqual([]);
  });

  it('clears a remembered stop when access is revoked during discovery', async () => {
    const { svc, seen, release } = discovering(), alice = { kind: 'user', user: 'alice' } as const, users = stores.at(-1)!;
    users.addUser({ id: 'alice', name: 'Alice', models: ['text'], dailyMessages: 1 });
    const chat = svc.create(alice, { route: 'text' }), events = collect(svc.send(alice, { chat: chat.id, text: 'q' }));
    expect(svc.stop(alice, chat.id)).toBe(true);
    users.updateUser('alice', { models: [] });
    release();
    expect(await events).toEqual([{ t: 'error', message: 'This user cannot use that route.' }]);
    expect(seen).toEqual([]);
    expect(svc.stop(alice, chat.id)).toBe(false);
    users.updateUser('alice', { models: ['text'] });
    expect((await collect(svc.send(alice, { chat: chat.id, text: 'next' }))).at(-1)).toMatchObject({ t: 'done', message: { state: 'done' } });
  });

  it('clears a remembered stop when the reader ends the stream at its start event', async () => {
    const { svc, release } = discovering(), chat = svc.create(owner, { route: 'text', tier: 'internal' });
    const stream = svc.send(owner, { chat: chat.id, text: 'q' }), first = stream.next();
    expect(svc.stop(owner, chat.id)).toBe(true);
    release();
    expect((await first).value).toMatchObject({ t: 'start' });
    await stream.return(undefined);
    expect(svc.stop(owner, chat.id)).toBe(false);
    expect(svc.get(owner, chat.id)!.tree.at(-1)?.state).toBe('stopped');
    expect((await collect(svc.send(owner, { chat: chat.id, text: 'next' }))).at(-1)).toMatchObject({ t: 'done', message: { state: 'done' } });
  });

  it.each(['remove', 'purge', 'orphan', 'close'] as const)('stops the provider on %s during a reply', async action => {
    let stopped = 0;
    const svc = make(() => ({ events: (async function* () { yield { t: 'done' }; })(), stop() { stopped++; } }));
    const alice = { kind: 'user', user: 'alice' } as const;
    stores.at(-1)!.addUser({ id: 'alice', name: 'Alice', models: ['text'] });
    const chat = svc.create(alice, { route: 'text' }), stream = svc.send(alice, { chat: chat.id, text: 'q' });
    expect((await stream.next()).value).toMatchObject({ t: 'start' });
    if (action === 'remove') svc.remove(alice, chat.id);
    else if (action === 'close') { svc.close(); services.splice(services.indexOf(svc), 1); }
    else svc[action](owner, 'alice');
    expect(stopped).toBe(1);
    const events = await collect(stream);
    if (action === 'orphan') expect(events.at(-1)).toMatchObject({ t: 'done', message: { state: 'stopped' } });
    else expect(events).toEqual([]);
  });

  it('refuses a tier the model is not cleared for, and a tier drop once messages exist', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }]));
    expect(() => svc.create(owner, { route: 'text', tier: 'regulated' })).toThrow();
    const chat = svc.create(owner, { route: 'text', tier: 'internal' });
    await collect(svc.send(owner, { chat: chat.id, text: 'q' }));
    expect(() => svc.update(owner, chat.id, { tier: 'public' })).toThrow(/lower data tier/);
    expect(svc.update(owner, chat.id, { pinned: true }).pinned).toBe(true);
  });

  it('keeps temporary chats in memory only and refuses images for a model that cannot see', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }]), { text: route({ vision: false }) });
    const chat = svc.create(owner, { route: 'text', tier: 'internal', temporary: true });
    expect(svc.list(owner).find(c => c.id === chat.id)?.temporary).toBe(true);
    expect(svc.saved.get(chat.id)).toBeNull();
    const f = svc.upload(owner, chat.id, 'pic.png', 'image/png', new Uint8Array([1, 2, 3]));
    const events = await collect(svc.send(owner, { chat: chat.id, text: 'look', files: [f.id] }));
    expect(events.some(e => e.t === 'error' && /cannot see images/.test(e.message))).toBe(true);
  });

  it('stops uploads at a per-person total and frees the room when a chat is removed', () => {
    const svc = make(scripted([]));
    svc.limits.userFilesBytes = 10;
    const a = svc.create(owner, { route: 'text', tier: 'internal' }), b = svc.create(owner, { route: 'text', tier: 'internal' });
    svc.upload(owner, a.id, 'a.txt', 'text/plain', new Uint8Array(6));
    expect(() => svc.upload(owner, b.id, 'b.txt', 'text/plain', new Uint8Array(5))).toThrow(/at most/);
    svc.upload(owner, b.id, 'b.txt', 'text/plain', new Uint8Array(4));
    svc.remove(owner, a.id);
    svc.upload(owner, b.id, 'c.txt', 'text/plain', new Uint8Array(6));
  });

  it('refuses a message that is too long and a chat that has grown past its limit', async () => {
    const svc = make(scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }]));
    svc.limits.messageBytes = 8;
    const chat = svc.create(owner, { route: 'text', tier: 'internal' });
    const long = await collect(svc.send(owner, { chat: chat.id, text: 'x'.repeat(9) }));
    expect(long).toEqual([{ t: 'error', message: expect.stringMatching(/at most/) }]);
    svc.limits.chatMessages = 2;
    const first = await collect(svc.send(owner, { chat: chat.id, text: 'hi' }));
    expect(first.at(-1)!.t).toBe('done');
    const second = await collect(svc.send(owner, { chat: chat.id, text: 'again' }));
    expect(second).toEqual([{ t: 'error', message: expect.stringMatching(/length limit/) }]);
  });

  it('cleans uploaded names and sorts files by kind', () => {
    const svc = make(scripted([]));
    const chat = svc.create(owner, { route: 'text', tier: 'internal' });
    const f = svc.upload(owner, chat.id, '..\\evil/<name>.txt', '', new Uint8Array([65]));
    expect(f.name).not.toMatch(/[\\/<>]/);
    expect(f.kind).toBe('text');
    expect(() => svc.upload(owner, chat.id, 'x', '', new Uint8Array())).toThrow(/empty/);
    expect(classifyFile('a.mp3', '').kind).toBe('audio');
    expect(classifyFile('a.bin', '').kind).toBe('file');
    expect(titleFrom('   ')).toBe('New chat');
  });
});


describe('chat principals', () => {
  const alice = { kind: 'user', user: 'alice' } as const, bob = { kind: 'user', user: 'bob' } as const;
  const ready = (now?: () => number, routes?: Record<string, RouteConfig>) => {
    const seen: Array<{ args: string[]; stdin: string }> = [], svc = make(scripted([{ t: 'delta', text: 'ok' }, { t: 'done' }], seen), routes, now), users = stores.at(-1)!;
    users.addUser({ id: 'alice', name: 'Alice', models: ['text'] });
    users.addUser({ id: 'bob', name: 'Bob', models: ['text'] });
    return { svc, users, seen };
  };

  it('isolates saved and temporary chats, search, mutations, and files from every other principal', async () => {
    const { svc } = ready();
    for (const temporary of [false, true]) {
      const chat = svc.create(alice, { route: 'text', title: 'Alice private', temporary });
      const file = svc.upload(alice, chat.id, 'private.txt', 'text/plain', new Uint8Array([65]));
      await collect(svc.send(alice, { chat: chat.id, text: 'private content', files: [file.id] }));
      expect(svc.get(alice, chat.id)?.temporary).toBe(temporary);
      expect(Array.from(svc.file(alice, file.id)!.bytes)).toEqual([65]);
      for (const other of [owner, bob]) {
        expect(svc.list(other)).toEqual([]);
        expect(svc.search(other, 'private')).toEqual([]);
        expect(svc.get(other, chat.id)).toBeNull();
        expect(svc.file(other, file.id)).toBeNull();
        expect(() => svc.update(other, chat.id, { title: 'Changed' })).toThrow('No such chat.');
        expect(() => svc.remove(other, chat.id)).toThrow('No such chat.');
        expect(() => svc.stop(other, chat.id)).toThrow('No such chat.');
        expect(() => svc.upload(other, chat.id, 'x.txt', '', new Uint8Array([66]))).toThrow('No such chat.');
        expect(await collect(svc.send(other, { chat: chat.id, text: 'q' }))).toEqual([{ t: 'error', message: 'No such chat.' }]);
      }
    }
    const own = svc.create(owner, { route: 'text', tier: 'internal' });
    expect(svc.get(alice, own.id)).toBeNull();
    expect(svc.list(alice)).toHaveLength(2);
    expect(svc.search(alice, 'content')).toHaveLength(2);
  });

  it('narrows grants by the rules and rechecks grants and tier caps before each send', async () => {
    const { svc, users } = ready(undefined, { text: route(), other: route(), refused: { ...route(), model: 'test/unknown' } });
    users.updateUser('alice', { models: [] });
    expect(await svc.models(alice)).toEqual([]);
    expect(() => svc.create(alice, { route: 'text' })).toThrow(/cannot use/);
    users.updateUser('alice', { models: ['text', 'refused'] });
    expect((await svc.models(alice)).map(r => r.route)).toEqual(['text']);
    expect((await svc.models(owner)).find(r => r.route === 'refused')?.usable).toBe(false);
    expect(() => svc.create(alice, { route: 'refused' })).toThrow();
    expect(() => svc.create(alice, { route: 'other' })).toThrow(/cannot use/);
    expect(() => svc.create(alice, { route: 'text', tier: 'sensitive' })).toThrow(/tier cap/);
    const chat = svc.create(alice, { route: 'text' });
    expect(chat.tier).toBe('internal');
    expect(() => svc.update(alice, chat.id, { route: 'other' })).toThrow(/cannot use/);
    expect(() => svc.update(alice, chat.id, { tier: 'sensitive' })).toThrow(/tier cap/);
    expect(await collect(svc.send(alice, { chat: chat.id, text: 'q', route: 'other' }))).toEqual([expect.objectContaining({ t: 'error', message: expect.stringMatching(/cannot use/) })]);
    users.updateUser('alice', { tierCap: 'public' });
    expect(await collect(svc.send(alice, { chat: chat.id, text: 'q' }))).toEqual([expect.objectContaining({ t: 'error', message: expect.stringMatching(/tier cap/) })]);
    users.updateUser('alice', { tierCap: 'internal', models: [] });
    expect(await collect(svc.send(alice, { chat: chat.id, text: 'q' }))).toEqual([expect.objectContaining({ t: 'error', message: expect.stringMatching(/cannot use/) })]);
    expect(svc.get(alice, chat.id)!.tree).toEqual([]);
  });

  it('shows a provider error body to the owner and only the status to everyone else', async () => {
    const svc = make(scripted([{ t: 'error', message: 'HTTP 401: {"error":"org-123 is out of credit"}' }]));
    stores.at(-1)!.addUser({ id: 'alice', name: 'Alice', models: ['text'] });
    const message = async (who: typeof owner | typeof alice) => {
      const chat = svc.create(who, { route: 'text', tier: 'internal' });
      return (await collect(svc.send(who, { chat: chat.id, text: 'q' }))).find(e => e.t === 'error') as Extract<ChatEvent, { t: 'error' }>;
    };
    expect((await message(owner)).message).toMatch(/org-123/);
    const shown = (await message(alice)).message;
    expect(shown).toMatch(/^HTTP 401: the provider refused/);
    expect(shown).not.toMatch(/org-123/);
  });

  it('counts saved and temporary sends from local midnight and guards concurrent sends', async () => {
    let at = new Date(2026, 10, 2, 23, 59).getTime();
    const { svc, users } = ready(() => at);
    users.updateUser('alice', { dailyMessages: 1 });
    const saved = svc.create(alice, { route: 'text' }), temp = svc.create(alice, { route: 'text', temporary: true });
    const events = await Promise.all([collect(svc.send(alice, { chat: saved.id, text: 'saved' })), collect(svc.send(alice, { chat: temp.id, text: 'temp' }))]);
    expect(events.flat().filter(e => e.t === 'start')).toHaveLength(1);
    expect(events.flat().filter(e => e.t === 'error')).toEqual([expect.objectContaining({ message: expect.stringMatching(/daily message limit/) })]);
    const user = svc.get(alice, saved.id)!.tree.find(m => m.role === 'user')!;
    expect(await collect(svc.send(alice, { chat: saved.id, retry: user.id, text: '' }))).toEqual([expect.objectContaining({ message: expect.stringMatching(/daily message limit/) })]);
    at = new Date(2026, 10, 3, 0, 1).getTime();
    expect((await collect(svc.send(alice, { chat: temp.id, text: 'new day' }))).some(e => e.t === 'done')).toBe(true);
    expect(await collect(svc.send(alice, { chat: saved.id, text: 'over' }))).toEqual([expect.objectContaining({ message: expect.stringMatching(/daily message limit/) })]);
    const other = svc.create(bob, { route: 'text' });
    expect((await collect(svc.send(bob, { chat: other.id, text: 'q' }))).some(e => e.t === 'done')).toBe(true);
  });

  it.each(['remove', 'purge', 'orphan'] as const)('retains saved and temporary usage after %s', async action => {
    const { svc, users } = ready();
    users.updateUser('alice', { dailyMessages: 2 });
    for (const temporary of [false, true]) {
      const chat = svc.create(alice, { route: 'text', temporary });
      expect((await collect(svc.send(alice, { chat: chat.id, text: 'q' }))).at(-1)).toMatchObject({ t: 'done' });
      if (action === 'remove') svc.remove(alice, chat.id);
    }
    if (action !== 'remove') svc[action](owner, 'alice');
    const chat = svc.create(alice, { route: 'text' });
    expect(await collect(svc.send(alice, { chat: chat.id, text: 'over' }))).toEqual([{ t: 'error', message: 'This user has reached the daily message limit.' }]);
    expect(svc.get(alice, chat.id)!.tree).toEqual([]);
  });

  it.each([false, true])('counts each retry without adding another user row (temporary: %s)', async temporary => {
    const { svc, users, seen } = ready();
    users.updateUser('alice', { dailyMessages: 3 });
    const chat = svc.create(alice, { route: 'text', temporary });
    const first = await collect(svc.send(alice, { chat: chat.id, text: 'q' }));
    const user = (first[0] as Extract<ChatEvent, { t: 'start' }>).user;
    for (let n = 0; n < 2; n++) expect((await collect(svc.send(alice, { chat: chat.id, retry: user.id, text: '' }))).at(-1)).toMatchObject({ t: 'done' });
    expect(await collect(svc.send(alice, { chat: chat.id, retry: user.id, text: '' }))).toEqual([{ t: 'error', message: 'This user has reached the daily message limit.' }]);
    expect(svc.get(alice, chat.id)!.tree.filter(m => m.role === 'user')).toHaveLength(1);
    expect(seen).toHaveLength(3);
    users.updateUser('alice', { dailyMessages: 4 });
    expect((await collect(svc.send(alice, { chat: chat.id, retry: user.id, text: '' }))).at(-1)).toMatchObject({ t: 'done' });
    expect(seen).toHaveLength(4);
  });

  it('counts unlimited user sends, excludes owner sends, and retains temporary usage on reopen', async () => {
    const { svc, users } = ready(() => 1000), chat = svc.create(alice, { route: 'text', temporary: true });
    await collect(svc.send(alice, { chat: chat.id, text: 'q' }));
    const own = svc.create(owner, { route: 'text', tier: 'internal' });
    await collect(svc.send(owner, { chat: own.id, text: 'owner' }));
    const midnight = new Date(1000); midnight.setHours(0, 0, 0, 0);
    expect(svc.saved.dailyUsage('alice', midnight.getTime())).toBe(1);
    expect(svc.saved.dailyUsage('', midnight.getTime())).toBe(0);
    svc.close(); services.splice(services.indexOf(svc), 1);
    users.updateUser('alice', { dailyMessages: 1 });
    const env = envs.at(-1)!, policy = policySource(join(env.home, 'policy.json'));
    const reopened = new ChatService({ users, now: () => 1000, dir: env.dir, routes: () => ({ text: route() }), adapters: new Set(['openai-api']), policy: () => policy.read(), usage: () => null, log: () => undefined, caller: scripted([]) });
    services.push(reopened);
    expect(reopened.list(alice)).toEqual([]);
    const next = reopened.create(alice, { route: 'text' });
    expect(await collect(reopened.send(alice, { chat: next.id, text: 'over' }))).toEqual([{ t: 'error', message: 'This user has reached the daily message limit.' }]);
  });

  it('does not count sends rejected by access or invalid input', async () => {
    const { svc, users, seen } = ready();
    users.updateUser('alice', { dailyMessages: 1 });
    const chat = svc.create(alice, { route: 'text' });
    users.updateUser('alice', { models: [] });
    expect(await collect(svc.send(alice, { chat: chat.id, text: 'q' }))).toEqual([{ t: 'error', message: 'This user cannot use that route.' }]);
    users.updateUser('alice', { models: ['text'] });
    expect(await collect(svc.send(alice, { chat: chat.id, text: '' }))).toEqual([{ t: 'error', message: 'There is nothing to send.' }]);
    expect(await collect(svc.send(alice, { chat: chat.id, retry: 'missing', text: '' }))).toEqual([{ t: 'error', message: 'That message cannot be answered again.' }]);
    expect((await collect(svc.send(alice, { chat: chat.id, text: 'accepted' }))).at(-1)).toMatchObject({ t: 'done' });
    expect(seen).toHaveLength(1);
  });

  it('refuses disabled users on every operation and revoked devices on existing principals', async () => {
    const { svc, users } = ready(), chat = svc.create(alice, { route: 'text' });
    const file = svc.upload(alice, chat.id, 'a.txt', 'text/plain', new Uint8Array([65]));
    const d = users.addDevice('alice', 'Phone'), device = { ...alice, device: d.device.id };
    expect(svc.get(device, chat.id)?.id).toBe(chat.id);
    users.revokeDevice('alice', d.device.id);
    expect(() => svc.get(device, chat.id)).toThrow(/device cannot chat/);
    users.updateUser('alice', { disabled: true });
    const calls = [() => svc.me(alice), () => svc.list(alice), () => svc.search(alice, 'x'), () => svc.get(alice, chat.id), () => svc.create(alice, { route: 'text' }), () => svc.update(alice, chat.id, {}), () => svc.remove(alice, chat.id), () => svc.stop(alice, chat.id), () => svc.upload(alice, chat.id, 'x', '', new Uint8Array([1])), () => svc.file(alice, file.id)];
    for (const call of calls) expect(call).toThrow(/user cannot chat/);
    await expect(svc.models(alice)).rejects.toThrow(/user cannot chat/);
    expect(await collect(svc.send(alice, { chat: chat.id, text: 'q' }))).toEqual([expect.objectContaining({ message: expect.stringMatching(/user cannot chat/) })]);
    expect(() => svc.purge(alice, 'bob')).toThrow(/Only the owner/);
  });

  it('keeps a foreign attachment out of a reply and purges only the selected user', async () => {
    const { svc, seen } = ready(), a = svc.create(alice, { route: 'text' }), b = svc.create(bob, { route: 'text' });
    const f = svc.upload(alice, a.id, 'private.txt', 'text/plain', new Uint8Array([65]));
    await collect(svc.send(bob, { chat: b.id, text: 'q', files: [f.id] }));
    expect(JSON.parse(seen[0]!.stdin).messages[0].files).toEqual([]);
    svc.create(alice, { route: 'text', temporary: true });
    svc.purge(owner, 'alice');
    expect(svc.list(alice)).toEqual([]);
    expect(svc.file(alice, f.id)).toBeNull();
    expect(svc.get(bob, b.id)?.id).toBe(b.id);
  });

  it('retains orphaned history and files without granting them to a reused user id', async () => {
    const { svc, users } = ready(), chat = svc.create(alice, { route: 'text' });
    const f = svc.upload(alice, chat.id, 'private.txt', 'text/plain', new Uint8Array([65]));
    await collect(svc.send(alice, { chat: chat.id, text: 'private' }));
    const temporary = svc.create(alice, { route: 'text', temporary: true });
    expect(() => svc.orphan(bob, 'alice')).toThrow(/Only the owner/);
    svc.orphan(owner, 'alice');
    users.removeUser('alice');
    users.addUser({ id: 'alice', name: 'New user', models: ['text'] });
    expect(svc.list(alice)).toEqual([]);
    expect(svc.get(alice, chat.id)).toBeNull();
    expect(svc.get(alice, temporary.id)).toBeNull();
    expect(svc.file(alice, f.id)).toBeNull();
    const env = envs.at(-1)!, db = new DatabaseSync(join(env.dir, 'chat.db'));
    try { expect((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chat.id) as { n: number }).n).toBe(2); } finally { db.close(); }
    expect(existsSync(join(env.dir, 'chat-files', f.id))).toBe(true);
  });

  it('protects an active reply from other principals and rejects overlapping sends', async () => {
    let stopped = 0;
    const svc = make(() => ({ events: (async function* () { yield { t: 'delta', text: 'ok' }; yield { t: 'done' }; })(), stop() { stopped++; } })), users = stores.at(-1)!;
    users.addUser({ id: 'alice', name: 'Alice', models: ['text'] });
    users.addUser({ id: 'bob', name: 'Bob', models: ['text'] });
    users.updateUser('alice', { dailyMessages: 2 });
    const chat = svc.create(alice, { route: 'text' }), stream = svc.send(alice, { chat: chat.id, text: 'q' });
    expect((await stream.next()).value).toMatchObject({ t: 'start' });
    expect(await collect(svc.send(alice, { chat: chat.id, text: 'second' }))).toEqual([{ t: 'error', message: 'This chat is already writing a reply.' }]);
    for (const other of [owner, bob]) {
      expect(() => svc.stop(other, chat.id)).toThrow('No such chat.');
      expect(() => svc.remove(other, chat.id)).toThrow('No such chat.');
    }
    expect(stopped).toBe(0);
    expect(svc.stop(alice, chat.id)).toBe(true);
    expect(stopped).toBe(1);
    const events = await collect(stream);
    expect(events.at(-1)).toMatchObject({ t: 'done', message: { state: 'stopped' } });
    expect((await collect(svc.send(alice, { chat: chat.id, text: 'next' }))).at(-1)).toMatchObject({ t: 'done' });
    expect(await collect(svc.send(alice, { chat: chat.id, text: 'over' }))).toEqual([{ t: 'error', message: 'This user has reached the daily message limit.' }]);
  });
});
