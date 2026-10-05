// The read-only balance report: what the router is doing now and what it has been doing, in one structure that the command, the tool, the apps and the daily file all share. Pure.
import { ACTIVITIES } from '@augur/core';
import type { ActivityId, PolicyFile } from '@augur/core';
import { claudeState, copilotSpend, resolveBalance } from './balance.js';
import type { ClaudeStance, Depth, PaceTrack } from './balance.js';
import { drainProviders, pressure } from './pace.js';
import type { UsageSnapshot } from './pace.js';
import { rank } from './pick.js';

/** How a provider is treated: paced against its windows, spent in full before others wait on it, held as a backup, or free. */
export type Stance = 'paced' | 'drain' | 'backup' | 'free';

export interface ProviderLine { id: string; name: string; stance: Stance; /** 0 to 1, or null with no figures. */ headroom: number | null; why: string; spent: boolean }
export interface MixLine { activity: ActivityId; depth: Depth; pick: string | null; next: string | null; reason: string; second: string | null; web: string | null }

/** What the pick log says about a stretch of time. Built by the service, which owns the log. */
export interface PickSummary {
  days: number;
  picks: number;
  /** Picks per activity and model. */
  byActivity: Record<string, Record<string, number>>;
  /** Jobs that ran on another model than the one picked. */
  overrides: number;
  jobs: number;
}

export interface BalanceReport {
  at: string;
  enabled: boolean;
  claude: { stance: ClaudeStance; lean: string; peak: number | null; reserve: number; band: number; atReserve: boolean; tracks: PaceTrack[] };
  copilot: { spend: number | null; aim: number; cap: number; zone: 'unknown' | 'under the aim' | 'past the aim' | 'at the cap' };
  providers: ProviderLine[];
  mix: MixLine[];
  excluded: string[];
  picks: PickSummary | null;
}

export function balanceReport(policy: PolicyFile, usage: UsageSnapshot | null, now: Date, picks: PickSummary | null = null, tier: 'public' | 'internal' | 'sensitive' | 'regulated' = 'internal'): BalanceReport {
  const rules = resolveBalance((policy as { balance?: unknown }).balance);
  const state = claudeState(usage, rules, now);
  const lean = state.stance === 'hot' ? 'Sonnet' : state.stance === 'behind' ? 'Opus' : state.stance === 'unknown' ? 'Sonnet (figures missing)' : 'neither';
  const spend = copilotSpend(usage), counted = spend === null ? null : spend + rules.fallback.margin;
  const zone = counted === null ? 'unknown' : counted >= rules.fallback.cap ? 'at the cap' : counted >= rules.fallback.aim ? 'past the aim' : 'under the aim';
  const press = pressure(policy, usage, now), drain = drainProviders(policy);
  const providers: ProviderLine[] = Object.entries(policy.providers).filter(([, p]) => Object.keys(p.models).length).map(([id, p]) => {
    const free = Object.values(p.models).every(m => m.cost === 'free');
    const stance: Stance = rules.fallback.providers.includes(id) ? 'backup' : drain.has(id) ? 'drain' : free ? 'free' : 'paced';
    const h = press[id];
    return { id, name: p.name, stance, headroom: h ? h.headroom : null, why: h?.why ?? 'no Augur data', spent: !!h?.spent };
  });
  const mix: MixLine[] = ACTIVITIES.map(activity => {
    const r = rank(policy, usage, { activity, dataTier: tier }, now);
    return { activity, depth: r.depth, pick: r.pick, next: r.ranking[1]?.model ?? null, reason: r.reason, second: r.seats.second?.model ?? null, web: r.seats.web?.model ?? null };
  });
  return {
    at: now.toISOString(), enabled: rules.enabled,
    claude: { stance: state.stance, lean, peak: state.peak, reserve: rules.claude.reserve, band: rules.claude.band, atReserve: state.atReserve, tracks: state.tracks },
    copilot: { spend, aim: rules.fallback.aim, cap: rules.fallback.cap, zone },
    providers, mix, excluded: rules.exclude, picks,
  };
}

const pct = (n: number) => `${Math.round(n)}%`;

/** The report as plain lines for a terminal, a file or a tool result. */
export function renderReport(r: BalanceReport): string[] {
  const out: string[] = [];
  out.push(`Balance report, ${r.at.slice(0, 16).replace('T', ' ')} UTC${r.enabled ? '' : ' (the balance is switched off)'}`);
  out.push('');
  const c = r.claude;
  out.push('Claude');
  if (c.tracks.length) for (const t of c.tracks) out.push(`  ${t.window}: ${pct(t.used)} used, ${pct(t.elapsed)} of the time gone, ${Math.abs(Math.round(t.ahead))} points ${t.ahead >= 0 ? 'ahead of' : 'behind'} pace`);
  else out.push('  no usable figures');
  out.push(`  stance: ${c.stance}, leaning to ${c.lean}. The band is ${c.band} points and the reserve is ${c.reserve}%${c.atReserve ? ', and a window is at it' : ''}.`);
  out.push('');
  out.push('Copilot');
  out.push(`  spend this month: ${r.copilot.spend === null ? 'unknown' : `$${r.copilot.spend.toFixed(2)}`}, ${r.copilot.zone} ($${r.copilot.aim} aim, $${r.copilot.cap} cap)`);
  out.push('');
  out.push('Providers');
  for (const p of r.providers) out.push(`  ${p.name.padEnd(22)} ${p.stance.padEnd(7)} ${p.headroom === null ? 'no figures' : `${pct(p.headroom * 100)} room`}${p.spent ? ', spent' : ''}, ${p.why}`);
  out.push('');
  out.push('What each kind of work goes to now');
  for (const m of r.mix) out.push(`  ${m.activity.padEnd(18)} ${m.depth.padEnd(9)} ${(m.pick ?? 'nothing allowed').padEnd(26)} next ${m.next ?? '-'}${m.second ? `, second opinion ${m.second}` : ''}${m.web ? `, web ${m.web}` : ''}`);
  out.push('');
  out.push(`Never picked: ${r.excluded.join(', ') || 'nothing'}.`);
  if (r.picks) {
    out.push('');
    out.push(`Last ${r.picks.days} ${r.picks.days === 1 ? 'day' : 'days'}: ${r.picks.picks} picks, ${r.picks.jobs} jobs, ${r.picks.overrides} ran on a model other than the pick.`);
    for (const [activity, models] of Object.entries(r.picks.byActivity)) out.push(`  ${activity.padEnd(18)} ${Object.entries(models).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ')}`);
  }
  return out;
}
