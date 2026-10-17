import { describe, it, expect } from 'vitest';
import { loginCmd, type LoginDeps } from '../src/signin.js';

function run(rest: string[], answers: Record<string, unknown[]>, extra: { stdin?: string; secret?: string; interactive?: boolean; logout?: boolean } = {}) {
  let out = '', err = '';
  const calls: Array<[string, unknown[]]> = [], queue = { ...answers };
  let clock = 0;
  const deps: LoginDeps = {
    call: async (m, a) => { calls.push([m, a]); const next = queue[m]?.shift(); if (next instanceof Error) throw next; return next; },
    sleep: async ms => { clock += ms; }, now: () => clock,
  };
  return loginCmd(rest, { stdin: extra.stdin !== undefined }, { err: t => { err += t; }, stdin: () => extra.stdin ?? '', interactive: extra.interactive ?? false,
    ...(extra.secret !== undefined ? { readSecret: async () => extra.secret as string } : {}) }, t => { out += t + '\n'; }, deps, extra.logout)
    .then(code => ({ code, out, err, calls }));
}

describe('augur login', () => {
  const claudeStart = { id: 'L1', provider: 'claude', mode: 'paste', url: 'https://example.invalid/authorize?x=1', expiresInS: 900 };

  it('gives the Claude link on the error stream and sends the typed code, never printing it', async () => {
    const r = await run(['claude'], { signInBegin: [claudeStart], signInComplete: [{ done: true }] }, { interactive: true, secret: 'the-code#state' });
    expect(r.code).toBe(0);
    expect(r.err).toContain('https://example.invalid/authorize?x=1');
    expect(r.calls).toEqual([['signInBegin', ['claude']], ['signInComplete', ['L1', 'the-code#state']]]);
    expect(r.out + r.err).not.toContain('the-code');
  });

  it('takes the code from standard input with --stdin', async () => {
    const r = await run(['claude'], { signInBegin: [claudeStart], signInComplete: [{ done: true }] }, { stdin: 'piped-code\n' });
    expect(r.code).toBe(0);
    expect(r.calls[1]).toEqual(['signInComplete', ['L1', 'piped-code']]);
  });

  it('asks for a terminal or --stdin when no one can type the code', async () => {
    const r = await run(['claude'], { signInBegin: [claudeStart] });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--stdin/);
  });

  it('shows the Codex code and waits until it is approved', async () => {
    const r = await run(['codex'], { signInBegin: [{ id: 'L2', provider: 'codex', mode: 'device', url: 'https://auth.example.invalid/codex/device', code: 'ABCD-1234', expiresInS: 900 }],
      signInComplete: [{ done: false }, { done: false }, { done: true }] });
    expect(r.code).toBe(0);
    expect(r.err).toContain('ABCD-1234');
    expect(r.calls.filter(c => c[0] === 'signInComplete')).toHaveLength(3);
  });

  it('gives up when the Codex code expires', async () => {
    const pending = Array.from({ length: 400 }, () => ({ done: false }));
    const r = await run(['codex'], { signInBegin: [{ id: 'L3', provider: 'codex', mode: 'device', url: 'u', code: 'C', expiresInS: 20 }], signInComplete: pending });
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/expired/);
  });

  it('reports status and signs out', async () => {
    const s = await run(['status'], { signInStatus: [{ claude: 'own', codex: null }] });
    expect(s.out).toContain('Claude: signed in through Augur');
    expect(s.out).toContain('Codex: not signed in');
    const only = await run(['status'], { signInStatus: [{ codex: 'cli' }] });
    expect(only.out.trim()).toBe("Codex: using the provider CLI's login");
    const o = await run(['claude'], { signOut: [undefined] }, { logout: true });
    expect(o.calls).toEqual([['signOut', ['claude']]]);
  });

  it('rejects an unknown provider', async () => {
    expect((await run(['grok'], {})).code).toBe(1);
  });
});
