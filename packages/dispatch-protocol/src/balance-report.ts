// The read-only balance report: what the router is doing now and what it has been doing, in one structure that the command, the tool, the apps and the daily file all share. Pure.
import { ACTIVITIES } from '@augur/core';
import type { ActivityId, PolicyFile } from '@augur/core';
import { claudeState, copilotSpend, plural, proseSwitchState, resolveBalance } from './balance.js';
import type { ClaudeStance, Depth, PaceTrack, ProseSwitch } from './balance.js';
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
  /** Each pick that landed on a Copilot model, oldest first, with the month's spend when it was made. */
  copilot?: Array<{ at: string; activity: string; model: string; spend: number | null }>;
}

export interface BalanceReport {
  at: string;
  enabled: boolean;
  claude: { stance: ClaudeStance; lean: string; peak: number | null; reserve: number; band: number; atReserve: boolean; tracks: PaceTrack[]; /** Where the prose pace switch stands. Reports written before the switch existed have none. */ prose?: ProseSwitch };
  copilot: { spend: number | null; aim: number; cap: number; zone: 'unknown' | 'under the aim' | 'past the aim' | 'at the cap' };
  providers: ProviderLine[];
  mix: MixLine[];
  excluded: string[];
  picks: PickSummary | null;
}

export function balanceReport(policy: PolicyFile, usage: UsageSnapshot | null, now: Date, picks: PickSummary | null = null, tier: 'public' | 'internal' | 'sensitive' | 'regulated' = 'internal', proseSwitched = false): BalanceReport {
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
    const r = rank(policy, usage, { activity, dataTier: tier, proseSwitched }, now);
    return { activity, depth: r.depth, pick: r.pick, next: r.ranking[1]?.model ?? null, reason: r.reason, second: r.seats.second?.model ?? null, web: r.seats.web?.model ?? null };
  });
  return {
    at: now.toISOString(), enabled: rules.enabled,
    claude: { stance: state.stance, lean, peak: state.peak, reserve: rules.claude.reserve, band: rules.claude.band, atReserve: state.atReserve, tracks: state.tracks, prose: rules.enabled ? proseSwitchState(rules, state, proseSwitched) : { ...proseSwitchState(rules, state, proseSwitched), on: false } },
    copilot: { spend, aim: rules.fallback.aim, cap: rules.fallback.cap, zone },
    providers, mix, excluded: rules.exclude, picks,
  };
}

const pct = (n: number) => `${Math.round(n)}%`;

export interface ReportSection { title: string; lines: string[] }

/** The headline of the report, one line, for a page title or the top of a file. */
export const reportHeading = (r: BalanceReport): string => `Balance report, ${r.at.slice(0, 16).replace('T', ' ')} UTC${r.enabled ? '' : ' (the balance is switched off)'}`;

/** The report as titled groups of plain lines. The window app, the terminal app, the command and the daily file all show these same words. */
export function reportSections(r: BalanceReport): ReportSection[] {
  const out: ReportSection[] = [];
  const c = r.claude, claude: string[] = [];
  if (c.tracks.length) for (const t of c.tracks) claude.push(`${t.window}: ${pct(t.used)} used, ${pct(t.elapsed)} of the time gone, ${t.used >= 99 ? 'spent' : `${plural(Math.abs(Math.round(t.ahead)), 'point')} ${t.ahead >= 0 ? 'ahead of' : 'behind'} pace`}`);
  else claude.push('no usable figures');
  claude.push(`stance: ${c.stance}, leaning to ${c.lean}. The band is ${plural(c.band, 'point')} and the reserve is ${c.reserve}%${c.atReserve ? ', and a window is at it' : ''}.`);
  const sw = c.prose;
  if (sw && (sw.ahead !== null || sw.on)) claude.push(sw.on ? `prose: moved off Claude (${sw.ahead === null ? 'figures missing' : (c.peak ?? 0) >= 99 ? 'Claude is spent' : `${plural(Math.round(sw.ahead), 'point')} ahead of pace`}); it comes back when the lead falls to ${plural(sw.returnAt, 'point')}` : `prose: stays on Claude; it moves when the lead passes ${plural(sw.threshold, 'point')}`);
  out.push({ title: 'Claude', lines: claude });
  out.push({ title: 'Copilot', lines: [`spend this month: ${r.copilot.spend === null ? 'unknown' : `$${r.copilot.spend.toFixed(2)}`}, ${r.copilot.zone} ($${r.copilot.aim} aim, $${r.copilot.cap} cap)`] });
  out.push({ title: 'Providers', lines: r.providers.map(p => `${p.name.padEnd(22)} ${p.stance.padEnd(7)} ${p.headroom === null ? 'no figures' : `${pct(p.headroom * 100)} room`}${p.spent ? ', spent' : ''}, ${p.why}`) });
  out.push({ title: 'What each kind of work goes to now', lines: r.mix.map(m => `${m.activity.padEnd(18)} ${m.depth.padEnd(9)} ${(m.pick ?? 'nothing allowed').padEnd(26)} next ${m.next ?? '-'}${m.second ? `, second opinion ${m.second}` : ''}${m.web ? `, web ${m.web}` : ''}`) });
  out.push({ title: 'Never picked', lines: [`${r.excluded.join(', ') || 'nothing'}.`] });
  if (r.picks) {
    const k = r.picks, lines = [`Last ${k.days} ${k.days === 1 ? 'day' : 'days'}: ${k.picks} picks, ${k.jobs} jobs, ${k.overrides} ran on a model other than the pick.`];
    const onCopilot = Object.values(k.byActivity).reduce((n, models) => n + Object.entries(models).filter(([m]) => m.startsWith('copilot/')).reduce((x, [, c]) => x + c, 0), 0);
    if (onCopilot) lines.push(`${onCopilot} of those went to Copilot${r.copilot.spend === null ? '' : `, which stands at $${r.copilot.spend.toFixed(2)} for the month`}.`);
    if (k.copilot?.length) {
      lines.push('Copilot picks, each billed at API price:');
      for (const c of k.copilot) lines.push(`  ${c.at.slice(0, 16).replace('T', ' ')} UTC ${c.activity} on ${c.model}${c.spend === null ? '' : `, month at $${c.spend.toFixed(2)}${c.spend >= r.copilot.aim ? ', past the aim' : ''}`}`);
    }
    for (const [activity, models] of Object.entries(k.byActivity)) lines.push(`${activity.padEnd(18)} ${Object.entries(models).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ')}`);
    out.push({ title: 'The pick log', lines });
  }
  return out;
}

/** The report as plain lines for a terminal, a file or a tool result. */
export function renderReport(r: BalanceReport): string[] {
  const out = [reportHeading(r)];
  for (const sec of reportSections(r)) { out.push('', sec.title, ...sec.lines.map(l => `  ${l}`)); }
  return out;
}
