// Ranks the models a task may use, and checks a job against the picks made for its caller. Pure.
import { DATA_TIERS, pauseActive } from '@augur/core';
import type { ActivityId, DataTier, PolicyFile, WeightLevel } from '@augur/core';
import { boostFor, govern, listed, paceState, pacedProviders, reasonLine, resolveBalance } from './balance.js';
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
  /** Draw the pick from the odds. Left out or false, the top score wins. */
  draw?: boolean;
  /** Take the top score even when a draw was asked for. */
  best?: boolean;
  /** Repeats a draw. A number is read as its decimal text. Left out, the draw makes one and returns it. */
  seed?: number | string;
  /** One sentence or one bullet, with no prose batch to attach it to. */
  snippet?: boolean;
}

export interface Ranked {
  model: string; score: number; fit: number; level: WeightLevel; weight: number; usage: number;
  /** The balance's multiplier for this model, 1 when it did not tilt it. */
  tilt: number;
  /** The unused-allowance multiplier, 1 when this route was not boosted. */
  boost: number;
  /** This route's share of the draw, 0 when it was left out or nothing can be drawn. */
  odds: number;
  why: string;
}
export interface Blocked { model: string; why: string }
export interface PickResult {
  pick: string | null;
  /** True when the pick was drawn from the odds. */
  drawn: boolean;
  /** The seed of this draw, or null when the top route was taken. */
  seed: string | null;
  ranking: Ranked[]; blocked: Blocked[]; scarcity: number; unreviewed: string[]; notes: string[]; depth: Depth;
  /** One sentence on why the pick won and what comes next. */
  reason: string;
  /** The second opinion, web route and shadow that go with the pick. */
  seats: Seats;
  /** Where the prose pace switch stands after this pick. */
  proseSwitch: ProseSwitch;
}

/** FNV-1a, so the same seed string always starts the generator at the same place. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32. One call returns a number in [0, 1), and the same seed repeats the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Odds are each route's score over the scores still in the draw. A route under `tail` of the top score is left out of the draw only. */
function applyOdds(ranking: Ranked[], tail: number): Ranked[] {
  const top = ranking[0]?.score ?? 0;
  const pool = top > 0 ? ranking.filter(r => r.score > 0 && r.score >= tail * top) : [];
  const sum = pool.reduce((s, r) => s + r.score, 0);
  const kept = new Set(pool);
  for (const r of ranking) r.odds = kept.has(r) && sum > 0 ? Math.round(r.score / sum * 1000) / 1000 : 0;
  return pool;
}

function drawFrom(pool: Ranked[], rnd: () => number): Ranked {
  const sum = pool.reduce((s, r) => s + r.score, 0);
  let mark = rnd() * sum;
  for (const r of pool) { mark -= r.score; if (mark < 0) return r; }
  return pool[pool.length - 1] as Ranked;
}

/** Score is fit, times the weight of the activity's level, times the usage factor, times the tilt, times the boost. A model that fails a rule is listed as blocked with the reason. */
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
  const governed = govern(policy, req.activity, req.depth, rows.map(r => r.model), req.named, usage, now, req.proseSwitched ?? false, req.snippet === true);
  for (const b of governed.blocks) { const at = rows.findIndex(r => r.model === b.model); if (at >= 0) { rows.splice(at, 1); blocked.push(b); } }
  notes.push(...governed.notes);
  const rules = resolveBalance((policy as { balance?: unknown }).balance);
  const paced = rules.enabled ? new Set(pacedProviders(usage, rules, now)) : new Set<string>();
  const providerBoost = new Map<string, { boost: number; why: string }>();
  const { factors, scarcity } = usageFactors(policy, press, rows.map(r => r.model));
  const ranking = rows.map(r => {
    const given = req.fits?.[r.model], fit = given ?? 0.5, weight = policy.weights[r.level] ?? 1, factor = factors[r.model] ?? 1, tilt = governed.tilts[r.model] ?? 1;
    let raw = providerBoost.get(r.provider);
    if (!raw) {
      raw = paced.has(r.provider) ? boostFor(paceState(usage, rules, r.provider, now), usage, rules, now) : { boost: 1, why: '' };
      providerBoost.set(r.provider, raw);
    }
    // A caller fit under the floor means the route suits the task badly. No figure means the caller does not know.
    // Prose stays on the Opus routes: a drafting request does not boost a route that is not on the prose list, unless it is a snippet.
    const offList = req.activity === 'draft_prose' && req.snippet !== true && rules.prose.models.length > 0 && !listed(rules.prose.models, { label: r.model, provider: r.provider, id: policy.providers[r.provider]?.models[r.model]?.id ?? '' });
    const boost = !offList && (given === undefined || given >= rules.boostFitFloor) ? raw.boost : 1;
    const base = press[r.provider]?.why ?? '';
    // Those two notes are dropped by the reason line, so the boost sentence is not glued onto them.
    const quiet = /^(plenty left|no Augur data)$/.test(base);
    const why = boost > 1 && raw.why ? (base && !quiet ? `${base}. ${raw.why}` : raw.why) : base;
    return { model: r.model, score: Math.round(fit * weight * factor * tilt * boost * 1000) / 1000, fit, level: r.level, weight, usage: factor, tilt, boost, odds: 0, why };
  }).sort((a, b) => b.score - a.score);
  const pool = applyOdds(ranking, rules.draw.tail);
  const top = ranking[0];
  const named = req.named && ranking.some(r => r.model === req.named) ? req.named : null;
  const canDraw = req.draw === true && req.best !== true && rules.draw.enabled && !named && !!top && top.score > 0 && pool.length > 0;
  let pick = named ?? top?.model ?? null;
  let drawn = false, seed: string | null = null;
  if (canDraw) {
    // node:crypto is not visible to the browser packages that compile this file.
    const drawSeed = req.seed === undefined ? globalThis.crypto.randomUUID() : String(req.seed);
    seed = drawSeed;
    drawn = true;
    pick = drawFrom(pool, mulberry32(hash32(drawSeed))).model;
  }
  const chosen = ranking.find(r => r.model === pick);
  const next = ranking.find(r => r.model !== pick);
  const reason = drawn && chosen && top && chosen.model !== top.model
    ? reasonLine(top, next, governed, req.activity, { model: chosen.model, odds: chosen.odds })
    : reasonLine(chosen, next, governed, req.activity);
  return { pick, drawn, seed, ranking, blocked, scarcity, unreviewed: policy.unreviewed, notes, depth: governed.depth, reason, seats: seatsFor(policy, ranking, pick, req.activity, now), proseSwitch: governed.proseSwitch };
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

/** One pick a caller made, as the service keeps it. `odds`, `drawn` and `seed` are absent on a line written before draws were logged. */
export interface PickRecord { at: number; session: string | null; model: string; activity: string; dataTier: string; named: string | null; cleared: string[]; odds?: number; drawn?: boolean; seed?: string | null }

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
