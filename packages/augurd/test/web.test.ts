import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineApi, EngineKey, ResetEvent } from '@augur/core';
import { ViewHub } from '../src/views.js';
import { WebServer, hostAllowed, hostOf, originAllowed, webAddresses } from '../src/web.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { parseValue, CONFIG_KEYS } from '../src/config-edit.js';

const TOKEN = 'a'.repeat(64);
const open: WebServer[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });

function fakeEngine() {
  const listeners = new Set<(keys: EngineKey[]) => void>(), calls: unknown[][] = [];
  const state = { config: { n: 1 }, secrets: [] as string[], resets: [] as ResetEvent[] };
  const api = {
    state, onChange: (l: (keys: EngineKey[]) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    dismiss: async (...args: unknown[]) => { calls.push(args); return 'dismissed'; },
  } as unknown as EngineApi;
  return { link: { api, views: new ViewHub() }, state, calls, fire: (keys: EngineKey[]) => { for (const l of listeners) l(keys); }, listeners };
}

async function serve(token = () => TOKEN, settings = { ...DEFAULT_CONFIG.web, port: 0 }, staticDir: string | null = null) {
  const eng = fakeEngine(), logs: string[] = [];
  const server = new WebServer({ settings, engine: () => eng.link, token, staticDir, log: m => logs.push(m) });
  open.push(server);
  await server.start();
  // Port 0 asks the system for a free one; the node server knows which it took.
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  return { eng, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, server, logs };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('who may ask', () => {
  it('reads the host part of a Host header', () => {
    expect(hostOf('Example.com:7420')).toBe('example.com');
    expect(hostOf('[::1]:7420')).toBe('::1');
    expect(hostOf(undefined)).toBe('');
  });

  it('serves loopback names only on a loopback bind, plus any listed name', () => {
    const s = { host: '127.0.0.1', allowedHosts: ['augur.example.net'] };
    for (const h of ['localhost:7420', '127.0.0.1:7420', '[::1]:7420', 'augur.example.net']) expect(hostAllowed(h, s, 'mybox'), h).toBe(true);
    for (const h of ['192.168.1.5:7420', 'mybox', 'evil.example', '127.evil.example', '']) expect(hostAllowed(h, s, 'mybox'), h).toBe(false);
  });

  it('on a network bind also serves this computer by address and name, never an unlisted DNS name', () => {
    const s = { host: '0.0.0.0', allowedHosts: [] as string[] };
    for (const h of ['192.168.1.5:7420', '[fe80::1]:7420', 'mybox:7420', 'mybox.local']) expect(hostAllowed(h, s, 'mybox'), h).toBe(true);
    for (const h of ['rebind.attacker.example', 'mybox.attacker.example']) expect(hostAllowed(h, s, 'mybox'), h).toBe(false);
  });

  it('accepts only a matching Origin, or none', () => {
    expect(originAllowed(undefined, 'localhost:7420')).toBe(true);
    expect(originAllowed('http://localhost:7420', 'localhost:7420')).toBe(true);
    expect(originAllowed('http://evil.example', 'localhost:7420')).toBe(false);
    expect(originAllowed('null', 'localhost:7420')).toBe(false);
  });
});

describe('the reset ledger endpoint', () => {
  it('requires auth and returns an empty loaded ledger', async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/resets`)).status).toBe(401);
    expect((await fetch(`${base}/api/resets`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(await (await fetch(`${base}/api/resets`, { headers: auth })).json()).toEqual({ events: [], summary: { rows: 0, meters: [] } });
    expect((await fetch(`${base}/api/resets`, { method: 'POST', headers: auth })).status).toBe(405);
  });

  it('filters before limiting, summarizes the whole ledger, and caps recent events', async () => {
    const { base, eng } = await serve();
    eng.state.resets = Array.from({ length: 1005 }, (_, i): ResetEvent => {
      const at = new Date(Date.parse('2026-10-01T00:00:00Z') + i * 1000).toISOString(), provider = i % 2 ? 'other' : 'sample';
      return { v: 1, id: `${provider}.weekly.${at}`, kind: 'reset', provider, meter: 'weekly', label: 'Weekly', at, since: '2026-09-30T23:00:00Z',
        usedBefore: 80, usedAfter: 0, resetsAtBefore: null, resetsAtAfter: null, windowSeconds: 604800, scheduled: false, earlySeconds: 3600,
        atLimit: false, creditsBefore: 2, creditsAfter: 1, status: null, plan: null };
    });
    const get = async (query: string) => (await fetch(`${base}/api/resets${query}`, { headers: auth })).json() as Promise<{ events: ResetEvent[]; summary: { rows: number } }>;
    const all = await get('');
    expect(all.events).toHaveLength(200);
    expect(all.events[0]!.at).toBe(eng.state.resets.at(-1)!.at);
    expect(all.summary.rows).toBe(1005);
    const filtered = await get('?provider=sample&limit=2');
    expect(filtered.events.map(e => e.provider)).toEqual(['sample', 'sample']);
    expect(filtered.summary.rows).toBe(503);
    expect((await get('?limit=5000')).events).toHaveLength(1000);
    expect(await get('?provider=missing')).toEqual({ events: [], summary: { rows: 0, meters: [] } });
    for (const query of ['?limit=0', '?limit=-1', '?limit=1.5', '?limit=oops', '?provider=']) {
      const bad = await fetch(`${base}/api/resets${query}`, { headers: auth });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toHaveProperty('error');
    }
    expect(eng.state.resets).toHaveLength(1005);
  });
});

describe('the web calls', () => {
  it('refuses a missing or wrong token, and locks a caller out after repeated misses', async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/watch`)).status).toBe(401);
    expect((await fetch(`${base}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: '{}' })).status).toBe(401);
    for (let i = 0; i < 12; i++) await fetch(`${base}/api/watch`, { headers: { Authorization: 'Bearer wrong' } });
    expect((await fetch(`${base}/api/watch`, { headers: auth })).status).toBe(429);
  });

  it('takes the token only in the Authorization header, never in the address', async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/watch?token=${TOKEN}`)).status).toBe(401);
  });

  it('runs an engine command and refuses anything that is not one', async () => {
    const { base, eng } = await serve();
    const post = (body: unknown) => fetch(`${base}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) });
    const ok = await post({ method: 'dismiss', args: [['a']] });
    expect(await ok.json()).toEqual({ result: 'dismissed' });
    expect(eng.calls).toEqual([[['a']]]);
    const bad = await post({ method: 'start', args: [] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Unknown engine command/);
    expect((await post({ method: 'constructor' })).status).toBe(400);
  });

  it('refuses a call that is not JSON, one from another origin, and a body that is too large', async () => {
    const { base, host } = await serve();
    const raw = (headers: Record<string, string>, body = '{}') => fetch(`${base}/api/call`, { method: 'POST', headers: { ...auth, ...headers }, body });
    expect((await raw({ 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await raw({ 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status).toBe(403);
    expect((await raw({ 'Content-Type': 'application/json', Origin: `http://${host}` })).status).toBe(400);
    expect((await raw({ 'Content-Type': 'application/json' }, 'x'.repeat(9 * 1024 * 1024))).status).toBe(413);
  });

  it('streams the whole state first, then each change, and drops the view when the page closes', async () => {
    const { base, eng } = await serve();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/watch`, { headers: auth, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const reader = res.body!.getReader(), dec = new TextDecoder();
    let buf = '';
    const next = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const i = buf.indexOf('\n');
        if (i >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); return JSON.parse(l) as Record<string, unknown>; }
        const { value, done } = await reader.read();
        if (done) throw new Error('ended');
        buf += dec.decode(value);
      }
    };
    expect(await next()).toMatchObject({ t: 'ready', state: { config: { n: 1 } } });
    expect(eng.link.views.info()).toEqual([{ kind: 'terminal', caps: [] }]);
    eng.state.secrets = ['x.y'];
    eng.fire(['secrets']);
    expect(await next()).toEqual({ t: 'change', keys: ['secrets'], state: { secrets: ['x.y'] } });
    ctrl.abort();
    await new Promise(r => setTimeout(r, 100));
    expect(eng.link.views.info()).toEqual([]);
    expect(eng.listeners.size).toBe(0);
  });

  it('checks the token on every request, so a rotated token stops working at once', async () => {
    let token = TOKEN;
    const { base } = await serve(() => token);
    expect((await fetch(`${base}/api/watch`, { headers: auth, signal: AbortSignal.timeout(300) }).then(r => r.status, () => 200))).toBe(200);
    token = 'b'.repeat(64);
    expect((await fetch(`${base}/api/watch`, { headers: auth })).status).toBe(401);
  });
});

describe('the static files', () => {
  it('serves the app with a marker, refuses paths outside its folder, and sets security headers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'augur-web-'));
    const outside = join(dir, '..', 'augur-web-secret.txt');
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
      writeFileSync(join(dir, 'assets', 'a.js'), 'export {}');
      writeFileSync(outside, 'secret');
      const { base } = await serve(() => TOKEN, { ...DEFAULT_CONFIG.web, port: 0 }, dir);
      const page = await fetch(`${base}/`);
      expect(await page.text()).toContain('<meta name="augur-served" content="1">');
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      const asset = await fetch(`${base}/assets/a.js`);
      expect(asset.headers.get('content-type')).toContain('javascript');
      expect(asset.headers.get('cache-control')).toContain('immutable');
      for (const p of ['/..%2Faugur-web-secret.txt', '/%2e%2e/augur-web-secret.txt', '/assets/..%5C..%5Caugur-web-secret.txt']) {
        const r = await fetch(`${base}${p}`);
        expect(r.status, p).not.toBe(200);
      }
      expect((await fetch(`${base}/missing.js`)).status).toBe(404);
      expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { force: true }); }
  });

  it('refuses a request whose Host names something else', async () => {
    const { base } = await serve();
    const status = await new Promise<number>(resolve => {
      const q = http.request(`${base}/`, { headers: { Host: 'rebind.attacker.example' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      q.end();
    });
    expect(status).toBe(421);
  });
});

describe('the settings', () => {
  it('start off, on this computer only, and refuse a malformed address', () => {
    expect(DEFAULT_CONFIG.web).toMatchObject({ enabled: false, host: '127.0.0.1', port: 7420 });
    const dir = mkdtempSync(join(tmpdir(), 'augur-cfg-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ web: { enabled: true, host: 'bad host!', port: 80, allowedHosts: 'A.example, bad host' } }));
      expect(loadConfig(dir).web).toMatchObject({ enabled: true, host: '127.0.0.1', port: 7420, allowedHosts: ['a.example'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const host = CONFIG_KEYS.find(k => k.key === 'web.host')!;
    expect(parseValue(host, '0.0.0.0').ok).toBe(true);
    expect(parseValue(host, 'two words').ok).toBe(false);
    expect(host.weakens).toBe(true);
  });

  it('lists the addresses to open, one per network address for a wildcard bind', () => {
    const ifs = { eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }, { family: 'IPv6', internal: false, address: 'fe80::1' }], lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] } as never;
    expect(webAddresses({ host: '127.0.0.1', port: 7420, tlsCert: '', tlsKey: '' }, ifs)).toEqual(['http://127.0.0.1:7420/']);
    expect(webAddresses({ host: '0.0.0.0', port: 7420, tlsCert: 'c', tlsKey: 'k' }, ifs)).toEqual(['https://localhost:7420/', 'https://192.168.1.5:7420/']);
  });

  it('lists https addresses when the service makes its own certificate', () => {
    const ifs = { eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }], lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] } as never;
    expect(webAddresses({ host: '127.0.0.1', port: 7420, tlsCert: '', tlsKey: '', tlsAuto: 'on' }, ifs)).toEqual(['https://127.0.0.1:7420/']);
    expect(webAddresses({ host: '127.0.0.1', port: 7420, tlsCert: '', tlsKey: '', tlsAuto: 'auto' }, ifs)).toEqual(['http://127.0.0.1:7420/']);
    expect(webAddresses({ host: '0.0.0.0', port: 7420, tlsCert: '', tlsKey: '', tlsAuto: 'auto' }, ifs)).toEqual(['https://localhost:7420/', 'https://192.168.1.5:7420/']);
    expect(webAddresses({ host: '0.0.0.0', port: 7420, tlsCert: '', tlsKey: '', tlsAuto: 'off' }, ifs)).toEqual(['http://localhost:7420/', 'http://192.168.1.5:7420/']);
  });

  it('reads web.tlsAuto from the config file and from config set, automatic by default', () => {
    expect(DEFAULT_CONFIG.web.tlsAuto).toBe('auto');
    const dir = mkdtempSync(join(tmpdir(), 'augur-cfg-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ web: { tlsAuto: 'on' } }));
      expect(loadConfig(dir).web.tlsAuto).toBe('on');
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ web: { tlsAuto: 'off' } }));
      expect(loadConfig(dir).web.tlsAuto).toBe('off');
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ web: { tlsAuto: 'yes' } }));
      expect(loadConfig(dir).web.tlsAuto).toBe('auto');
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const key = CONFIG_KEYS.find(k => k.key === 'web.tlsAuto')!;
    expect(parseValue(key, 'on').ok).toBe(true);
    expect(parseValue(key, 'off').ok).toBe(true);
    expect(parseValue(key, 'auto').ok).toBe(true);
    expect(parseValue(key, 'maybe').ok).toBe(false);
  });

  it('serves https with a certificate it makes, keeps it between starts, and shows the fingerprint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'augur-tls-')), logs: string[] = [];
    try {
      const eng = fakeEngine(), settings = { ...DEFAULT_CONFIG.web, port: 0, tlsAuto: 'on' as const };
      const mk = () => new WebServer({ settings, engine: () => eng.link, token: () => TOKEN, staticDir: null, log: m => logs.push(m), dir });
      const first = mk(); open.push(first);
      const at = await first.start();
      expect(at.tls).toBe(true);
      expect(at.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      const port = (first as unknown as { server: { address(): { port: number } } }).server.address().port;
      const cert = readFileSync(join(dir, 'web-cert', 'cert.pem'));
      const body = await new Promise<string>((resolve, reject) => {
        https.get({ host: '127.0.0.1', port, ca: cert, servername: 'localhost', path: '/api/health', headers: { ...auth, Host: `127.0.0.1:${port}` } }, r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve(`${r.statusCode}`)); }).on('error', reject);
      });
      expect(body).toBe('404'); // the handshake verified the certificate and the request reached the router
      await first.close();
      const second = mk(); open.push(second);
      expect((await second.start()).fingerprint).toBe(at.fingerprint);
      expect(logs.filter(l => l.includes('made a new self-signed certificate'))).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
