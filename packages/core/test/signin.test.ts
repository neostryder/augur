import { describe, it, expect } from 'vitest';
import type { Host, HttpRequest, HttpResponse } from '../src/types.js';
import { beginLogin, completeLogin, ownAccessToken, ownSession, sessionSecretName } from '../src/signin.js';
import { claude } from '../src/providers/index.js';
import { codex } from '../src/providers/index.js';

const jwt = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;
const reply = (status: number, body: unknown = {}): HttpResponse => ({ status, headers: {}, body: JSON.stringify(body) });

function fake(routes: (req: HttpRequest, n: number) => HttpResponse | Promise<HttpResponse>, now = new Date('2026-10-16T12:00:00Z')) {
  const secrets = new Map<string, string>(), calls: HttpRequest[] = [];
  const host: Host = {
    platform: 'linux',
    http: async req => { calls.push(req); return routes(req, calls.length); },
    secret: async name => secrets.get(name) ?? null,
    saveSecret: async (name, value) => { secrets.set(name, value); },
    now: () => now,
  };
  return { host, secrets, calls };
}

describe('signing in to Claude', () => {
  it('builds an authorize link with PKCE and the scopes usage needs, and nothing that creates keys', async () => {
    const { host } = fake(() => reply(500));
    const { start, pending } = await beginLogin(host, 'claude');
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('user:profile user:inference');
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(start.url).not.toContain(pending.verifier!);
    expect(start.mode).toBe('paste');
  });

  it('exchanges the pasted code, keeps only the refresh token, and keeps the access token in memory', async () => {
    const { host, secrets, calls } = fake(() => reply(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'user:profile user:inference' }));
    const { pending } = await beginLogin(host, 'claude');
    expect(await completeLogin(host, pending, `the-code#${pending.state}`)).toEqual({ done: true });
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', state: pending.state, code_verifier: pending.verifier });
    const stored = JSON.parse(secrets.get(sessionSecretName('claude'))!);
    expect(stored.refreshToken).toBe('refresh-1');
    expect(JSON.stringify(stored)).not.toContain('access-1');
    expect(await ownAccessToken(host, 'claude')).toBe('access-1');
    expect(calls).toHaveLength(1);
  });

  it('refuses a code from another sign-in, and a grant that cannot read usage, without saving anything', async () => {
    const wrong = fake(() => reply(200, {}));
    const a = await beginLogin(wrong.host, 'claude');
    await expect(completeLogin(wrong.host, a.pending, 'code#some-other-state')).rejects.toThrow(/different sign-in/);
    expect(wrong.calls).toHaveLength(0);

    const narrow = fake(() => reply(200, { access_token: 'a', refresh_token: 'r', scope: 'user:inference' }));
    const b = await beginLogin(narrow.host, 'claude');
    await expect(completeLogin(narrow.host, b.pending, 'code')).rejects.toThrow(/cannot read usage/);
    expect(narrow.secrets.size).toBe(0);
  });

  it('refuses a sign-in that has expired', async () => {
    const { host } = fake(() => reply(200, {}));
    const { pending } = await beginLogin(host, 'claude');
    await expect(completeLogin({ ...host, now: () => new Date('2026-10-16T12:20:00Z') }, pending, 'code')).rejects.toThrow(/expired/);
  });
});

