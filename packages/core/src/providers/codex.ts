import type { Host, ProviderPlugin, Meter } from '../types.js';
import { HttpError, json, obj, num, round, epoch, windowKind, windowLabel } from '../util.js';

const client = 'app_EMoamEEZ73f0CkXaXp7hrann';
const path = (host: Host) => host.env?.('CODEX_HOME') ? `${host.env!('CODEX_HOME')}/auth.json` : '.codex/auth.json';
async function read(host: Host) {
  const text = await host.readHomeFile?.(path(host));
  if (!text) throw new Error('Not signed in. Sign in to the Codex CLI on this computer.');
  try { return obj(JSON.parse(text)); } catch { throw new Error('The Codex login could not be read. Sign in to the Codex CLI again.'); }
}
function expires(token: string): number | null {
  try { return num(JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).exp); }
  catch { return null; }
}
async function tokens(host: Host, force = false): Promise<Record<string, any>> {
  const auth = await read(host), current = obj(auth.tokens);
  const exp = expires(String(current.access_token ?? ''));
  if (!force && exp && exp * 1000 > (host.now?.() ?? new Date()).getTime() + 300000) return current;
  const response = obj(await json(host, { url: 'https://auth.openai.com/oauth/token', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client, grant_type: 'refresh_token', refresh_token: current.refresh_token, scope: 'openid profile email' }) }));
  const latest = await read(host), target = obj(latest.tokens);
  for (const key of ['id_token', 'access_token', 'refresh_token']) if (response[key]) target[key] = response[key];
  latest.tokens = target;
  latest.last_refresh = (host.now?.() ?? new Date()).toISOString();
  if (!host.writeHomeFileAtomic) throw new Error('Could not save the renewed Codex login.');
  await host.writeHomeFileAtomic(path(host), JSON.stringify(latest));
  return target;
}

export const codex: ProviderPlugin = {
  id: 'codex', color: { light: '#1baf7a', dark: '#199e70' }, name: 'ChatGPT / Codex', needsLocalLogin: true,
  links: { usage: 'https://chatgpt.com/codex/settings/usage', status: 'https://status.openai.com/', statusApi: 'https://status.openai.com/api/v2/status.json' }, fields: [],
  detect: async host => !!(await host.readHomeFile?.(path(host))),
  async fetch(host) {
    const call = (auth: Record<string, any>) => json(host, { url: 'https://chatgpt.com/backend-api/wham/usage', headers: {
      Authorization: `Bearer ${auth.access_token}`, 'ChatGPT-Account-Id': String(auth.account_id ?? ''), 'User-Agent': 'codex_cli_rs/0.50.0' } });
    let data: Record<string, any>;
    try { data = obj(await call(await tokens(host))); }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 401) throw error; data = obj(await call(await tokens(host, true))); }
    const meters: Meter[] = [];
    const add = (prefix: string, label: string, rate: unknown) => {
      const rl = obj(rate);
      for (const key of ['primary_window', 'secondary_window']) {
        const w = obj(rl[key]); if (!Object.keys(w).length) continue;
        const seconds = num(w.limit_window_seconds), win = windowLabel(seconds);
        const name = win === 'weekly' ? 'Weekly limit' : win === '5h' ? '5-hour limit' : `${win} limit`;
        meters.push({ id: `${prefix}_${win}`, label: `${label}${name}`, usedPct: round(num(w.used_percent)), resetsAt: epoch(w.reset_at),
          windowSeconds: seconds, windowKind: windowKind(seconds) });
      }
    };
    add('plan', '', data.rate_limit);
    add('review', 'Code review, ', data.code_review_rate_limit);
    for (const item of Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []) {
      const extra = obj(item), name = String(extra.limit_name ?? extra.metered_feature ?? 'extra');
      add(name.toLowerCase().replaceAll(' ', '_'), `${name}, `, extra.rate_limit ?? extra);
    }
    const credits = obj(data.credits), resets = obj(data.rate_limit_reset_credits);
    const money = credits.has_credits && num(credits.balance) !== null ? [{ id: 'credits', label: 'Workspace credits', amount: round(num(credits.balance), 2), currency: 'USD' }] : [];
    const models = Object.fromEntries(Object.entries(obj(data.model_usage)).map(([key, value]) => [key, obj(value).available]));
    return { meters, money, plan: data.plan_type ?? null, notes: { resets_available: resets.available_count ?? null, limit_reached: obj(data.rate_limit).limit_reached ?? null, models } };
  }
};
