import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineApi } from '@augur/core';
import type { RouteConfig } from '@augur/dispatch-protocol';
import { ChatService, type Caller } from '../src/chat/service.js';
import { DEFAULT_CONFIG } from '../src/config.js';
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

async function serve() {
  const env: Env = makeEnv();
  env.writePolicy();
  const policy = policySource(join(env.home, 'policy.json'));
  const chat = new ChatService({ dir: env.dir, routes: () => ({ text: route }), adapters: new Set(['openai-api']), policy: () => policy.read(), usage: () => null, log: () => undefined, caller });
  const engine = { api: { state: { config: {}, secrets: [], resets: [] }, onChange: () => () => undefined } as unknown as EngineApi, views: new ViewHub() };
  const server = new WebServer({ settings: { ...DEFAULT_CONFIG.web, port: 0 }, engine: () => engine, token: () => TOKEN, staticDir: null, log: () => undefined, chat });
  await server.start();
  closers.push(async () => { await server.close(); chat.close(); env.dispose(); });
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
