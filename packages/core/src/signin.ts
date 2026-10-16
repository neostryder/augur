// Augur's own sign-in to Claude and Codex. The session lives in Augur's key store, apart from the provider CLIs' files, so the two never fight over
// one single-use refresh token, a login made here carries the scope the usage reading needs, and a computer with no CLI signed in (or no browser at
// all) can still meter. Claude takes a code pasted back from any device's browser; Codex uses OpenAI's device code, which Augur polls.
import type { Host, HttpResponse } from './types.js';
import { HttpError, json, num, obj } from './util.js';

export type SignInProvider = 'claude' | 'codex';
export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = ['claude', 'codex'];
export const isSignInProvider = (value: unknown): value is SignInProvider => value === 'claude' || value === 'codex';

/** What is kept: the renewable part only. Access tokens stay in memory, which also keeps the stored value small enough for any key store. */
export interface OwnSession { refreshToken: string; accountId?: string; plan?: string | null; scopes?: string[]; savedAt: string }

const NAMES: Record<SignInProvider, string> = { claude: 'Claude', codex: 'Codex' };
const CLAUDE = {
  client: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize: 'https://claude.com/cai/oauth/authorize',
  redirect: 'https://platform.claude.com/oauth/code/callback',
  token: 'https://platform.claude.com/v1/oauth/token',
  // Usage and the model list need these two; nothing Augur reads needs the scope that creates API keys.
  scope: 'user:profile user:inference',
};
const CODEX = { client: 'app_EMoamEEZ73f0CkXaXp7hrann', issuer: 'https://auth.openai.com' };
/** How long a started sign-in stays open, which is also how long a Codex device code lives. */
export const LOGIN_TTL_MS = 15 * 60 * 1000;
const RENEW_EARLY_MS = 5 * 60 * 1000;

export const sessionSecretName = (provider: SignInProvider): string => `${provider}.session`;

const clock = (host: Host): number => (host.now?.() ?? new Date()).getTime();
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number): string => b64url(crypto.getRandomValues(new Uint8Array(n)));
const form = (values: Record<string, string>): string => Object.entries(values).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

function claims(token: unknown): Record<string, any> {
  try { return obj(JSON.parse(atob(String(token).split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))); } catch { return {}; }
}

// ------------------------------------------------------------------ the stored session

export async function ownSession(host: Host, provider: SignInProvider): Promise<OwnSession | null> {
  let text: string | null = null;
  try { text = await host.secret(sessionSecretName(provider)); } catch { return null; }
  if (!text) return null;
  try { const v = obj(JSON.parse(text)); return typeof v.refreshToken === 'string' && v.refreshToken ? v as OwnSession : null; } catch { return null; }
}

async function saveSession(host: Host, provider: SignInProvider, session: OwnSession): Promise<void> {
  if (!host.saveSecret) throw new Error('Could not save the sign-in: Augur has no key store to write to here.');
  await host.saveSecret(sessionSecretName(provider), JSON.stringify(session));
}

// ------------------------------------------------------------------ the access token in use

const access = new WeakMap<Host, Map<SignInProvider, { token: string; expiresAt: number }>>();
const renewing = new WeakMap<Host, Map<SignInProvider, Promise<string>>>();
const slot = <T>(store: WeakMap<Host, Map<SignInProvider, T>>, host: Host): Map<SignInProvider, T> => { let m = store.get(host); if (!m) { m = new Map(); store.set(host, m); } return m; };

/** Drops the remembered access token, so the next reading renews. A sign-in or sign-out calls this. */
export function forgetAccess(host: Host, provider: SignInProvider): void { slot(access, host).delete(provider); }