describe('signing in to Codex with a device code', () => {
  const approved = { authorization_code: 'auth-code', code_challenge: 'c', code_verifier: 'v' };
  const id = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro' } });

  it('shows the code and the page, polls until it is approved, then exchanges it', async () => {
    let polls = 0;
    const { host, secrets, calls } = fake(req => {
      if (req.url.endsWith('/deviceauth/usercode')) return reply(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '5' });
      if (req.url.endsWith('/deviceauth/token')) return ++polls < 3 ? reply(403) : reply(200, approved);
      return reply(200, { id_token: id, access_token: jwt({ exp: 1900000000 }), refresh_token: 'refresh-c' });
    });
    const { pending, start } = await beginLogin(host, 'codex');
    expect(start).toMatchObject({ mode: 'device', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' });
    expect(await completeLogin(host, pending)).toEqual({ done: false });
    expect(await completeLogin(host, pending)).toEqual({ done: false });
    expect(await completeLogin(host, pending)).toEqual({ done: true });
    const exchange = calls.at(-1)!;
    expect(exchange.headers!['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(exchange.body).toContain('grant_type=authorization_code');
    expect(exchange.body).toContain('code_verifier=v');
    expect(await ownSession(host, 'codex')).toMatchObject({ refreshToken: 'refresh-c', accountId: 'acct-1', plan: 'pro' });
    expect(secrets.get(sessionSecretName('codex'))).not.toContain('id_token');
  });

  it('says what to turn on when device codes are not enabled', async () => {
    const { host } = fake(() => reply(404));
    await expect(beginLogin(host, 'codex')).rejects.toThrow(/security settings/);
  });
});

describe('renewing an own session', () => {
  const session = (provider: string, token: string) => JSON.stringify({ refreshToken: token, savedAt: '2026-10-01T00:00:00Z', ...(provider === 'codex' ? { accountId: 'acct-1' } : {}) });

  it('saves the rotated refresh token before handing back the access token', async () => {
    const order: string[] = [];
    const f = fake(() => { order.push('http'); return reply(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }); });
    f.secrets.set(sessionSecretName('claude'), session('claude', 'refresh-1'));
    const save = f.host.saveSecret!;
    f.host.saveSecret = async (n, v) => { order.push('save'); await save(n, v); };
    expect(await ownAccessToken(f.host, 'claude')).toBe('access-2');
    expect(order).toEqual(['http', 'save']);
    expect(JSON.parse(f.secrets.get(sessionSecretName('claude'))!).refreshToken).toBe('refresh-2');
  });

  it('runs one renewal for many concurrent readers, so a refresh token is spent once', async () => {
    const f = fake(async () => { await new Promise(r => setTimeout(r, 20)); return reply(200, { access_token: 'access-3', refresh_token: 'refresh-3', expires_in: 3600 }); });
    f.secrets.set(sessionSecretName('claude'), session('claude', 'refresh-1'));
    const tokens = await Promise.all([ownAccessToken(f.host, 'claude'), ownAccessToken(f.host, 'claude'), ownAccessToken(f.host, 'claude')]);
    expect(tokens).toEqual(['access-3', 'access-3', 'access-3']);
    expect(f.calls).toHaveLength(1);
  });

  it('says to sign in again when the saved session is refused', async () => {
    const f = fake(() => reply(400));
    f.secrets.set(sessionSecretName('codex'), session('codex', 'spent'));
    await expect(ownAccessToken(f.host, 'codex')).rejects.toThrow(/^Sign in again/);
  });
});

describe('providers read the own session first', () => {
  it('Claude reads usage with Augur\'s own token and never touches the CLI file', async () => {
    const reads: string[] = [];
    const f = fake(req => {
      if (req.url.includes('/v1/oauth/token')) return reply(200, { access_token: 'own-access', refresh_token: 'own-refresh-2', expires_in: 3600 });
      expect(req.headers!.Authorization).toBe('Bearer own-access');
      return reply(200, { limits: [{ kind: 'session', group: 'session', percent: 12, resets_at: '2026-10-16T15:00:00Z', is_active: true }] });
    });
    f.secrets.set(sessionSecretName('claude'), JSON.stringify({ refreshToken: 'own-refresh', savedAt: '2026-10-01T00:00:00Z' }));
    f.host.readHomeFile = async path => { reads.push(path); return JSON.stringify({ claudeAiOauth: { accessToken: 'cli', refreshToken: 'cli-refresh', expiresAt: 0 } }); };
    f.host.writeHomeFileAtomic = async () => { throw new Error('the CLI file must not be written'); };
    const r = await claude.fetch(f.host, {});
    expect(r.meters[0]!.usedPct).toBe(12);
    expect(reads).toEqual([]);
    expect(await claude.detect!(f.host)).toBe(true);
  });

  it('Codex reads usage with Augur\'s own token and account', async () => {
    const f = fake(req => {
      if (req.url.endsWith('/oauth/token')) return reply(200, { access_token: jwt({ exp: 1900000000 }), refresh_token: 'own-refresh-2' });
      expect(req.headers!['ChatGPT-Account-Id']).toBe('acct-9');
      return reply(200, { plan_type: 'pro', rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 4, reset_at: 1900000000 } } });
    });
    f.secrets.set(sessionSecretName('codex'), JSON.stringify({ refreshToken: 'own-refresh', accountId: 'acct-9', savedAt: '2026-10-01T00:00:00Z' }));
    f.host.readHomeFile = async () => { throw new Error('the CLI file must not be read'); };
    const r = await codex.fetch(f.host, {});
    expect(r.meters[0]!.usedPct).toBe(4);
  });
});
