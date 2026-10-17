import { afterEach, describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CERT_DAYS, ensureWebCert, makeWebCert, webCertFingerprint, webCertNames } from '../src/web-cert.js';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'augur-cert-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NAMES = ['127.0.0.1', '::1', '192.168.2.9', 'fd00::1234', 'localhost', 'my-box', 'my-box.local'];
const DAY = 86_400_000;

describe('web certificate', () => {
  it('makes a certificate Node reads back, signed by its own key, with every name on it', () => {
    const { cert, key } = makeWebCert(NAMES);
    const x = new X509Certificate(cert);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
    expect(x.checkHost('my-box.local')).toBe('my-box.local');
    expect(x.checkHost('localhost')).toBe('localhost');
    expect(x.checkHost('elsewhere.example')).toBeUndefined();
    expect(x.checkIP('192.168.2.9')).toBe('192.168.2.9');
    expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(x.checkIP('10.0.0.1')).toBeUndefined();
    expect(x.subjectAltName).toContain('IP Address:FD00:0:0:0:0:0:0:1234');
    expect(key).toContain('BEGIN PRIVATE KEY');
  });

  it('is valid from yesterday for two years', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const x = new X509Certificate(makeWebCert(NAMES, now).cert);
    expect(new Date(x.validFrom).getTime()).toBe(now.getTime() - DAY);
    expect(new Date(x.validTo).getTime()).toBe(now.getTime() + CERT_DAYS * DAY);
  });

  it('gives each certificate its own serial number and key', () => {
    const a = new X509Certificate(makeWebCert(NAMES).cert), b = new X509Certificate(makeWebCert(NAMES).cert);
    expect(a.serialNumber).not.toBe(b.serialNumber);
    expect(a.fingerprint256).not.toBe(b.fingerprint256);
  });

  it('is accepted by a TLS client that trusts it, for a name on it and not for another', async () => {
    const { cert, key } = makeWebCert(['127.0.0.1', 'localhost']);
    const server = https.createServer({ cert, key }, (_q, r) => { r.end('ok'); });
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as { port: number }).port;
    const get = (servername: string) => new Promise<string>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, ca: cert, servername, path: '/' }, r => { let b = ''; r.on('data', c => { b += c; }); r.on('end', () => resolve(b)); }).on('error', reject);
    });
    try {
      expect(await get('localhost')).toBe('ok');
      await expect(get('wrong.example')).rejects.toThrow();
    } finally { await new Promise(res => server.close(res)); }
  });

  it('keeps the certificate in the data folder and reuses it while the names and dates hold', () => {
    const dir = tmp();
    const first = ensureWebCert(dir, NAMES);
    expect(first.created).toBe(true);
    expect(existsSync(join(dir, 'web-cert', 'cert.pem'))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'web-cert', 'key.pem')).mode & 0o077).toBe(0);
    const again = ensureWebCert(dir, NAMES.slice(0, 4));
    expect(again.created).toBe(false);
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(webCertFingerprint(dir)).toBe(first.fingerprint);
    expect(readFileSync(join(dir, 'web-cert', 'cert.pem'), 'utf8')).toBe(first.cert);
  });

  it('makes a new certificate when a name is missing or the old one is close to expiring', () => {
    const dir = tmp();
    const first = ensureWebCert(dir, NAMES);
    const more = ensureWebCert(dir, [...NAMES, 'new-name.example']);
    expect(more.created).toBe(true);
    expect(more.fingerprint).not.toBe(first.fingerprint);
    const late = ensureWebCert(dir, [...NAMES, 'new-name.example'], new Date(Date.now() + (CERT_DAYS - 10) * DAY));
    expect(late.created).toBe(true);
  });

  it('makes a new certificate when the files are damaged, and has no fingerprint before the first one', () => {
    const dir = tmp();
    expect(webCertFingerprint(dir)).toBeNull();
    const first = ensureWebCert(dir, NAMES);
    rmSync(join(dir, 'web-cert', 'key.pem'));
    expect(ensureWebCert(dir, NAMES).fingerprint).not.toBe(first.fingerprint);
  });
});

describe('web certificate names', () => {
  const ifs = { eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }, { family: 'IPv6', internal: false, address: 'fe80::1' }], lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] } as never;

  it('always covers this computer, and adds every network address for a wildcard bind', () => {
    const n = webCertNames({ host: '0.0.0.0', allowedHosts: ['Augur.Example'] }, 'My-Box', ifs);
    expect(n).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1', 'my-box', 'my-box.local', '192.168.1.5', 'augur.example']));
    expect(n).not.toContain('fe80::1');
  });

  it('adds only the bind address for a specific bind, and drops names that cannot go on a certificate', () => {
    const n = webCertNames({ host: '192.168.1.5', allowedHosts: ['bad host!'] }, '', ifs);
    expect(n).toContain('192.168.1.5');
    expect(n).not.toContain('bad host!');
    expect(webCertNames({ host: '127.0.0.1', allowedHosts: [] }, '', ifs)).toEqual(['127.0.0.1', '::1', 'localhost']);
  });
});
