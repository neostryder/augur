import type { ProviderPlugin } from '../types.js';
import { HttpError, json, obj, num, round, iso } from '../util.js';

/** One AI credit is billed at a hundredth of a dollar. */
const USD_PER_CREDIT = 0.01;
const DEFAULT_CAP_USD = 250;

/** The seat has no credit allowance of its own, so the meter measures use against a monthly spending cap the user sets. */
export function copilotCapCredits(setting: unknown): number {
  const usd = Number(setting);
  return Math.round((Number.isFinite(usd) && usd > 0 ? usd : DEFAULT_CAP_USD) / USD_PER_CREDIT);
}

export const copilot: ProviderPlugin = {
  id: 'copilot', color: { light: '#6e40c9', dark: '#a371f7' }, name: 'GitHub Copilot', needsLocalLogin: true,
  links: { usage: 'https://github.com/settings/copilot/features', status: 'https://www.githubstatus.com/', statusApi: 'https://www.githubstatus.com/api/v2/status.json' },
  fields: [{ key: 'capUsd', label: 'Monthly spending cap (USD)', kind: 'text', placeholder: String(DEFAULT_CAP_USD),
    help: 'The cap your organization set on this seat. The GitHub API does not report it, so the meter measures credits against this amount.' }],
  detect: async host => {
    if (!host.run) return false;
    try { return (await host.run('gh', ['auth', 'token'], 15000)).code === 0; } catch { return false; }
  },
  async fetch(host, settings) {
    if (!host.run) throw new Error('Copilot usage is read through the GitHub CLI, which this shell cannot run.');
    let token = '';
    try {
      const out = await host.run('gh', ['auth', 'token'], 15000);
      if (out.code === 0) token = out.stdout.trim();
    } catch { /* falls through to the sign-in message */ }
    if (!token) throw new Error('Not signed in. Run gh auth login on this computer.');
    let data: Record<string, any>;
    try { data = obj(await json(host, { url: 'https://api.github.com/copilot_internal/user', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'augur' } })); }
    catch (error) { if (error instanceof HttpError && [401, 403, 404].includes(error.status)) throw new Error('GitHub did not return Copilot usage for this login. Sign in again with gh auth login.'); throw error; }
    const snap = obj(obj(data.quota_snapshots).premium_interactions);
    const used = num(snap.credits_used);
    if (used === null) throw new Error('GitHub returned no Copilot credit count.');
    const cap = copilotCapCredits(settings.capUsd);
    const resetsAt = iso(data.quota_reset_date_utc ?? data.quota_reset_date);
    let windowSeconds: number | null = null;
    if (resetsAt) {
      const end = new Date(resetsAt), start = new Date(end);
      start.setUTCMonth(start.getUTCMonth() - 1);
      windowSeconds = Math.round((end.getTime() - start.getTime()) / 1000);
    }
    const spent = round(used * USD_PER_CREDIT, 2), capUsd = round(cap * USD_PER_CREDIT, 2);
    return {
      plan: data.copilot_plan ? `Copilot ${data.copilot_plan}` : 'Copilot',
      meters: [{ id: 'monthly_credits', label: 'Monthly credits', usedPct: round(used / cap * 100), resetsAt, windowSeconds, windowKind: 'monthly',
        detail: `${used} of ${cap} credits` }],
      money: [{ id: 'spent', label: 'Spent this month', amount: spent, currency: 'USD', total: capUsd }],
      notes: { credits_used: used, credits_cap: cap, overage_permitted: snap.overage_permitted ?? null }
    };
  }
};
