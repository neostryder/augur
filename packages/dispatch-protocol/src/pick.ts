// Ranks the models a task may use, and checks a job against the picks made for its caller. Pure.
import { DATA_TIERS, pauseActive } from '@augur/core';
import type { ActivityId, DataTier, PolicyFile, WeightLevel } from '@augur/core';
import { govern, reasonLine } from './balance.js';
import type { Depth, ProseSwitch } from './balance.js';
import { seatsFor } from './seats.js';
import type { Seats } from './seats.js';
import { modelOwners, pressure, usageFactors } from './pace.js';
import type { UsageSnapshot } from './pace.js';

export interface PickRequest {
  activity: ActivityId;
  dataTier: DataTier;
  /** The model the person named for this task. It is the only way an ask-first model becomes a candidate. */
  named?: string;
  /** How well each model fits the task, 0 to 1, judged by the caller. A model with no figure counts as 0.5. */
  fits?: Record<string, number>;
  /** Whether the task is deep thinking or serious coding, or everyday work. Left out, the activity decides. */
  depth?: Depth;
  /** Whether the prose pace switch was on at the last pick. The service keeps this, since the switch turns off at a lower lead than it turns on at. */
  proseSwitched?: boolean;
}

export interface Ranked { model: string; score: number; fit: number; level: WeightLevel; weight: number; usage: number; /** The balance's multiplier for this model, 1 when it did not tilt it. */ tilt: number; why: string }
export interface Blocked { model: string; why: string }
export interface PickResult { pick: string | null; ranking: Ranked[]; blocked: Blocked[]; scarcity: number; unreviewed: string[]; notes: string[]; depth: Depth; /** One sentence on why the top model won and what comes next. */ reason: string; /** The second opinion, web route and shadow that go with the pick. */ seats: Seats; /** Where the prose pace switch stands after this pick. */ proseSwitch: ProseSwitch }

/** Score is fit, times the weight of the activity's level, times the usage factor. A model that fails a rule is listed as blocked with the reason. */
export function rank(policy: PolicyFile, usage: UsageSnapshot | null, req: PickRequest, now = new Date()): PickResult {
  const press = pressure(policy, usage, now), notes: string[] = [];
  if (!usage) notes.push('Augur usage file missing; usage not weighed.');
  const rows: Array<{ model: string; provider: string; level: WeightLevel }> = [], blocked: Blocked[] = [];
  for (const [provider, p] of Object.entries(policy.providers)) {
    for (const [model, m] of Object.entries(p.models)) {
      const paused = m.pause && pauseActive(m.pause, now) ? m.pause : null;
      let level = m.activities[req.activity], why: string | null = null;
      if (paused) {
        const w = paused.weights;
        if (w === null || w === undefined) why = `paused until ${paused.until}${paused.reason ? `: ${paused.reason}` : ''}`;
        else if (w[req.activity] === null) why = `paused for ${req.activity} until ${paused.until}`;
        else if (w[req.activity]) level = w[req.activity] as WeightLevel;
      }
      if (m.status !== 'confirmed') why = `status ${m.status}`;
      else if (why) { /* paused */ }
      else if (m.askFirst && model !== req.named) why = 'ask first: runs only when it is named';
      else if (!level) why = `not permitted ${req.activity}`;
      else if (DATA_TIERS.indexOf(m.dataTier) < DATA_TIERS.indexOf(req.dataTier)) why = `cleared for ${m.dataTier} data, task is ${req.dataTier}`;
      if (why) blocked.push({ model, why }); else rows.push({ model, provider, level: level as WeightLevel });
    }
  }
  holdBack(policy, press, rows, blocked, notes);
  const governed = govern(policy, req.activity, req.depth, rows.map(r => r.model), req.named, usage, now, req.proseSwitched ?? false);
  for (const b of governed.blocks) { const at = rows.findIndex(r => r.model === b.model); if (at >= 0) { rows.splice(at, 1); blocked.push(b); } }
  notes.push(...governed.notes);
  const { factors, scarcity } = usageFactors(policy, press, rows.map(r => r.model));
  const ranking = rows.map(r => {
    const fit = req.fits?.[r.model] ?? 0.5, weight = policy.weights[r.level] ?? 1, factor = factors[r.model] ?? 1, tilt = governed.tilts[r.model] ?? 1;
    return { model: r.model, score: Math.round(fit * weight * factor * tilt * 1000) / 1000, fit, level: r.level, weight, usage: factor, tilt, why: press[r.provider]?.why ?? '' };
  }).sort((a, b) => b.score - a.score);
  const pick = ranking[0]?.model ?? null;
  return { pick, ranking, blocked, scarcity, unreviewed: policy.unreviewed, notes, depth: governed.depth, reason: reasonLine(ranking[0], ranking[1], governed, req.activity), seats: seatsFor(policy, ranking, pick, req.activity, now), proseSwitch: governed.proseSwitch };
}

/**
 * Takes out of the running every model that waits on others through `useAfter` while one of them can still do the task.
 * A model it waits on can do the task when it passed every rule above and its provider is not down. A spent provider still counts while a limit reset is in hand, since using the reset gives it room again. A model held back itself still counts, so a chain of waits keeps every link out until the first model is used up. A model in a circle of waits ignores them.
 * Rows and blocked are changed in place. Notes say when a model stays held only because a spent provider has a limit reset waiting.
 */
