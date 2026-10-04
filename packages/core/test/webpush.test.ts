import { describe, it, expect } from 'vitest';
import { b64url, buildPush, encryptPush, generateVapidKeys, isPushSubscription, unb64url, vapidAuthorization } from '../src/webpush.js';
import type { PushSubscriptionInfo } from '../src/webpush.js';

const enc = new TextEncoder();

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

/** A browser's side of a subscription, and the decryption it does when a push arrives (RFC 8291, section 3). */
async function phone(): Promise<{ sub: PushSubscriptionInfo; open: (body: Uint8Array) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64url(uaPublic), auth: b64url(auth) } };
  const open = async (body: Uint8Array) => {
    const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20]!;
    expect(rs).toBe(4096);
    const serverPublic = body.slice(21, 21 + idlen), cipher = body.slice(21 + idlen);
    const serverKey = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, pair.privateKey, 256));
    const ikm = await hmac(await hmac(auth, shared), join(enc.encode('WebPush: info\0'), uaPublic, serverPublic, Uint8Array.of(1)));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, join(enc.encode('Content-Encoding: aes128gcm\0'), Uint8Array.of(1)))).slice(0, 16);
    const nonce = (await hmac(prk, join(enc.encode('Content-Encoding: nonce\0'), Uint8Array.of(1)))).slice(0, 12);
    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
    expect(plain.at(-1)).toBe(2);
    return new TextDecoder().decode(plain.slice(0, -1));
  };
  return { sub, open };
}

describe('web push', () => {
  it('encrypts a message only the subscribed phone can read', async () => {
    const p = await phone();
    const body = await encryptPush(p.sub, enc.encode('hello phone'));
    expect(await p.open(body)).toBe('hello phone');
    const other = await phone();
    await expect(other.open(body)).rejects.toThrow();
  });

  it('signs a VAPID token the push service can check', async () => {
    const keys = await generateVapidKeys();
    expect(unb64url(keys.publicKey).length).toBe(65);
    const header = await vapidAuthorization('https://web.push.apple.com/QAbc', keys, 'https://augur.example.com', new Date('2026-10-03T00:00:00Z'));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const claims = JSON.parse(new TextDecoder().decode(unb64url(m![2]!)));
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: Date.parse('2026-10-03T12:00:00Z') / 1000, sub: 'https://augur.example.com' });
    expect(m![4]).toBe(keys.publicKey);
    const pub = await crypto.subtle.importKey('raw', unb64url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(m![3]!), enc.encode(`${m![1]}.${m![2]}`));
    expect(ok).toBe(true);
  });

  it('builds the full request, cutting an overlong body', async () => {
    const p = await phone(), keys = await generateVapidKeys();
    const req = await buildPush(p.sub, { id: 'a', title: 'Claude', body: 'x'.repeat(5000) }, keys, 'https://augur.example.com');
    expect(req.endpoint).toBe(p.sub.endpoint);
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(req.headers.authorization).toMatch(/^vapid t=/);
    const msg = JSON.parse(await p.open(req.body));
    expect(msg.id).toBe('a');
    expect(msg.body.length).toBe(1000);
  });

  it('recognizes a saved subscription', () => {
    expect(isPushSubscription({ endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } })).toBe(true);
    expect(isPushSubscription({ endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } })).toBe(false);
    expect(isPushSubscription(null)).toBe(false);
  });
});
