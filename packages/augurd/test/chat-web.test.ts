import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineApi } from '@augur/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ChatDeviceCreated, ChatUserCreated, RouteConfig } from '@augur/dispatch-protocol';
import { ChatService, type Caller } from '../src/chat/service.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { UserStore } from '../src/chat/users.js';
import { policySource } from '../src/sources.js';
import { ViewHub } from '../src/views.js';
import { WebServer } from '../src/web.js';
import { makeEnv, type Env } from './harness.js';

const TOKEN = 'b'.repeat(64), auth = { Authorization: `Bearer ${TOKEN}` }, json = { ...auth, 'Content-Type': 'application/json' };
const CALL = fileURLToPath(new URL('../src/chat/call.ts', import.meta.url));
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const route = { model: 'test/text', adapter: 'openai-api', options: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKeyEnv: 'CHAT_TEST_KEY' } } as RouteConfig;
const caller: Caller = () => ({ events: (async function* () { yield { t: 'delta', text: 'hi' }; yield { t: 'done' }; })(), stop() { /* done */ } });

async function serve(scope: 'full' | 'chat' = 'full', pages = false) {
  const env: Env = makeEnv();
  env.writePolicy();
  const policy = policySource(join(env.home, 'policy.json'));
  if (pages) { mkdirSync(join(env.dir, 'chat')); writeFileSync(join(env.dir, 'chat', 'index.html'), '<head></head>chat page'); writeFileSync(join(env.dir, 'index.html'), '<head></head>owner page'); }
  const users = new UserStore(null);
  const chat = new ChatService({ users, dir: env.dir, routes: () => ({ text: route }), adapters: new Set(['openai-api']), policy: () => policy.read(), usage: () => null, log: () => undefined, caller });
  const engine = { api: { state: { config: {}, secrets: [], resets: [] }, onChange: () => () => undefined } as unknown as EngineApi, views: new ViewHub() };
  const server = new WebServer({ users, scope, settings: { ...DEFAULT_CONFIG.web, port: 0 }, engine: () => engine, token: () => TOKEN, staticDir: pages ? env.dir : null, log: () => undefined, chat });
  await server.start();
  closers.push(async () => { await server.close(); chat.close(); users.close(); env.dispose(); });
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  return `http://127.0.0.1:${port}`;
}

describe('chat web routes', () => {
  it('refuses a call with no token', async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/chat/models`)).status).toBe(401);
  });

  it('creates, lists, streams, renames, and removes a chat', async () => {
    const base = await serve();
    const models = await (await fetch(`${base}/api/chat/models`, { headers: auth })).json() as { models: Array<{ route: string }> };
    expect(models.models.map(m => m.route)).toEqual(['text']);
    const made = await (await fetch(`${base}/api/chat/chats`, { method: 'POST', headers: json, body: JSON.stringify({ route: 'text', tier: 'internal' }) })).json() as { id: string };
    const res = await fetch(`${base}/api/chat/send`, { method: 'POST', headers: json, body: JSON.stringify({ chat: made.id, text: 'hello there' }) });
    expect(res.headers.get('content-type')).toContain('ndjson');
    const events = (await res.text()).trim().split('\n').map(l => JSON.parse(l) as { t: string });
    expect(events.map(e => e.t)).toEqual(['start', 'delta', 'title', 'done']);
    const detail = await (await fetch(`${base}/api/chat/chats/${made.id}`, { headers: auth })).json() as { title: string; tree: unknown[] };
    expect(detail.title).toBe('hello there');
    expect(detail.tree.length).toBe(2);
    const found = await (await fetch(`${base}/api/chat/chats?q=hello`, { headers: auth })).json() as { chats: Array<{ id: string }> };
    expect(found.chats.map(c => c.id)).toEqual([made.id]);
    const patched = await (await fetch(`${base}/api/chat/chats/${made.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ pinned: true, title: 'Kept' }) })).json() as { pinned: boolean; title: string };
    expect(patched).toMatchObject({ pinned: true, title: 'Kept' });
    expect((await (await fetch(`${base}/api/chat/chats/${made.id}`, { method: 'DELETE', headers: auth })).json() as { removed: boolean }).removed).toBe(true);
    expect((await fetch(`${base}/api/chat/chats/${made.id}`, { headers: auth })).status).toBe(404);
  });

  it('serves an upload back, and never inline when it is a page or a vector image', async () => {
    const base = await serve();
    const made = await (await fetch(`${base}/api/chat/chats`, { method: 'POST', headers: json, body: JSON.stringify({ route: 'text', tier: 'internal' }) })).json() as { id: string };
    const up = async (name: string, type: string, body: string) => (await (await fetch(`${base}/api/chat/chats/${made.id}/files`, { method: 'POST', headers: { ...auth, 'Content-Type': type, 'x-file-name': encodeURIComponent(name) }, body })).json()) as { id: string };
    const png = await up('a.png', 'image/png', 'xyz'), html = await up('page.html', 'text/html', '<script>1</script>'), svg = await up('v.svg', 'image/svg+xml', '<svg/>');
    const get = (id: string) => fetch(`${base}/api/chat/files/${id}`, { headers: auth });
    expect((await get(png.id)).headers.get('content-disposition')).toMatch(/^inline/);
    for (const f of [html, svg]) {
      const r = await get(f.id);
      expect(r.headers.get('content-disposition')).toMatch(/^attachment/);
      expect(r.headers.get('content-type')).not.toMatch(/html|svg/);
    }
    expect((await fetch(`${base}/api/chat/chats/${made.id}/files`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '' })).status).toBe(400);
  });
});

