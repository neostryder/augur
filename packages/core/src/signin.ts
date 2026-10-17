// Augur's own sign-in to a provider. The session lives in Augur's key store, apart from the provider CLIs' files, so the two never fight over one
// single-use refresh token, and a computer with no CLI signed in (or no browser at all) can still meter. Each provider is a flow registered here:
// Codex's is built in and uses OpenAI's device code, which Augur polls. Other flows are added with `registerSignInFlow`, and a provider with no
// flow registered keeps reading the CLI's login.
import type { Host, HttpResponse } from './types.js';
import { json, num, obj } from './util.js';

export type SignInProvider = 'claude' | 'codex';
const KNOWN: readonly SignInProvider[] = ['claude', 'codex'];

/** What is kept: the renewable part only. Access tokens stay in memory, which also keeps the stored value small enough for any key store. */
export interface OwnSession { refreshToken: string; accountId?: string; plan?: string | null; scopes?: string[]; savedAt: string }

/** An access token and when it ends, as either a moment or a length of time from now. */
export interface AccessGrant { token: string; expiresAtMs?: number; expiresInS?: number }

/**
 * One provider's way of signing in and staying signed in. A flow only talks to the provider; Augur keeps the login's id and time limit, saves the
 * session, remembers the access token, and runs one renewal at a time.
 * - A refused code that can be pasted again throws an error with `retry: true`, which leaves the sign-in open.
 * - A renewal the provider refuses throws an error whose `status` is 400 or 401, so the person is told to sign in again.
 */
export interface SignInFlow {
  begin(host: Host): Promise<{ mode: 'paste' | 'device'; url: string; code?: string; data?: Record<string, string> }>;
  complete(host: Host, data: Record<string, string>, input?: string): Promise<{ done: false } | { done: true; session: Omit<OwnSession, 'savedAt'>; access: AccessGrant }>;
  renew(host: Host, session: OwnSession): Promise<{ access: AccessGrant; refreshToken?: string; accountId?: string }>;
}

const flows = new Map<SignInProvider, SignInFlow>();
/** Adds a provider's flow, or removes it when `flow` is null. */
export function registerSignInFlow(provider: string, flow: SignInFlow | null): void {
  if (!(KNOWN as readonly string[]).includes(provider)) throw new Error(`Sign in is not available for ${provider}.`);
  if (flow) flows.set(provider as SignInProvider, flow); else flows.delete(provider as SignInProvider);
}
/** The providers Augur can sign in to here, which are the ones with a flow registered. */
export const signInProviders = (): SignInProvider[] => KNOWN.filter(p => flows.has(p));
export const isSignInProvider = (value: unknown): value is SignInProvider => typeof value === 'string' && (KNOWN as readonly string[]).includes(value) && flows.has(value as SignInProvider);

const NAMES: Record<SignInProvider, string> = { claude: 'Claude', codex: 'Codex' };
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
const safeParse = (text: string): unknown => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
const refused = (error: unknown): boolean => { const s = (error as { status?: unknown } | null)?.status; return s === 400 || s === 401; };
const endsAt = (host: Host, a: AccessGrant): number => a.expiresAtMs ?? clock(host) + (a.expiresInS ?? 3600) * 1000;

// ------------------------------------------------------------------ the stored session

