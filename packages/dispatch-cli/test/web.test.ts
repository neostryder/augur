import { describe, it, expect } from 'vitest';
import { webCmd, type WebDeps } from '../src/web.js';

const TOKEN = 'a'.repeat(64);
function run(rest: string[], settings: Partial<WebDeps['settings']> = {}, addresses = ['http://127.0.0.1:7420/'], fingerprint: string | null = null) {
  let out = '', err = '', rotated = 0;
  const deps: WebDeps = {
    settings: { enabled: true, host: '127.0.0.1', port: 7420, tlsCert: '', tlsKey: '', tlsAuto: false, ...settings },
    token: () => TOKEN, rotate: () => { rotated++; return 'b'.repeat(64); }, addresses: () => addresses, fingerprint: () => fingerprint,
  };
  const data: unknown[] = [];
  const code = webCmd(rest, (t, d) => { out += t + '\n'; data.push(d); }, deps, t => { err += t; });
  return { code, out, err, rotated, data };
}

describe('augur web', () => {
  it('says how to turn the web app on when it is off, and shows no token', () => {
    const r = run([], { enabled: false });
    expect(r.out).toContain('augur config set web.enabled true');
    expect(r.out).not.toContain(TOKEN);
  });

  it('lists a link per address with the token in the fragment', () => {
    const r = run([]);
    expect(r.out).toContain(`http://127.0.0.1:7420/#token=${TOKEN}`);
    expect(r.out).not.toContain('plain http');
  });

  it('warns about a network address with no TLS, and not with TLS or on this computer only', () => {
    const open = run([], { host: '0.0.0.0' }, ['http://192.168.1.5:7420/']);
    expect(open.out).toContain('plain http');
    expect(run([], { host: '0.0.0.0', tlsCert: 'c', tlsKey: 'k' }, ['https://192.168.1.5:7420/']).out).not.toContain('plain http');
  });

  it('shows the fingerprint to check when the service makes its own certificate', () => {
    const fp = 'AB:CD:EF';
    const r = run([], { host: '0.0.0.0', tlsAuto: true }, ['https://192.168.1.5:7420/'], fp);
    expect(r.out).not.toContain('plain http');
    expect(r.out).toContain(fp);
    expect(r.data[0]).toMatchObject({ tls: true, fingerprint: fp });
    expect(run([], { host: '0.0.0.0', tlsAuto: true }, ['https://192.168.1.5:7420/']).out).toContain('makes the certificate the next time it starts');
    expect(run([], { host: '0.0.0.0', tlsAuto: true, tlsCert: 'c', tlsKey: 'k' }, ['https://x/'], fp).out).not.toContain(fp);
  });

  it('replaces the token on rotate and shows the new links', () => {
    const r = run(['rotate']);
    expect(r.rotated).toBe(1);
    expect(r.out).toContain('#token=' + 'b'.repeat(64));
  });

  it('refuses an unknown subcommand', () => {
    const r = run(['nope']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('augur web rotate');
  });
});
