import type { Host, ProviderPlugin, Meter } from '../types.js';
import { HttpError, json, obj, num, round, iso } from '../util.js';

const file = '.claude/.credentials.json';
const service = 'Claude Code-credentials';
const client = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

async function read(host: Host): Promise<{ data: Record<string, any>; keychain: boolean }> {
  const account = host.env?.('USER') ?? undefined;
  const keychainText = host.platform === 'macos' ? await host.keychainGet?.(service, account) : null;
  const text = keychainText ?? await host.readHomeFile?.(file);
  if (!text) throw new Error('Not signed in. Sign in to Claude Code on this computer.');
  try { return { data: obj(JSON.parse(text)), keychain: !!keychainText }; }
  catch { throw new Error('The Claude login could not be read. Sign in to Claude Code again.'); }
}

async function refresh(host: Host): Promise<string> {
  const current = await read(host);
  const oauth = obj(current.data.claudeAiOauth);
  const response = obj(await json(host, { url: 'https://platform.claude.com/v1/oauth/token', method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: client }) }));
  if (!response.access_token) throw new Error('Could not renew the Claude login. Sign in to Claude Code again.');
  const latest = await read(host);
  const target = obj(latest.data.claudeAiOauth);
  target.accessToken = response.access_token;
  if (response.refresh_token) target.refreshToken = response.refresh_token;
  target.expiresAt = (host.now?.() ?? new Date()).getTime() + (num(response.expires_in) ?? 3600) * 1000;
  if (response.scope) target.scopes = String(response.scope).split(' ');
  latest.data.claudeAiOauth = target;
  const value = JSON.stringify(latest.data);
  if (latest.keychain) {
    if (!host.keychainSet) throw new Error('Could not save the renewed Claude login.');
    await host.keychainSet(service, host.env?.('USER') ?? '', value);
  } else {
    if (!host.writeHomeFileAtomic) throw new Error('Could not save the renewed Claude login.');
    await host.writeHomeFileAtomic(file, value);
  }
  return target.accessToken;
}

/** Renews the Claude Code login once on a 401 and tries the call again. */
async function withLogin(host: Host, call: (token: string) => Promise<unknown>): Promise<Record<string, any>> {
  const oauth = obj((await read(host)).data.claudeAiOauth);
  let token = num(oauth.expiresAt) !== null && Number(oauth.expiresAt) > (host.now?.() ?? new Date()).getTime() + 300000 ? oauth.accessToken : await refresh(host);
  try { return obj(await call(token)); }
  catch (error) { if (!(error instanceof HttpError) || error.status !== 401) throw error; token = await refresh(host); return obj(await call(token)); }
}

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1' });

export const claude: ProviderPlugin = {
  id: 'claude', color: { light: '#eb6834', dark: '#d95926' }, name: 'Claude', needsLocalLogin: true,
  links: { usage: 'https://claude.ai/settings/usage', status: 'https://status.claude.com/', statusApi: 'https://status.claude.com/api/v2/status.json' }, fields: [],
  detect: async host => { try { await read(host); return true; } catch { return false; } },
  async fetch(host) {
    const data = await withLogin(host, token => json(host, { url: 'https://api.anthropic.com/api/oauth/usage', headers: headers(token) }));
    const meters: Meter[] = [];
    for (const row of Array.isArray(data.limits) ? data.limits : []) {
      const limit = obj(row), kind = String(limit.kind ?? ''), scope = obj(obj(limit.scope).model).display_name;
      const label = kind === 'session' ? 'Current session' : kind === 'weekly_all' ? 'Weekly, all models' : scope ? `Weekly, ${scope}` : kind.replaceAll('_', ' ');
      const seconds = limit.group === 'session' ? 18000 : limit.group === 'weekly' ? 604800 : null;
      meters.push({ id: scope ? `${kind}_${String(scope).toLowerCase()}` : kind, label, usedPct: round(num(limit.percent)), resetsAt: iso(limit.resets_at),
        windowSeconds: seconds, windowKind: limit.group === 'session' ? 'session' : limit.group === 'weekly' ? 'weekly' : 'other', active: limit.is_active ?? null });
    }
    if (!meters.length) for (const [key, label, seconds, kind] of [
      ['five_hour', 'Current session', 18000, 'session'], ['seven_day', 'Weekly, all models', 604800, 'weekly'],
      ['seven_day_opus', 'Weekly, Opus', 604800, 'weekly'], ['seven_day_sonnet', 'Weekly, Sonnet', 604800, 'weekly']
    ] as const) {
      const value = data[key]; if (!value) continue;
      meters.push({ id: key, label, usedPct: round(num(value.utilization)), resetsAt: iso(value.resets_at), windowSeconds: seconds, windowKind: kind });
    }
    const extra = obj(data.extra_usage), spend = obj(data.spend), used = obj(spend.used);
    const money = extra.is_enabled && num(used.amount_minor) !== null ? [{ id: 'extra', label: 'Extra usage spend',
      amount: round(Number(used.amount_minor) / 10 ** (num(used.exponent) ?? 2), 2), currency: String(used.currency ?? 'USD') }] : [];
    const latest = await read(host);
    return { plan: obj(latest.data.claudeAiOauth).subscriptionType ?? null, meters, money,
      notes: { extra_usage_enabled: !!extra.is_enabled, spend_percent: spend.percent ?? null } };
  },
  async listModels(host) {
    const data = await withLogin(host, token => json(host, { url: 'https://api.anthropic.com/v1/models?limit=100', headers: { ...headers(token), 'anthropic-version': '2023-06-01' } }));
    return (Array.isArray(data.data) ? data.data : []).map(obj).filter(m => typeof m.id === 'string').map(m => ({ id: m.id, name: typeof m.display_name === 'string' ? m.display_name : undefined }));
  }
};
