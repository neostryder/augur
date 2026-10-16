import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigFile, createGateway, parseConfig, plan, KeyCache, readKey, consumerOf } from '../src/index.js';
import type { GatewayConfig } from '../src/index.js';

const NOUL = { billing: { type: 'noul', instructions: 'Is this about billing?' } };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const cfg = (over: Record<string, unknown> = {}): GatewayConfig => parseConfig({ usageLog: join(tmpdir(), 'unused.jsonl'), ...over }).config;

describe('plan', () => {
  it('sends a plain request to the hosted alias and replaces the model the caller named', () => {
    const p = plan(cfg(), { model: 'jev-1.13.0', state: 'x', questions: NOUL }, {});
    expect(p.route).toBe('hosted'); expect(p.model).toBe('jev-preview'); expect(p.body.model).toBe('jev-preview'); expect(p.images).toBe(false);
  });
  it('lets a caller keep a pinned id the settings list', () => {
    const p = plan(cfg({ pins: ['jev-1.14.0'] }), { model: 'jev-1.14.0', state: 'x', questions: NOUL }, {});
    expect(p.model).toBe('jev-1.14.0');
  });
  it('asks for the images header on assets and on a Box question, and not otherwise', () => {
    expect(plan(cfg(), { state: 'x', assets: { a: { type: 'image' } }, questions: NOUL }, {}).images).toBe(true);
    expect(plan(cfg(), { state: 'x', questions: { b: { type: 'box', instructions: 'find it' } } }, {}).images).toBe(true);
    expect(plan(cfg(), { state: 'x', assets: {}, questions: NOUL }, {}).images).toBe(false);
  });
  it('reads long context from either header or the body field and drops the body field', () => {
    expect(plan(cfg(), { state: 'x', questions: NOUL }, { 'typesafe-danger-zone-long-context': 'true' }).longContext).toBe(true);
    expect(plan(cfg(), { state: 'x', questions: NOUL }, { 'x-augur-long-context': 'true' }).longContext).toBe(true);
    const p = plan(cfg(), { state: 'x', questions: NOUL, long_context: true }, {});
    expect(p.longContext).toBe(true); expect('long_context' in p.body).toBe(false);
  });
  it('keeps local_only and sensitive requests off the hosted model', () => {
    for (const tier of ['local_only', 'sensitive', 'regulated']) {
      const p = plan(cfg(), { model: 'jev-preview', state: 'x', questions: NOUL }, { 'x-augur-data': tier });
      expect(p.route).toBe('laya'); expect(p.model).toBe('laya'); expect(p.body.model).toBe('laya');
    }
  });
  it('refuses an image or long-context request that must stay local', () => {
    expect(plan(cfg(), { state: 'x', assets: { a: {} }, questions: NOUL }, { 'x-augur-data': 'sensitive' }).refuse?.status).toBe(422);
    expect(plan(cfg(), { state: 'x', questions: NOUL }, { 'x-augur-data': 'sensitive', 'x-augur-long-context': 'true' }).refuse?.status).toBe(422);
  });
  it('treats student wording as regulated when no tier is declared, and trusts a declared tier', () => {
    const body = { state: 'Grade for student essay in ACME-101', questions: NOUL };
    const a = plan(cfg(), body, {});
    expect(a.route).toBe('laya'); expect(a.tier).toBe('regulated'); expect(a.tierSource).toBe('content');
    expect(plan(cfg(), body, { 'x-augur-data': 'internal' }).route).toBe('hosted');
  });
  it('leaves everyday words alone when no tier is declared', () => {
    for (const state of ['Draft a blog post about the course of the project', 'Rubric for the grade report', 'Section 3 of the orion guide']) {
      const p = plan(cfg(), { state, questions: NOUL }, {});
      expect(p.route).toBe('hosted'); expect(p.tierSource).toBe('default');
    }
  });
  it('sends a laya model name to Laya whatever the tier', () => {
    const p = plan(cfg(), { model: 'laya:augur_fit', state: 'x', questions: NOUL }, { 'x-augur-data': 'public' });
    expect(p.route).toBe('laya'); expect(p.model).toBe('laya:augur_fit');
  });
  it('rejects a tier it does not know and a body that is not an object', () => {
    expect(plan(cfg(), { state: 'x', questions: NOUL }, { 'x-augur-data': 'secret' }).refuse?.status).toBe(400);
    expect(plan(cfg(), [1], {}).refuse?.status).toBe(400);
  });
});