const requestChat = (base: string, path: string, secret = TOKEN, method = 'GET', body?: unknown) => fetch(`${base}/api/${path}`, {
  method, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const addUser = async (base: string, id = 'alice', fields: Record<string, unknown> = {}) => {
  const res = await requestChat(base, 'admin/chat/users', TOKEN, 'POST', { id, name: id, models: ['text'], ...fields });
  expect(res.status).toBe(200);
  return res.json() as Promise<ChatUserCreated>;
};
const createChat = async (base: string, secret: string, temporary = false) => {
  const res = await requestChat(base, 'chat/chats', secret, 'POST', { route: 'text', tier: 'internal', temporary, title: 'private title' });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ id: string }>;
};

describe('chat user API', () => {
  it('provides one-time credentials, identity, and owner route verdicts', async () => {
    const base = await serve(), made = await addUser(base, 'alice', { email: 'Alice@Example.com' });
    expect(/^augc_[A-Za-z0-9_-]{43}$/.test(made.token)).toBe(true);
    expect(await (await requestChat(base, 'chat/me')).json()).toEqual({ kind: 'owner' });
    expect(await (await requestChat(base, 'chat/me', made.token)).json()).toEqual({ kind: 'user', user: { id: 'alice', name: 'alice', models: ['text'], tierCap: 'internal', dailyMessages: null } });
    const list = await (await requestChat(base, 'admin/chat/users')).text();
    expect(list).not.toMatch(/token|hash/);
    expect(JSON.parse(list).users[0]).toMatchObject({ email: 'alice@example.com', devices: [] });
    const routes = await (await requestChat(base, 'admin/chat/routes')).json() as { routes: Array<{ route: string; usable: boolean }> };
    expect(routes.routes).toEqual([expect.objectContaining({ route: 'text', usable: true })]);
    const device = await (await requestChat(base, 'admin/chat/users/alice/devices', TOKEN, 'POST', { label: 'Phone' })).json() as ChatDeviceCreated;
    expect(await (await requestChat(base, 'chat/me', device.token)).json()).toMatchObject({ kind: 'user', device: device.device.id });
    expect((await (await requestChat(base, 'admin/chat/users')).text())).not.toMatch(/token|hash/);
  });

  it('rejects user and device credentials outside chat and counts the same failure lockout', async () => {
    const base = await serve(), made = await addUser(base);
    const d = await (await requestChat(base, 'admin/chat/users/alice/devices', TOKEN, 'POST', { label: 'Phone' })).json() as ChatDeviceCreated;
    const paths = ['watch', 'resets', 'call', 'dispatch', 'admin/chat/users', 'admin/chat/routes', 'admin/other'];
    for (const secret of [made.token, d.token]) {
      for (const path of paths) {
        expect((await requestChat(base, 'chat/me', secret)).status).toBe(200);
        const res = await requestChat(base, path, secret, path === 'call' || path === 'dispatch' ? 'POST' : 'GET', path === 'call' || path === 'dispatch' ? {} : undefined);
        expect(res.status).toBe(401);
        expect(await res.text()).toBe('Missing or wrong token.');
      }
    }
    for (let n = 0; n < 10; n++) expect((await requestChat(base, 'resets', n % 2 ? 'wrong' : made.token)).status).toBe(401);
    expect((await requestChat(base, 'chat/me', made.token)).status).toBe(429);
    expect((await requestChat(base, 'chat/me')).status).toBe(429);
  });

  it('isolates chats, mutations, streams, and uploads between users and the owner', async () => {
    const base = await serve(), a = await addUser(base), b = await addUser(base, 'bob');
    for (const temporary of [false, true]) {
      const chat = await createChat(base, a.token, temporary);
      const up = await fetch(`${base}/api/chat/chats/${chat.id}/files`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'text/plain', 'x-file-name': 'private.txt' }, body: 'private attachment' });
      const f = await up.json() as { id: string };
      expect((await requestChat(base, `chat/files/${f.id}`, a.token)).status).toBe(200);
      expect((await requestChat(base, 'chat/send', a.token, 'POST', { chat: chat.id, text: 'private message' })).status).toBe(200);
      for (const other of [TOKEN, b.token]) {
        expect(await (await requestChat(base, 'chat/chats', other)).json()).toEqual({ chats: [] });
        expect(await (await requestChat(base, 'chat/chats?q=private', other)).json()).toEqual({ chats: [] });
        for (const [path, method, body] of [
          [`chat/chats/${chat.id}`, 'GET', undefined], [`chat/chats/${chat.id}`, 'PATCH', { title: 'changed' }],
          [`chat/chats/${chat.id}`, 'DELETE', undefined], [`chat/chats/${chat.id}/stop`, 'POST', undefined],
          [`chat/chats/${chat.id}/files`, 'POST', {}], [`chat/files/${f.id}`, 'GET', undefined],
          ['chat/send', 'POST', { chat: chat.id, text: 'q' }],
        ] as const) {
          const res = await requestChat(base, path, other, method, body);
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: 'No such chat.' });
        }
      }
    }
    const own = await createChat(base, TOKEN);
    expect((await requestChat(base, `chat/chats/${own.id}`, a.token)).status).toBe(404);
  });

  it('applies allowlist, tier cap, daily limit, and admin validation', async () => {
    const base = await serve(), made = await addUser(base, 'alice', { models: [] });
    expect(await (await requestChat(base, 'chat/models', made.token)).json()).toEqual({ models: [] });
    expect((await requestChat(base, 'chat/chats', made.token, 'POST', { route: 'text', tier: 'internal' })).status).toBe(400);
    expect((await requestChat(base, 'admin/chat/users/alice', TOKEN, 'PATCH', { models: ['text'], dailyMessages: 1 })).status).toBe(200);
    expect((await requestChat(base, 'chat/chats', made.token, 'POST', { route: 'text', tier: 'sensitive' })).status).toBe(400);
    const chat = await createChat(base, made.token);
    const send = () => requestChat(base, 'chat/send', made.token, 'POST', { chat: chat.id, text: 'q' });
    expect(await (await send()).text()).toContain('"t":"done"');
    expect(await (await send()).text()).toContain('daily message limit');
    for (const body of [{ email: 'bad' }, { tierCap: 'unknown' }, { dailyMessages: -1 }, { models: ['text', 'text'] }, { disabled: 'yes' }]) expect((await requestChat(base, 'admin/chat/users/alice', TOKEN, 'PATCH', body)).status).toBe(400);
    expect((await requestChat(base, 'admin/chat/users', TOKEN, 'POST', { id: 'Bad', name: 'bad' })).status).toBe(400);
    expect((await requestChat(base, 'admin/chat/users/missing', TOKEN, 'PATCH', { name: 'name' })).status).toBe(404);
  });

  it('invalidates rotated, revoked, disabled, and removed credentials', async () => {
    const base = await serve(), made = await addUser(base), d = await (await requestChat(base, 'admin/chat/users/alice/devices', TOKEN, 'POST', { label: 'Phone' })).json() as ChatDeviceCreated;
    const rotated = await (await requestChat(base, 'admin/chat/users/alice/token', TOKEN, 'POST')).json() as { token: string };
    expect((await requestChat(base, 'chat/me', made.token)).status).toBe(401);
    expect((await requestChat(base, 'chat/me', rotated.token)).status).toBe(200);
    expect((await requestChat(base, 'chat/me', d.token)).status).toBe(200);
    expect((await requestChat(base, `admin/chat/users/alice/devices/${d.device.id}`, TOKEN, 'DELETE')).status).toBe(200);
    expect((await requestChat(base, 'chat/me', d.token)).status).toBe(401);
    const live = await (await requestChat(base, 'admin/chat/users/alice/devices', TOKEN, 'POST', { label: 'Laptop' })).json() as ChatDeviceCreated;
    await requestChat(base, 'admin/chat/users/alice', TOKEN, 'PATCH', { disabled: true });
    expect((await requestChat(base, 'chat/models', rotated.token)).status).toBe(401);
    expect((await requestChat(base, 'chat/chats', live.token)).status).toBe(401);
    await requestChat(base, 'admin/chat/users/alice', TOKEN, 'PATCH', { disabled: false });
    expect((await requestChat(base, 'chat/me', live.token)).status).toBe(200);
    await requestChat(base, 'admin/chat/users/alice', TOKEN, 'DELETE');
    expect((await requestChat(base, 'chat/me', rotated.token)).status).toBe(401);
    expect((await requestChat(base, 'chat/me', live.token)).status).toBe(401);
  });

  it('preserves orphaned chats unless the owner asks to purge chats and files', async () => {
    const base = await serve(), made = await addUser(base), chat = await createChat(base, made.token);
    await requestChat(base, 'admin/chat/users/alice', TOKEN, 'DELETE');
    expect((await requestChat(base, `chat/chats/${chat.id}`)).status).toBe(404);
    const alice = await addUser(base);
    expect(await (await requestChat(base, 'chat/chats', alice.token)).json()).toEqual({ chats: [] });
    expect((await requestChat(base, `chat/chats/${chat.id}`, alice.token)).status).toBe(404);
    const bob = await addUser(base, 'bob'), b = await createChat(base, bob.token);
    const f = await (await fetch(`${base}/api/chat/chats/${b.id}/files`, { method: 'POST', headers: { Authorization: `Bearer ${bob.token}`, 'Content-Type': 'text/plain' }, body: 'private' })).json() as { id: string };
    await createChat(base, bob.token, true);
    expect((await requestChat(base, 'admin/chat/users/bob?purge=1', TOKEN, 'DELETE')).status).toBe(200);
    const renewed = await addUser(base, 'bob');
    expect(await (await requestChat(base, 'chat/chats', renewed.token)).json()).toEqual({ chats: [] });
    expect((await requestChat(base, `chat/files/${f.id}`, renewed.token)).status).toBe(404);
  });

  it('keeps Host and Origin checks on chat and admin requests', async () => {
    const base = await serve(), made = await addUser(base);
    for (const path of ['chat/me', 'admin/chat/users']) {
      const status = await new Promise<number | undefined>((done, reject) => {
        const req = http.get(`${base}/api/${path}`, { headers: { ...auth, Host: 'attacker.example' } }, res => { res.resume(); done(res.statusCode); });
        req.on('error', reject);
      });
      expect(status).toBe(421);
      expect((await fetch(`${base}/api/${path}`, { headers: { Authorization: `Bearer ${made.token}`, Origin: 'https://attacker.example' } })).status).toBe(403);
    }
  });

  it('limits chat scope to chat pages and chat API routes', async () => {
    const base = await serve('chat', true);
    expect((await requestChat(base, 'chat/me')).status).toBe(200);
    expect(await (await fetch(`${base}/chat/`)).text()).toContain('chat page');
    for (const path of ['/', '/index.html', '/api/watch', '/api/admin/chat/users', '/api/dispatch', '/chat/%2e%2e%2findex.html']) expect((await fetch(base + path, { headers: auth })).status).toBe(404);
  });
});

