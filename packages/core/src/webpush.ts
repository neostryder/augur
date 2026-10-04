/**
 * Web Push from the desktop straight to the phone's push service (RFC 8030). The message is encrypted to the phone's own key (RFC 8291)
 * and signed with the desktop's VAPID key (RFC 8292), so the push service sees only ciphertext and the relay plays no part.
 */

/** A browser's push subscription, as PushSubscription.toJSON() gives it. */
export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The desktop's VAPID key pair: the public key as base64url raw bytes, the private key as a JWK. */
export interface VapidKeys {
  publicKey: string;
  privateJwk: JsonWebKey;
}

export interface PushMessage {
  id: string;
  title: string;
  body: string;
}

const enc = new TextEncoder();
/** A push record holds 4096 bytes, less the padding delimiter and the 16-byte tag. Longer bodies are cut. */
const MAX_PLAINTEXT = 3000;

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64url(raw), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}

/** The Authorization header for one push service: a JWT for its origin, good for 12 hours, signed with ES256. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: Date): Promise<string> {
  const part = (v: object) => b64url(enc.encode(JSON.stringify(v)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })}`;
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** Encrypts one message to a subscription with the aes128gcm content coding. salt and serverKeys are for tests. */
export async function encryptPush(sub: PushSubscriptionInfo, plaintext: Uint8Array, options: { salt?: Uint8Array<ArrayBuffer>; serverKeys?: CryptoKeyPair } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = unb64url(sub.keys.p256dh), auth = unb64url(sub.keys.auth);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const server = options.serverKeys ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256));
  const ikm = await hmac(await hmac(auth, shared), concat(enc.encode('WebPush: info\0'), uaPublic, serverPublic, Uint8Array.of(1)));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), Uint8Array.of(1)))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, Uint8Array.of(2))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = serverPublic.length;
  return concat(header, serverPublic, cipher);
}

/** The request that delivers one alert to the phone. subject is a mailto: or https: address the push service can reach the sender at. */
export async function buildPush(sub: PushSubscriptionInfo, message: PushMessage, keys: VapidKeys, subject: string, now = new Date()):
  Promise<{ endpoint: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> }> {
  let text = JSON.stringify(message);
  if (enc.encode(text).length > MAX_PLAINTEXT) text = JSON.stringify({ ...message, body: message.body.slice(0, 1000) });
  return {
    endpoint: sub.endpoint,
    headers: {
      authorization: await vapidAuthorization(sub.endpoint, keys, subject, now),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'high',
    },
    body: await encryptPush(sub, enc.encode(text)),
  };
}

/** Whether a saved value looks like a push subscription. */
export function isPushSubscription(v: unknown): v is PushSubscriptionInfo {
  const s = v as PushSubscriptionInfo | null;
  return !!s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
}