function holdBack(policy: PolicyFile, press: ReturnType<typeof pressure>, rows: Array<{ model: string; provider: string }>, blocked: Blocked[], notes: string[]): void {
  const owner = modelOwners(policy), entries = new Map<string, PolicyFile['providers'][string]['models'][string]>();
  for (const p of Object.values(policy.providers)) for (const [label, m] of Object.entries(p.models)) entries.set(label, m);
  const live = new Set(rows.map(r => r.model)), waits = (label: string) => (entries.get(label)?.useAfter ?? []).filter(l => l !== label && entries.has(l));
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => waits(from).some(l => l === target || (!seen.has(l) && !!seen.add(l) && reaches(l, target, seen)));
  const can = (label: string): boolean => {
    const h = press[owner[label] as string];
    return live.has(label) && !h?.down && (!h?.spent || (h.resets ?? 0) > 0);
  };
  for (const row of [...rows]) {
    const need = reaches(row.model, row.model) ? [] : waits(row.model);
    if (!need.length) continue;
    const first = need.find(can);
    if (!first) continue;
    rows.splice(rows.indexOf(row), 1);
    const h = press[owner[first] as string];
    if (h?.spent) {
      const k = h.resets ?? 0;
      blocked.push({ model: row.model, why: `use ${first} first: its plan is spent but ${k} limit ${k === 1 ? 'reset is' : 'resets are'} in hand, and ${row.model} waits until that is used` });
      notes.push(`${policy.providers[owner[first] as string]?.name ?? owner[first]} is spent with ${k} limit ${k === 1 ? 'reset' : 'resets'} in hand. Use ${k === 1 ? 'it' : 'one'} to keep the work on ${first}; ${row.model} stays held until then.`);
    } else blocked.push({ model: row.model, why: `use ${first} first: it still has usage and ${row.model} waits until it is spent, paused or unavailable` });
  }
}

/** One pick a caller made, as the service keeps it. */
export interface PickRecord { at: number; session: string | null; model: string; activity: string; dataTier: string; named: string | null; cleared: string[] }

export const PICK_WINDOW_MIN = 60;

export type PickCheck = { ok: true; note?: string } | { ok: false; reason: string };

/** A job may run when its model was picked for the caller within the window, was cleared by a pick, or was named for the task. */
export function checkPick(model: string, named: boolean, session: string | null, picks: readonly PickRecord[], now: number): PickCheck {
  if (named) return { ok: true };
  const recent = picks.filter(p => p.at >= now - PICK_WINDOW_MIN * 60000 && (!session || !p.session || p.session === session));
  if (recent.some(p => p.model === model || p.named === model)) return { ok: true };
  const cleared = recent.filter(p => p.cleared.includes(model));
  const last = cleared.at(-1);
  if (last) return { ok: true, note: `A pick ranked ${last.model} first and cleared ${model} too, so the reason ${model} was used instead is worth recording.` };
  const latest = recent.at(-1);
  return { ok: false, reason: `${model} was not picked for this task${latest ? ` (the latest pick was ${latest.model}, for ${latest.activity})` : ''}, and it was not named. Ask for a pick, or name the model.` };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The models a person's message names. A model is named by its label, its id, its display name, or the last part of its label (sol, luna, grok). */
export function matchNamedModels(policy: PolicyFile, text: string): string[] {
  const out: string[] = [];
  for (const p of Object.values(policy.providers)) {
    for (const [label, m] of Object.entries(p.models)) {
      const words = new Set<string>([label, label.split('/').pop() ?? label, m.id, m.name ?? ''].map(w => w.trim()).filter(w => w.length >= 2));
      const hit = [...words].some(w => new RegExp(String.raw`(?<![\w.-])${escapeRegex(w).replace(/[\s_-]+/g, String.raw`[\s_-]*`)}(?![\w-]|\.\w)`, 'i').test(text));
      if (hit) out.push(label);
    }
  }
  return out;
}

/** One message a person typed, reduced to the models it named. The text itself is not kept. */
export interface PromptRecord { at: number; session: string; models: string[] }

export const NAMED_PROMPT_WINDOW = 3;
export const NAMED_MAX_AGE_MIN = 360;

export type NamedCheck = { ok: true; via: 'interactive' | 'prompt' } | { ok: false; reason: string };

/** A claim that a person named the model holds when the person is at the keyboard, or when one of the caller session's newest few messages named it. `recent` is newest first. */
export function checkNamed(model: string, session: string | null, interactive: boolean, recent: readonly PromptRecord[], now: number): NamedCheck {
  if (interactive) return { ok: true, via: 'interactive' };
  if (!session) return { ok: false, reason: `The claim that ${model} was named has no session to check against.` };
  const found = recent.filter(p => p.session === session && p.at >= now - NAMED_MAX_AGE_MIN * 60000).slice(0, NAMED_PROMPT_WINDOW).some(p => p.models.includes(model));
  return found ? { ok: true, via: 'prompt' } : { ok: false, reason: `None of the last ${NAMED_PROMPT_WINDOW} messages from a person in this session named ${model}.` };
}
