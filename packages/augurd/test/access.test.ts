import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccessVerifier } from '../src/chat/access.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key' }, now = 1_800_000_000_000;
const token = (patch = {}, header = { alg: 'RS256', kid: 'key' }, key = privateKey) => {
  const body = [header, { iss: 'https://team.cloudflareaccess.com', aud: ['app'], exp: now / 1000 + 300, email: 'Alice@Example.com', ...patch }].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
};

describe('Access verification', () => {
  it('checks signatures, claims, algorithms, and time leeway', async () => {
    let calls = 0;
    const access = new AccessVerifier('team.cloudflareaccess.com', 'app', async (url, init) => {
      expect(url).toBe('https://team.cloudflareaccess.com/cdn-cgi/access/certs');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      calls++; return Response.json({ keys: [jwk] });
    }, () => now);
    expect(await access.email(token())).toBe('alice@example.com');
    expect(await access.email(token({ nbf: now / 1000 + 29 }))).toBe('alice@example.com');
    for (const patch of [{ aud: ['other'] }, { iss: 'https://wrong.example' }, { exp: now / 1000 - 31 }, { nbf: now / 1000 + 31 }, { email: 3 }, { exp: 'later' }]) expect(await access.email(token(patch))).toBeNull();
    for (const alg of ['none', 'HS256']) expect(await access.email(token({}, { alg, kid: 'key' }))).toBeNull();
    expect(await access.email(token({}, undefined, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey))).toBeNull();
    expect(calls).toBe(1);
  });

  it('refetches an unknown kid once per minute and refreshes the cache after an hour', async () => {
    let calls = 0, at = now;
    const access = new AccessVerifier('team.cloudflareaccess.com', 'app', async () => { calls++; return Response.json({ keys: calls === 1 ? [jwk] : [jwk, { ...jwk, kid: 'new' }] }); }, () => at);
    expect(await access.email(token())).toBe('alice@example.com');
    expect(await access.email(token({}, { alg: 'RS256', kid: 'new' }))).toBe('alice@example.com');
    expect(calls).toBe(2);
    for (let i = 0; i < 3; i++) expect(await access.email(token({}, { alg: 'RS256', kid: 'unknown' }))).toBeNull();
    expect(calls).toBe(2);
    at += 60_000;
    expect(await access.email(token({}, { alg: 'RS256', kid: 'unknown' }))).toBeNull();
    expect(calls).toBe(3);
    at += 3_600_000;
    await access.email(token({ exp: at / 1000 + 300 }));
    expect(calls).toBe(4);
  });

  it('refuses unavailable certificates and malformed tokens', async () => {
    const access = new AccessVerifier('team.cloudflareaccess.com', 'app', async () => Response.json({}, { status: 503 }));
    expect(await access.email(token())).toBeNull();
    expect(await access.email('bad')).toBeNull();
  });
});