/** The session Augur holds for a provider, or null. A provider with no flow registered has none, so its CLI login is read instead. */
export async function ownSession(host: Host, provider: SignInProvider): Promise<OwnSession | null> {
  if (!flows.has(provider)) return null;
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
  const flow = flows.get(provider), session = await ownSession(host, provider);
  if (!flow || !session) throw new Error(`Sign in to ${NAMES[provider]} from Augur first.`);
  let result: Awaited<ReturnType<SignInFlow['renew']>>;
  try { result = await flow.renew(host, session); }
  catch (error) {
    if (refused(error)) throw new Error(`Sign in again: ${NAMES[provider]} refused the sign-in Augur holds, so Augur cannot renew it.`);
    throw error;
  }
  if (!result?.access?.token) throw new Error(`Could not renew the ${NAMES[provider]} sign-in. Sign in again from Augur.`);
  // A renewal spends the old refresh token, so the new one is saved before anything else can fail.
  const rotated = !!result.refreshToken && result.refreshToken !== session.refreshToken;
  const next: OwnSession = { ...session, ...(rotated ? { refreshToken: result.refreshToken! } : {}),
    ...(result.accountId ? { accountId: result.accountId } : {}), savedAt: new Date(clock(host)).toISOString() };
  if (rotated || next.accountId !== session.accountId) await saveSession(host, provider, next);
  slot(access, host).set(provider, { token: result.access.token, expiresAt: endsAt(host, result.access) });
  return result.access.token;
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
export interface PendingLogin { id: string; provider: SignInProvider; mode: 'paste' | 'device'; expiresAt: number; data: Record<string, string> }
/** What the person is shown: a link to open on any device with a browser, and for Codex the code to type there. */
export interface LoginStart { id: string; provider: SignInProvider; mode: 'paste' | 'device'; url: string; code?: string; expiresInS: number }

export async function beginLogin(host: Host, provider: SignInProvider): Promise<{ pending: PendingLogin; start: LoginStart }> {
  const flow = flows.get(provider);
  if (!flow) throw new Error(`Sign in is not available for ${provider}.`);
  const id = random(12), expiresAt = clock(host) + LOGIN_TTL_MS, expiresInS = LOGIN_TTL_MS / 1000;
  const begun = await flow.begin(host);
  return { pending: { id, provider, mode: begun.mode, expiresAt, data: begun.data ?? {} },
    start: { id, provider, mode: begun.mode, url: begun.url, ...(begun.code ? { code: begun.code } : {}), expiresInS } };
}

/**
 * Finishes a sign-in. A pasted-code flow needs the code the sign-in page showed. A device-code flow needs no input: each call asks once whether
 * the code was approved yet and answers `done: false` until it was. Nothing is saved unless the flow hands back a session.
 */
export async function completeLogin(host: Host, pending: PendingLogin, input?: string): Promise<{ done: boolean }> {
  const flow = flows.get(pending.provider);
  if (!flow) throw new Error(`Sign in is not available for ${pending.provider}.`);
  if (clock(host) > pending.expiresAt) throw new Error('Sign in again: this sign-in has expired.');
  const result = await flow.complete(host, pending.data, input);
  if (!result.done) return { done: false };
  await saveSession(host, pending.provider, { ...result.session, savedAt: new Date(clock(host)).toISOString() });
  slot(access, host).set(pending.provider, { token: result.access.token, expiresAt: endsAt(host, result.access) });
  return { done: true };
}

// ------------------------------------------------------------------ Codex, with OpenAI's device code

const codexFlow: SignInFlow = {
  async begin(host) {
    const res = await host.http({ url: `${CODEX.issuer}/api/accounts/deviceauth/usercode`, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX.client }), timeoutMs: 20000 });
    if (res.status === 404) throw new Error('Device-code sign-in is off for this ChatGPT account. Turn it on in the ChatGPT security settings and try again.');
    if (res.status < 200 || res.status >= 300) throw new Error(`Could not start the Codex sign-in (HTTP ${res.status}).`);
    const body = obj(safeParse(res.body)), userCode = String(body.user_code ?? body.usercode ?? ''), deviceAuthId = String(body.device_auth_id ?? '');
    if (!userCode || !deviceAuthId) throw new Error('Could not start the Codex sign-in: OpenAI sent back no device code.');
    return { mode: 'device', url: `${CODEX.issuer}/codex/device`, code: userCode, data: { deviceAuthId, userCode } };
  },

  async complete(host, data) {
    const poll = await host.http({ url: `${CODEX.issuer}/api/accounts/deviceauth/token`, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: data.deviceAuthId, user_code: data.userCode }), timeoutMs: 20000 });
    if (poll.status === 403 || poll.status === 404) return { done: false };
    if (poll.status < 200 || poll.status >= 300) throw new Error(`Could not finish the Codex sign-in (HTTP ${poll.status}).`);
    const grant = obj(safeParse(poll.body));
    if (typeof grant.authorization_code !== 'string' || typeof grant.code_verifier !== 'string') throw new Error('Could not finish the Codex sign-in: OpenAI sent back no authorization code.');
    const exchange: HttpResponse = await host.http({ url: `${CODEX.issuer}/oauth/token`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code: grant.authorization_code, redirect_uri: `${CODEX.issuer}/deviceauth/callback`, client_id: CODEX.client, code_verifier: grant.code_verifier }), timeoutMs: 20000 });
    if (exchange.status < 200 || exchange.status >= 300) throw new Error(`Could not finish the Codex sign-in (HTTP ${exchange.status}).`);
    const tokens = obj(safeParse(exchange.body));
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') throw new Error('Could not finish the Codex sign-in: OpenAI sent back no tokens.');
    const auth = obj(claims(tokens.id_token)['https://api.openai.com/auth']), exp = num(claims(tokens.access_token).exp);
    return { done: true, session: { refreshToken: tokens.refresh_token, ...(typeof auth.chatgpt_account_id === 'string' ? { accountId: auth.chatgpt_account_id } : {}),
      plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null },
      access: { token: tokens.access_token, ...(exp ? { expiresAtMs: exp * 1000 } : { expiresInS: num(tokens.expires_in) ?? 3600 }) } };
  },

  async renew(host, session) {
    const response = obj(await json(host, { url: `${CODEX.issuer}/oauth/token`, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX.client, grant_type: 'refresh_token', refresh_token: session.refreshToken, scope: 'openid profile email' }) }));
    if (typeof response.access_token !== 'string' || !response.access_token) return { access: { token: '' } };
    const auth = obj(claims(response.id_token)['https://api.openai.com/auth']), exp = num(claims(response.access_token).exp);
    return { access: { token: response.access_token, ...(exp ? { expiresAtMs: exp * 1000 } : { expiresInS: num(response.expires_in) ?? 3600 }) },
      ...(typeof response.refresh_token === 'string' && response.refresh_token ? { refreshToken: response.refresh_token } : {}),
      ...(typeof auth.chatgpt_account_id === 'string' ? { accountId: auth.chatgpt_account_id } : {}) };
  },
};
registerSignInFlow('codex', codexFlow);
