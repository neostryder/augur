import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Host, HttpRequest, HttpResponse } from '../src/types.js';
import { beginLogin, completeLogin, isSignInProvider, ownAccessToken, ownSession, registerSignInFlow, sessionSecretName, signInProviders, type SignInFlow } from '../src/signin.js';
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

/** A pasted-code flow that talks to a made-up provider, standing in for any flow a local file might register. */
function pasteFlow(): SignInFlow {
  const post = async (host: Host, body: unknown) => {
    const res = await host.http({ url: 'https://idp.example/token', method: 'POST', body: JSON.stringify(body) });
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return JSON.parse(res.body) as Record<string, any>;
  };
  return {
    async begin() { return { mode: 'paste', url: 'https://idp.example/authorize?state=s1', data: { state: 's1' } }; },
    async complete(host, data, input) {
      const [code, state] = String(input ?? '').split('#');
      if (!code) throw Object.assign(new Error('Sign in again: paste the code.'), { retry: true });
      if (state && state !== data.state) throw Object.assign(new Error('Sign in again: wrong sign-in.'), { retry: true });
      const t = await post(host, { grant_type: 'authorization_code', code });
      return { done: true, session: { refreshToken: t.refresh_token, plan: null }, access: { token: t.access_token, expiresInS: t.expires_in } };
    },
    async renew(host, session) {
      const t = await post(host, { grant_type: 'refresh_token', refresh_token: session.refreshToken });
      return { access: { token: t.access_token, expiresInS: t.expires_in }, ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}) };
    },
  };
}

describe('Augur sign-in to Claude', () => {
  it('is available by default and starts a PKCE sign-in with only the usage scopes', async () => {
    const { host } = fake(() => reply(500));
    expect(signInProviders()).toEqual(['claude', 'codex']);
    expect(isSignInProvider('claude')).toBe(true);
    const { start, pending } = await beginLogin(host, 'claude');
    const url = new URL(start.url);
    expect(start.mode).toBe('paste');
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('user:profile user:inference');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(pending.data.verifier).toBeTruthy();
    expect(start.url).not.toContain(pending.data.verifier);
    expect(url.searchParams.get('state')).toBe(pending.data.state);
  });

  it('exchanges the code and stores only the refresh token in Augur\'s key store', async () => {
    const { host, secrets, calls } = fake(() => reply(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'user:profile user:inference' }));
    const { pending } = await beginLogin(host, 'claude');
    expect(await completeLogin(host, pending, 'one-time-code#' + pending.data.state)).toEqual({ done: true });
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'one-time-code', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' });
    expect(body.code_verifier).toBe(pending.data.verifier);
    const stored = JSON.parse(secrets.get(sessionSecretName('claude'))!);
    expect(stored.refreshToken).toBe('refresh-1');
    expect(JSON.stringify(stored)).not.toContain('access-1');
    expect(await ownAccessToken(host, 'claude')).toBe('access-1');
  });

  it('rejects a code from another sign-in and a grant without usage scope', async () => {
    const wrong = fake(() => reply(200));
    const { pending } = await beginLogin(wrong.host, 'claude');
    await expect(completeLogin(wrong.host, pending, 'code#not-the-state')).rejects.toThrow(/different sign-in/);
    expect(wrong.calls).toHaveLength(0);

    const narrow = fake(() => reply(200, { access_token: 'a', refresh_token: 'r', scope: 'user:inference' }));
    const started = await beginLogin(narrow.host, 'claude');
    await expect(completeLogin(narrow.host, started.pending, 'code#' + started.pending.data.state)).rejects.toThrow(/cannot read usage/);
    expect(narrow.secrets.size).toBe(0);
  });
});

describe('a provider with no flow registered', () => {
  it('is not signed in to, has no own session, and is left to its CLI login', async () => {
    registerSignInFlow('claude', null);
    const { host, secrets } = fake(() => reply(500));
    secrets.set(sessionSecretName('claude'), JSON.stringify({ refreshToken: 'left-over', savedAt: '2026-10-01T00:00:00Z' }));
    expect(signInProviders()).toEqual(['codex']);
    expect(isSignInProvider('claude')).toBe(false);
    expect(await ownSession(host, 'claude')).toBeNull();
    await expect(beginLogin(host, 'claude')).rejects.toThrow(/not available/);
  });
});

describe('a registered flow', () => {
  beforeEach(() => registerSignInFlow('claude', pasteFlow()));
  afterEach(() => registerSignInFlow('claude', null));

  it('lists the provider, and starts a sign-in with the link and a login id', async () => {
    const { host } = fake(() => reply(500));
    expect(signInProviders()).toEqual(['claude', 'codex']);
    const { start, pending } = await beginLogin(host, 'claude');
    expect(start).toMatchObject({ provider: 'claude', mode: 'paste', url: 'https://idp.example/authorize?state=s1', expiresInS: 900 });
    expect(pending.data).toEqual({ state: 's1' });
  });

  it('exchanges the pasted code, keeps only the refresh token, and keeps the access token in memory', async () => {
    const { host, secrets, calls } = fake(() => reply(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }));
    const { pending } = await beginLogin(host, 'claude');
    expect(await completeLogin(host, pending, 'the-code#s1')).toEqual({ done: true });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code' });
    const stored = JSON.parse(secrets.get(sessionSecretName('claude'))!);
    expect(stored.refreshToken).toBe('refresh-1');
    expect(JSON.stringify(stored)).not.toContain('access-1');
    expect(await ownAccessToken(host, 'claude')).toBe('access-1');
    expect(calls).toHaveLength(1);
  });

  it('saves nothing when the flow refuses the code', async () => {
    const { host, secrets } = fake(() => reply(200, {}));
    const { pending } = await beginLogin(host, 'claude');
    await expect(completeLogin(host, pending, 'code#other')).rejects.toMatchObject({ retry: true });
    expect(secrets.size).toBe(0);
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
  beforeEach(() => registerSignInFlow('claude', pasteFlow()));
  afterEach(() => registerSignInFlow('claude', null));

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
  it('Claude reads usage with Augur\'s own token when a flow is registered, and never touches the CLI file', async () => {
    registerSignInFlow('claude', pasteFlow());
    try {
      const reads: string[] = [];
      const f = fake(req => {
        if (req.url === 'https://idp.example/token') return reply(200, { access_token: 'own-access', refresh_token: 'own-refresh-2', expires_in: 3600 });
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
    } finally { registerSignInFlow('claude', null); }
  });

  it('Claude ignores a stored session when no flow is registered, and reads the CLI file instead', async () => {
    registerSignInFlow('claude', null);
    const reads: string[] = [];
    const f = fake(req => {
      expect(req.headers!.Authorization).toBe('Bearer cli-access');
      return reply(200, { limits: [{ kind: 'session', group: 'session', percent: 7, resets_at: '2026-10-16T15:00:00Z', is_active: true }] });
    });
    f.secrets.set(sessionSecretName('claude'), JSON.stringify({ refreshToken: 'left-over', savedAt: '2026-10-01T00:00:00Z' }));
    f.host.readHomeFile = async path => { reads.push(path); return JSON.stringify({ claudeAiOauth: { accessToken: 'cli-access', refreshToken: 'cli-refresh', expiresAt: 4102444800000 } }); };
    const r = await claude.fetch(f.host, {});
    expect(r.meters[0]!.usedPct).toBe(7);
    expect(reads.length).toBeGreaterThan(0);
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