async function renew(host: Host, provider: SignInProvider): Promise<string> {
  const session = await ownSession(host, provider);
  if (!session) throw new Error(`Sign in to ${NAMES[provider]} from Augur first.`);
  let response: Record<string, any>;
  try {
    response = provider === 'claude'
      ? obj(await json(host, { url: CLAUDE.token, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: CLAUDE.client }) }))
      : obj(await json(host, { url: `${CODEX.issuer}/oauth/token`, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CODEX.client, grant_type: 'refresh_token', refresh_token: session.refreshToken, scope: 'openid profile email' }) }));
  } catch (error) {
    if (error instanceof HttpError && (error.status === 400 || error.status === 401)) throw new Error(`Sign in again: ${NAMES[provider]} refused the sign-in Augur holds, so Augur cannot renew it.`);
    throw error;
  }
  if (typeof response.access_token !== 'string' || !response.access_token) throw new Error(`Could not renew the ${NAMES[provider]} sign-in. Sign in again from Augur.`);
  // A renewal spends the old refresh token, so the new one is saved before anything else can fail.
  const rotated = typeof response.refresh_token === 'string' && response.refresh_token && response.refresh_token !== session.refreshToken;
  const idClaims = claims(response.id_token), auth = obj(idClaims['https://api.openai.com/auth']);
  const next: OwnSession = { ...session, ...(rotated ? { refreshToken: response.refresh_token } : {}),
    ...(provider === 'codex' && typeof auth.chatgpt_account_id === 'string' ? { accountId: auth.chatgpt_account_id } : {}), savedAt: new Date(clock(host)).toISOString() };
  if (rotated || next.accountId !== session.accountId) await saveSession(host, provider, next);
  const exp = provider === 'codex' ? num(claims(response.access_token).exp) : null;
  const expiresAt = exp ? exp * 1000 : clock(host) + (num(response.expires_in) ?? 3600) * 1000;
  slot(access, host).set(provider, { token: response.access_token, expiresAt });
  return response.access_token;
}

/**
 * The access token for Augur's own session, renewed when it is near its end or when `force` is set. Renewals inside this engine run one at a time:
 * a second caller waits for the first and takes its result, so one refresh token is never spent twice.
 */
export async function ownAccessToken(host: Host, provider: SignInProvider, force = false): Promise<string> {
  const have = slot(access, host).get(provider);
  if (!force && have && have.expiresAt > clock(host) + RENEW_EARLY_MS) return have.token;
  const running = slot(renewing, host);
  let p = running.get(provider);
  if (!p) { p = renew(host, provider).finally(() => running.delete(provider)); running.set(provider, p); }
  return p;
}

// ------------------------------------------------------------------ signing in

/** What the engine keeps between starting a sign-in and finishing it. */
export interface PendingLogin {
  id: string; provider: SignInProvider; mode: 'paste' | 'device'; expiresAt: number;
  verifier?: string; state?: string; deviceAuthId?: string; userCode?: string;
}
/** What the person is shown: a link to open on any device with a browser, and for Codex the code to type there. */
export interface LoginStart { id: string; provider: SignInProvider; mode: 'paste' | 'device'; url: string; code?: string; expiresInS: number }

export async function beginLogin(host: Host, provider: SignInProvider): Promise<{ pending: PendingLogin; start: LoginStart }> {
  const id = random(12), expiresAt = clock(host) + LOGIN_TTL_MS, expiresInS = LOGIN_TTL_MS / 1000;
  if (provider === 'claude') {
    const verifier = random(32), state = random(16);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const query = form({ code: 'true', client_id: CLAUDE.client, response_type: 'code', redirect_uri: CLAUDE.redirect, scope: CLAUDE.scope,
      code_challenge: challenge, code_challenge_method: 'S256', state });
    return { pending: { id, provider, mode: 'paste', expiresAt, verifier, state }, start: { id, provider, mode: 'paste', url: `${CLAUDE.authorize}?${query}`, expiresInS } };
  }
  const res = await host.http({ url: `${CODEX.issuer}/api/accounts/deviceauth/usercode`, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX.client }), timeoutMs: 20000 });
  if (res.status === 404) throw new Error('Device-code sign-in is off for this ChatGPT account. Turn it on in the ChatGPT security settings and try again.');
  if (res.status < 200 || res.status >= 300) throw new Error(`Could not start the Codex sign-in (HTTP ${res.status}).`);
  const body = obj(safeParse(res.body)), userCode = String(body.user_code ?? body.usercode ?? ''), deviceAuthId = String(body.device_auth_id ?? '');
  if (!userCode || !deviceAuthId) throw new Error('Could not start the Codex sign-in: OpenAI sent back no device code.');
  return { pending: { id, provider, mode: 'device', expiresAt, deviceAuthId, userCode },
    start: { id, provider, mode: 'device', url: `${CODEX.issuer}/codex/device`, code: userCode, expiresInS } };
}