describe('config', () => {
  it('always requires tokens off the loopback address', () => {
    const { config, problems } = parseConfig({ host: '0.0.0.0', requireToken: false });
    expect(config.requireToken).toBe(true); expect(problems.join(' ')).toMatch(/non-loopback/);
  });
  it('keeps the default for a value of the wrong shape and reports it', () => {
    const { config, problems } = parseConfig({ port: 'x', endpoint: 'http://insecure.example', model: '' });
    expect(config.port).toBe(8020); expect(config.endpoint).toBe('https://api.typesafe.ai/v1/systemone'); expect(problems).toHaveLength(3);
  });
  it('re-reads the file when it changes and keeps the last good settings through a broken edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jgw-')), path = join(dir, 'g.json');
    try {
      writeFileSync(path, JSON.stringify({ model: 'jev-1.14.0' }));
      const f = new ConfigFile(path, {});
      expect(f.get().config.model).toBe('jev-1.14.0');
      writeFileSync(path, '{ not json'); const t = new Date(Date.now() + 5000); utimesSync(path, t, t);
      const g = f.get(); expect(g.config.model).toBe('jev-1.14.0'); expect(g.problems[0]).toMatch(/not valid JSON/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('key', () => {
  it('reads the environment, then a file, and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jgw-'));
    try {
      expect(readKey({}, { JEV_API_KEY: ' k2 ' })).toBe('k2');
      expect(readKey({ env: ['TYPESAFE_API_KEY'] }, { TYPESAFE_API_KEY: 'k1', JEV_API_KEY: 'k2' })).toBe('k1');
      writeFileSync(join(dir, 'k'), 'filekey\n');
      expect(readKey({ file: join(dir, 'k') }, {})).toBe('filekey');
      expect(readKey({ file: join(dir, 'missing') }, {})).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('looks again for a key that was missing and keeps a found one until forgotten', () => {
    let v: string | null = null, reads = 0;
    const c = new KeyCache(() => { reads++; return v; });
    expect(c.get()).toBeNull(); v = 'k'; expect(c.get()).toBe('k'); v = 'other'; expect(c.get()).toBe('k'); expect(reads).toBe(2);
    c.forget(); expect(c.get()).toBe('other');
  });
});

describe('consumerOf', () => {
  it('matches a token to its consumer by hash', () => {
    const c = cfg({ consumers: { mercury: sha('t1'), jev: sha('t2') } });
    expect(consumerOf(c, 't2')).toBe('jev'); expect(consumerOf(c, 'nope')).toBeNull(); expect(consumerOf(c, null)).toBeNull();
  });
});

describe('gateway', () => {
  let dir: string, calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>, replies: Array<{ status: number; body: unknown }>;
  let closers: Array<() => void>;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jgw-')); calls = []; replies = []; closers = []; });
  afterEach(() => { for (const c of closers) c(); rmSync(dir, { recursive: true, force: true }); });

  const upstream = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const r = replies.shift() ?? { status: 200, body: { model: 'jev-1.14.0', answers: { billing: { noul: 0.9 } }, usage: { input_tokens: 12 } } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const start = async (settings: Record<string, unknown> = {}, extra: Parameters<typeof createGateway>[0] = {}) => {
    const path = join(dir, 'g.json');
    writeFileSync(path, JSON.stringify({ port: 0, usageLog: join(dir, 'usage.jsonl'), ...settings }));
    const g = createGateway({ configFile: new ConfigFile(path, {}), env: { TYPESAFE_API_KEY: 'hosted-key' }, fetcher: upstream as unknown as typeof fetch, sleep: async () => undefined, ...extra });
    await new Promise<void>(r => g.server.listen(0, '127.0.0.1', r));
    closers.push(() => g.server.close());
    return { base: `http://127.0.0.1:${(g.server.address() as AddressInfo).port}`, usage: g.usage };
  };
  const post = (base: string, body: unknown, headers: Record<string, string> = {}, raw?: Buffer) =>
    fetch(`${base}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ? new Uint8Array(raw) : JSON.stringify(body) });
  const ok = { state: 'My invoice is wrong', questions: NOUL };

  it('forwards to the alias with the gateway key and the answer comes back unchanged', async () => {
    const { base } = await start();
    const r = await post(base, { model: 'jev-1.13.0', ...ok }, { authorization: 'Bearer some-consumer-key' });
    expect(r.status).toBe(200);
    expect((await r.json() as { answers: unknown }).answers).toEqual({ billing: { noul: 0.9 } });
    expect(r.headers.get('x-augur-route')).toBe('hosted'); expect(r.headers.get('x-augur-model')).toBe('jev-1.14.0'); expect(r.headers.get('x-augur-tier-source')).toBe('default');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.model).toBe('jev-preview'); expect(calls[0]!.headers.authorization).toBe('Bearer hosted-key');
    expect(calls[0]!.headers['TypeSafe-Danger-Zone-Images']).toBeUndefined();
  });

  it('adds the Danger Zone headers a request needs', async () => {
    const { base } = await start();
    await post(base, { ...ok, assets: { 'a-1': { type: 'image', format: 'png', data_base64: 'AA==' } } }, { 'x-augur-long-context': 'true' });
    expect(calls[0]!.headers['TypeSafe-Danger-Zone-Images']).toBe('true'); expect(calls[0]!.headers['TypeSafe-Danger-Zone-Long-Context']).toBe('true');
  });

  it('accepts a gzip body', async () => {
    const { base } = await start();
    const r = await post(base, null, { 'content-encoding': 'gzip' }, gzipSync(JSON.stringify(ok)));
    expect(r.status).toBe(200); expect(calls).toHaveLength(1);
  });

  it('answers a local-only request from Laya and never calls the hosted model', async () => {
    const poolCalls: string[] = [];
    const poolFetcher = async (url: string) => { poolCalls.push(url); return url.endsWith('/load') ? { ok: true, status: 200, json: async () => ({ ready: true }) } : { ok: true, status: 200, json: async () => ({ model: 'laya', answers: { billing: { noul: 0.4 } } }) }; };
    const { base } = await start({}, { poolFetcher });
    const r = await post(base, ok, { 'x-augur-data': 'local_only' });
    expect(r.status).toBe(200); expect(r.headers.get('x-augur-route')).toBe('laya');
    expect(calls).toHaveLength(0); expect(poolCalls.some(u => u.endsWith('/v1/systemone'))).toBe(true);
  });

  it('refuses, rather than falls back, when Laya is down for a local-only request', async () => {
    const poolFetcher = async () => { throw new Error('connection refused'); };
    const { base } = await start({}, { poolFetcher });
    const r = await post(base, ok, { 'x-augur-data': 'sensitive' });
    expect(r.status).toBe(503); expect(r.headers.get('x-augur-refused')).toBe('1'); expect(calls).toHaveLength(0);
  });

  it('retries a 529 and then passes a 4xx from the upstream through untouched', async () => {
    replies.push({ status: 529, body: { error: 'busy' } }, { status: 422, body: { error: 'bad question' } });
    const { base } = await start();
    const r = await post(base, ok);
    expect(r.status).toBe(422); expect(calls).toHaveLength(2); expect(r.headers.get('x-augur-gateway')).toBeNull();
  });

  it('answers 503 without the refused header when it has no key, so a caller may go direct', async () => {
    const { base } = await start({}, { env: {} });
    const r = await post(base, ok);
    expect(r.status).toBe(503); expect(r.headers.get('x-augur-gateway')).toBe('1'); expect(r.headers.get('x-augur-refused')).toBeNull();
  });

  it('refuses a request from a web page and one addressed to another host name', async () => {
    const { base } = await start();
    expect((await post(base, ok, { origin: 'https://evil.example' })).status).toBe(403);
    const viaHost = await new Promise<number>(res => {
      import('node:http').then(({ request }) => { const q = request(`${base}/v1/systemone`, { method: 'POST', headers: { host: 'rebind.example', 'content-type': 'application/json' } }, m => res(m.statusCode ?? 0)); q.end(JSON.stringify(ok)); });
    });
    expect(viaHost).toBe(403);
  });

  it('requires a consumer token when the settings ask for one, and names the consumer in the usage record', async () => {
    const { base, usage } = await start({ requireToken: true, consumers: { mercury: sha('secret-token') } });
    expect((await post(base, ok)).status).toBe(401);
    expect((await post(base, ok, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(base, ok, { authorization: 'Bearer secret-token' })).status).toBe(200);
    expect(usage.summary(1).byConsumer.mercury?.hosted).toBe(1);
  });

  it('keeps a consumer label like __proto__ out of the prototype when it counts usage', async () => {
    const { base, usage } = await start();
    await post(base, ok, { 'x-augur-consumer': '__proto__' });
    const s = usage.summary(1);
    expect(s.byConsumer['__proto__']?.requests).toBe(1);
    expect(({} as Record<string, unknown>).requests).toBeUndefined();
    expect(Object.keys(s.byConsumer)).toContain('__proto__');
  });

  it('records one line per request with the tier and models and no request text', async () => {
    const { base } = await start();
    await post(base, ok, { 'x-augur-consumer': 'jev-py' });
    await post(base, { ...ok, state: 'secret student essay' }, { 'x-augur-data': 'internal', 'x-augur-consumer': 'jev-py' });
    const text = readFileSync(join(dir, 'usage.jsonl'), 'utf8');
    expect(text).not.toMatch(/invoice|essay/);
    const rows = text.trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ consumer: 'jev-py', route: 'hosted', tier: 'internal', modelSent: 'jev-preview', modelAnswered: 'jev-1.14.0', status: 200, usage: { input_tokens: 12 } });
  });

  it('applies a model edit on the next request without a restart', async () => {
    const { base } = await start();
    await post(base, ok);
    const path = join(dir, 'g.json');
    writeFileSync(path, JSON.stringify({ port: 0, usageLog: join(dir, 'usage.jsonl'), model: 'jev-1.14.0' })); utimesSync(path, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    await post(base, ok);
    expect(calls.map(c => c.body.model)).toEqual(['jev-preview', 'jev-1.14.0']);
  });

  it('keeps requiring tokens after the settings move to loopback while the socket stays on the address it started on', async () => {
    const path = join(dir, 'g.json');
    writeFileSync(path, JSON.stringify({ port: 0, host: '0.0.0.0', usageLog: join(dir, 'usage.jsonl'), consumers: { a: sha('t') } }));
    const g = createGateway({ configFile: new ConfigFile(path, {}), env: { TYPESAFE_API_KEY: 'hosted-key' }, fetcher: upstream as unknown as typeof fetch, sleep: async () => undefined });
    await new Promise<void>(r => g.server.listen(0, '127.0.0.1', r));
    closers.push(() => g.server.close());
    const base = `http://127.0.0.1:${(g.server.address() as AddressInfo).port}`;
    writeFileSync(path, JSON.stringify({ port: 0, host: '127.0.0.1', requireToken: false, usageLog: join(dir, 'usage.jsonl') })); utimesSync(path, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    expect((await post(base, ok)).status).toBe(401);
    expect((await post(base, ok, { authorization: 'Bearer t' })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('does not start the key command to answer a health check', async () => {
    const marker = join(dir, 'ran');
    const { base } = await start({ key: { command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('k')`] } }, { env: {} });
    const h = await (await fetch(`${base}/health`)).json() as { ok: boolean; hostedKey: boolean };
    expect(h.ok).toBe(true); expect(h.hostedKey).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('reports health without needing a token', async () => {
    const { base } = await start({ requireToken: true, consumers: { a: sha('t') } });
    const h = await (await fetch(`${base}/health`)).json() as { ok: boolean; hostedKey: boolean };
    expect(h.ok).toBe(true); expect(h.hostedKey).toBe(true);
  });
});