describe('chat-call', () => {
  const run = (port: number, input: unknown, extra: string[] = []) => new Promise<Array<Record<string, unknown>>>(resolve => {
    const child = spawn(process.execPath, [CALL, '--shape', 'openai', '--url', `http://127.0.0.1:${port}/v1`, '--model', 'm', '--key-env', 'CHAT_TEST_KEY', '--timeout-s', '20', ...extra],
      { env: { ...process.env, CHAT_TEST_KEY: 'secret-key-value' }, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += String(d); });
    child.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)));
    child.stdin.end(JSON.stringify(input));
  });

  it('splits inline think tags and reasoning fields from the answer, and reports usage', async () => {
    let seenAuth = '';
    const srv = http.createServer((req, res) => {
      seenAuth = String(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      chunk({ reasoning_content: 'plan ' }); chunk({ content: '<thi' }); chunk({ content: 'nk>inner</think>The ' }); chunk({ content: 'answer' });
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    closers.push(() => { srv.close(); });
    const lines = await run((srv.address() as { port: number }).port, { system: 's', messages: [{ role: 'user', text: 'q' }], body: {} });
    const joined = (t: string) => lines.filter(l => l.t === t).map(l => l.text).join('');
    expect(joined('delta')).toBe('The answer');
    expect(joined('think')).toBe('plan inner');
    expect(lines.find(l => l.t === 'usage')).toMatchObject({ usage: { inputTokens: 5, outputTokens: 7 } });
    expect(lines.at(-1)).toEqual({ t: 'done' });
    expect(seenAuth).toBe('Bearer secret-key-value');
    expect(JSON.stringify(lines)).not.toContain('secret-key-value');
  }, 30000);

  it('reports an HTTP failure as an error line', async () => {
    const srv = http.createServer((_req, res) => { res.writeHead(401); res.end('nope'); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    closers.push(() => { srv.close(); });
    const lines = await run((srv.address() as { port: number }).port, { messages: [{ role: 'user', text: 'q' }] });
    expect(lines.at(-1)).toMatchObject({ t: 'error' });
    expect(String(lines.at(-1)!.message)).toMatch(/401/);
  }, 30000);
});