const safeParse = (text: string): unknown => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

/**
 * Finishes a sign-in. Claude needs the code the sign-in page showed (`code#state`, or the code alone). Codex needs no input: each call asks once whether
 * the device code was approved yet and answers `done: false` until it was. Nothing is saved unless the grant can read usage.
 */
export async function completeLogin(host: Host, pending: PendingLogin, input?: string): Promise<{ done: boolean }> {
  if (clock(host) > pending.expiresAt) throw new Error('Sign in again: this sign-in has expired.');
  let tokens: Record<string, any>;
  if (pending.provider === 'claude') {
    const [code, state] = String(input ?? '').trim().split('#');
    if (!code) throw new Error('Sign in again: paste the code the sign-in page showed.');
    if (state && state !== pending.state) throw new Error('Sign in again: that code is from a different sign-in. Use the link Augur gave you most recently.');
    try {
      tokens = obj(await json(host, { url: CLAUDE.token, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code, state: pending.state, redirect_uri: CLAUDE.redirect, client_id: CLAUDE.client, code_verifier: pending.verifier }) }));
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) throw new Error('Sign in again: Claude refused that code. Each code works only once and expires soon after it is shown.');
      throw error;
    }
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : null;
    if (scopes && !scopes.includes('user:profile')) throw new Error('Sign in again: Claude granted a sign-in that cannot read usage, so nothing was saved.');
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') throw new Error('Could not finish the Claude sign-in: Claude sent back no tokens.');
    await saveSession(host, 'claude', { refreshToken: tokens.refresh_token, ...(scopes ? { scopes } : {}), plan: null, savedAt: new Date(clock(host)).toISOString() });
    slot(access, host).set('claude', { token: tokens.access_token, expiresAt: clock(host) + (num(tokens.expires_in) ?? 3600) * 1000 });
    return { done: true };
  }
  const poll = await host.http({ url: `${CODEX.issuer}/api/accounts/deviceauth/token`, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }), timeoutMs: 20000 });
  if (poll.status === 403 || poll.status === 404) return { done: false };
  if (poll.status < 200 || poll.status >= 300) throw new Error(`Could not finish the Codex sign-in (HTTP ${poll.status}).`);
  const grant = obj(safeParse(poll.body));
  if (typeof grant.authorization_code !== 'string' || typeof grant.code_verifier !== 'string') throw new Error('Could not finish the Codex sign-in: OpenAI sent back no authorization code.');
  const exchange: HttpResponse = await host.http({ url: `${CODEX.issuer}/oauth/token`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code: grant.authorization_code, redirect_uri: `${CODEX.issuer}/deviceauth/callback`, client_id: CODEX.client, code_verifier: grant.code_verifier }), timeoutMs: 20000 });
  if (exchange.status < 200 || exchange.status >= 300) throw new Error(`Could not finish the Codex sign-in (HTTP ${exchange.status}).`);
  tokens = obj(safeParse(exchange.body));
  if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') throw new Error('Could not finish the Codex sign-in: OpenAI sent back no tokens.');
  const auth = obj(claims(tokens.id_token)['https://api.openai.com/auth']);
  await saveSession(host, 'codex', { refreshToken: tokens.refresh_token, ...(typeof auth.chatgpt_account_id === 'string' ? { accountId: auth.chatgpt_account_id } : {}),
    plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null, savedAt: new Date(clock(host)).toISOString() });
  const exp = num(claims(tokens.access_token).exp);
  slot(access, host).set('codex', { token: tokens.access_token, expiresAt: exp ? exp * 1000 : clock(host) + (num(tokens.expires_in) ?? 3600) * 1000 });
  return { done: true };
}
