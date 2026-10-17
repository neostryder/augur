// A self-signed certificate for the web app, made and kept by the service when web.tlsAuto is on, so https needs no files and no outside tools.
// The certificate is a plain X.509 v3 leaf over an ECDSA P-256 key. It is built here from DER pieces because Node can read certificates but not make them.
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { ownerOnly } from './ipc.js';

const DAY = 86_400_000;
/** The certificate is good for two years and made again with a month to spare, so a device that trusts it is asked again at most every year and a half. */
export const CERT_DAYS = 730;
const RENEW_BEFORE_DAYS = 30;

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
};
const der = (tag: number, ...parts: Buffer[]): Buffer => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p: Buffer[]) => der(0x30, ...p);
const set = (...p: Buffer[]) => der(0x31, ...p);
const oid = (dotted: string): Buffer => {
  const n = dotted.split('.').map(Number), out: number[] = [n[0]! * 40 + n[1]!];
  for (const v of n.slice(2)) { const chunk = [v & 0x7f]; for (let r = Math.floor(v / 128); r > 0; r = Math.floor(r / 128)) chunk.unshift((r & 0x7f) | 0x80); out.push(...chunk); }
  return der(0x06, Buffer.from(out));
};
const utf8 = (s: string) => der(0x0c, Buffer.from(s, 'utf8'));
const octets = (b: Buffer) => der(0x04, b);
const bits = (b: Buffer) => der(0x03, Buffer.concat([Buffer.from([0]), b]));
const time = (d: Date) => { const p = (n: number, w = 2) => String(n).padStart(w, '0'); const y = d.getUTCFullYear(); const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; return y < 2050 ? der(0x17, Buffer.from(`${p(y % 100)}${body}`)) : der(0x18, Buffer.from(`${p(y, 4)}${body}`)); };

function ipv6Bytes(text: string): Buffer | null {
  const plain = text.replace(/^\[|\]$/g, '').split('%')[0]!;
  const [head, tail, extra] = plain.split('::');
  if (extra !== undefined) return null;
  const words = (s: string | undefined) => (s ? s.split(':') : []);
  const h = words(head), t = words(tail);
  if (tail === undefined ? h.length !== 8 : h.length + t.length > 7) return null;
  const all = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) { if (!/^[0-9a-f]{1,4}$/i.test(all[i]!)) return null; buf.writeUInt16BE(parseInt(all[i]!, 16), i * 2); }
  return buf;
}

/** One subjectAltName entry: an IP address or a DNS name. Anything that is neither is skipped by the caller. */
function altName(name: string): Buffer | null {
  const kind = isIP(name.replace(/^\[|\]$/g, ''));
  if (kind === 4) return der(0x87, Buffer.from(name.split('.').map(Number)));
  if (kind === 6) { const b = ipv6Bytes(name); return b ? der(0x87, b) : null; }
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(name) ? der(0x82, Buffer.from(name.toLowerCase(), 'ascii')) : null;
}

export interface WebCertNames { host: string; allowedHosts: string[] }

/** Every name a browser might use for this service: this computer's names, its loopback addresses, the bind address, every network address when the bind is a wildcard, and the allowed host names. */
export function webCertNames(s: WebCertNames, name: string = hostname(), interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const names = new Set<string>(['localhost', '127.0.0.1', '::1']);
  if (name) { names.add(name.toLowerCase()); names.add(`${name.toLowerCase()}.local`); }
  const wildcard = s.host === '0.0.0.0' || s.host === '::';
  if (wildcard) {
    for (const list of Object.values(interfaces)) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) names.add(i.address);
  } else if (s.host) names.add(s.host.replace(/^\[|\]$/g, '').toLowerCase());
  for (const h of s.allowedHosts) names.add(h.replace(/^\[|\]$/g, '').toLowerCase());
  return [...names].filter(n => altName(n) !== null).sort();
}

/** Builds the PEM certificate for these names, signed by the key it carries. */
export function makeWebCert(names: string[], now: Date = new Date()): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const name = seq(set(seq(oid('2.5.4.3'), utf8('Augur web app'))));
  const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 0x01;
  const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), octets(value));
  const alt = seq(...names.map(altName).filter((a): a is Buffer => a !== null));
  const extensions = der(0xa3, seq(
    ext('2.5.29.19', true, seq()),
    ext('2.5.29.15', true, der(0x03, Buffer.from([0x07, 0x80]))),
    ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
    ext('2.5.29.17', false, alt),
  ));
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), sigAlg, name,
    seq(time(new Date(now.getTime() - DAY)), time(new Date(now.getTime() + CERT_DAYS * DAY))),
    name, spki, extensions,
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certDer = seq(tbs, sigAlg, bits(signature));
  const pem = (label: string, body: Buffer) => `-----BEGIN ${label}-----\n${body.toString('base64').replace(/.{64}/g, '$&\n').trimEnd()}\n-----END ${label}-----\n`;
  return { cert: pem('CERTIFICATE', certDer), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

export interface WebCert { cert: string; key: string; fingerprint: string; created: boolean; names: string[] }

const sameNames = (c: X509Certificate, names: string[]): boolean => {
  const have = (c.subjectAltName ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^DNS:/, '').replace(/^IP Address:/, '').replace(/^"|"$/g, '').toLowerCase());
  const norm = (n: string) => (isIP(n) === 6 ? (ipv6Bytes(n) ?? Buffer.alloc(0)).toString('hex') : n);
  const haveSet = new Set(have.map(norm));
  return names.every(n => haveSet.has(norm(n)));
};

/** The certificate in <dir>/web-cert, made on first use and made again when the names it needs are not all on it or it is close to expiring. The fingerprint is what a person checks in the browser's warning. */
export function ensureWebCert(dir: string, names: string[], now: Date = new Date()): WebCert {
  const folder = join(dir, 'web-cert'), certPath = join(folder, 'cert.pem'), keyPath = join(folder, 'key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      const cert = readFileSync(certPath, 'utf8'), key = readFileSync(keyPath, 'utf8'), x = new X509Certificate(cert);
      if (x.checkPrivateKey(createPrivateKey(key)) && new Date(x.validTo).getTime() - now.getTime() > RENEW_BEFORE_DAYS * DAY && sameNames(x, names)) {
        ownerOnly(keyPath, 0o600);
        return { cert, key, fingerprint: x.fingerprint256, created: false, names };
      }
    } catch { /* unreadable or mismatched: make a new one */ }
  }
  const made = makeWebCert(names, now);
  mkdirSync(folder, { recursive: true });
  for (const [path, text, mode] of [[certPath, made.cert, 0o644], [keyPath, made.key, 0o600]] as const) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode });
    if (mode === 0o600) ownerOnly(tmp, mode);
    renameSync(tmp, path);
  }
  // A certificate that Node cannot read back would fail at the first connection, so say so now.
  const fingerprint = new X509Certificate(made.cert).fingerprint256;
  createPublicKey(made.cert);
  return { ...made, fingerprint, created: true, names };
}

/** The SHA-256 fingerprint of the certificate on disk, or null when the service has not made one yet. */
export function webCertFingerprint(dir: string): string | null {
  try { return new X509Certificate(readFileSync(join(dir, 'web-cert', 'cert.pem'), 'utf8')).fingerprint256; } catch { return null; }
}
