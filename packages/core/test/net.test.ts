import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { genericProvider, isHomeHost, keyMayGoTo } from '../src/index.js';
import { createNodeHost } from '../src/hosts/node.js';
import type { Host } from '../src/types.js';

describe('isHomeHost', () => {
  it('accepts this computer, home names, and real private addresses', () => {
    for (const h of ['localhost', '::1', '[::1]', 'nas', 'printer.local', 'box.lan', 'x.home.arpa', '127.0.0.1', '10.0.0.5', '192.168.1.20', '169.254.1.1', '172.16.0.1', '172.31.255.254'])
      expect(isHomeHost(h), h).toBe(true);
  });
  it('refuses public names that only start like a private address', () => {
    for (const h of ['10.attacker.example', '192.168.example.com', '127.0.0.1.attacker.example', '172.16.example.org', '169.254.evil.net'])
      expect(isHomeHost(h), h).toBe(false);
  });
  it('refuses public and malformed addresses', () => {
    for (const h of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '11.0.0.1', '10.0.0', '10.0.0.256', '10.0.0.1.1', '2130706433', '', '10.0.0.1@evil.example', 'a b'])
      expect(isHomeHost(h), h).toBe(false);
  });
});

describe('keyMayGoTo', () => {
  it('allows https anywhere and http only to a home host', () => {
    expect(keyMayGoTo('https://api.example.com/v1')).toBe(true);
    expect(keyMayGoTo('http://127.0.0.1:8470/')).toBe(true);
    expect(keyMayGoTo('http://nas/v1')).toBe(true);
    expect(keyMayGoTo('http://[::1]:9000/x')).toBe(true);
    expect(keyMayGoTo(' http://192.168.1.4/ ')).toBe(true);
  });
  it('refuses http to a public host, however the address is dressed', () => {
    for (const u of ['http://api.example.com/v1', 'http://10.attacker.example/v1', 'http://10.0.0.1@evil.example/v1', 'http://127.0.0.1:80@evil.example/', 'http://user:pw@127.0.0.1/', 'https://user@api.example.com/', 'http://0x08.0x08.0x08.0x08/', 'http://134744072/', 'ftp://127.0.0.1/', 'not a url', ''])
      expect(keyMayGoTo(u), u).toBe(false);
  });
});

const hostWithSecret = (): Host => ({ secret: async () => 'sk-test', http: async () => { throw new Error('should not be called'); } }) as unknown as Host;
const def = (url: string, auth: 'bearer' | 'none' = 'bearer') => ({ id: 'x', name: 'X', color: '#000', auth: { type: auth }, requests: { a: { url } }, plan: 'p' }) as never;

describe('genericProvider key transport', () => {
  it('refuses to attach a key to a plain-http public address before sending anything', async () => {
    await expect(genericProvider(def('http://203.0.113.9/usage')).fetch(hostWithSecret(), {} as never)).rejects.toThrow(/only goes over https/);
    await expect(genericProvider(def('http://10.0.0.1@evil.example/usage')).fetch(hostWithSecret(), {} as never)).rejects.toThrow(/only goes over https/);
  });
});

describe('node host redirects', () => {
  const servers: Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });
  const listen = (handler: Parameters<typeof createServer>[1]): Promise<string> => new Promise(resolve => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
  });

  it('does not follow a redirect to a public plain-http address', async () => {
    const base = await listen((_req, res) => { res.statusCode = 302; res.setHeader('location', 'http://203.0.113.9/steal'); res.end(); });
    await expect(createNodeHost().http({ url: `${base}/`, headers: { 'x-api-key': 'sk-test' } })).rejects.toThrow('HTTPS is required');
  });

  it('keeps the request headers on the same origin and drops them on another', async () => {
    const seen: Record<string, string | undefined> = {};
    const other = await listen((req, res) => { seen.other = req.headers['x-api-key'] as string | undefined; res.end('done'); });
    const base = await listen((req, res) => {
      if (req.url === '/same') { seen.same = req.headers['x-api-key'] as string | undefined; res.end('same'); return; }
      if (req.url === '/hop') { res.statusCode = 302; res.setHeader('location', '/same'); res.end(); return; }
      res.statusCode = 302; res.setHeader('location', `${other}/x`); res.end();
    });
    const host = createNodeHost();
    expect((await host.http({ url: `${base}/hop`, headers: { 'x-api-key': 'k1', Accept: 'application/json' } })).body).toBe('same');
    expect(seen.same).toBe('k1');
    expect((await host.http({ url: `${base}/away`, headers: { 'x-api-key': 'k2' } })).body).toBe('done');
    expect(seen.other).toBeUndefined();
  });

  it('stops after too many redirects', async () => {
    const base = await listen((_req, res) => { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); });
    await expect(createNodeHost().http({ url: `${base}/loop` })).rejects.toThrow('Too many redirects');
  });
});
