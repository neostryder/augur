// Ranks the models a task may use, and checks a job against the picks made for its caller. Pure.
import { DATA_TIERS, builtinProviders, pauseActive } from '@augur/core';
import type { ActivityId, DataTier, PolicyFile, WeightLevel } from '@augur/core';
import { boostFor, govern, listed, lookup, paceMeter, paceState, pacedProviders, reasonLine, resolveBalance, weeklyMeter } from './balance.js';
import type { Depth, ProseSwitch } from './balance.js';
import { seatsFor } from './seats.js';
import type { Seats } from './seats.js';
import { ageMinutes, freshLimits, modelOwners, pressure, usageFactors } from './pace.js';
import { LOCAL_PROVIDER, localId, localReading } from './fleet-pick.js';
import type { UsageSnapshot } from './pace.js';

export interface PickRequest {
  activity: ActivityId;
  dataTier: DataTier;
  caller?: 'interactive' | 'automated';
  gateState?: Record<string, boolean>;
  surplusState?: Record<string, { open: boolean; spent: number; openedAt?: number; resetsAt?: string; stale?: boolean }>;
  /** The model the person named for this task. It is the only way an ask-first model becomes a candidate. */
  named?: string;
  role?: string;
  /** How well each model fits the task, 0 to 1, judged by the caller. A model with no figure counts as 0.5. */
  fits?: Record<string, number>;
  /** How much the task weighs: routine, everyday, deep, or core. Left out, the activity decides. */
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
  /** Picks already made per route label: over the last 24 hours and within the caller's session. Picks where the route was named are left out. The service counts them. */
  spent?: { day: Record<string, number>; session: Record<string, number> };
}

const labelPrefix = (model: string): string => model.split('/')[0] as string;

/** Computes the next hysteresis state without changing persisted state. */
export function gateEvaluate(state: Record<string, boolean>, usage: UsageSnapshot | null, settings: { premium: string[]; paceLift: string[]; open: number; close: number }, now = new Date()): { state: Record<string, boolean>; gaps: Record<string, number | null> } {
  const next: Record<string, boolean> = {}, gaps: Record<string, number | null> = {};
  for (const provider of new Set([...settings.premium, ...settings.paceLift].map(label => label.split('/')[0] as string))) {
    const usageId = builtinProviders.find(p => p.labelPrefix === provider)?.id ?? provider;
    const gap = paceGap(usage, usageId, now), wasOpen = state[provider] === true;
    gaps[provider] = gap;
    next[provider] = !settings.paceLift.some(label => label.startsWith(`${provider}/`)) || gap === null ? false : wasOpen ? gap >= settings.close : gap >= settings.open;
  }
  return { state: next, gaps };
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
  gateState: Record<string, boolean>;
  gateGaps: Record<string, number | null>;
  surplus: Record<string, { open: boolean; hoursLeft: number | null; unused: number; budgetLeft: number; spent: boolean; resetsAt: string | null; stale: boolean }>;
}

export function surplusEvaluate(state: PickRequest['surplusState'], usage: UsageSnapshot | null, settings: ReturnType<typeof import('./balance.js').resolveBalance>['gate']['surplus'], now = new Date()): PickResult['surplus'] {
  const result: PickResult['surplus'] = {};
  for (const provider of settings.countdown) {
    const usageId = builtinProviders.find(p => p.labelPrefix === provider)?.id ?? provider;
    const source = usage?.providers[usageId];
    const isStale = !source || !!source.stale || ageMinutes(source, now) > freshLimits(source).ignoreMin;
    const meter = weeklyMeter(source?.meters);
    const meterReset = meter?.resetsAt && Number.isFinite(Date.parse(meter.resetsAt)) ? meter.resetsAt : null;
    const old = state?.[provider], storedReset = old?.resetsAt ?? null;
    const resetPassed = !!storedReset && Date.parse(storedReset) <= now.getTime();
    const hoursLeft = meterReset && Date.parse(meterReset) > now.getTime() && !isStale ? (Date.parse(meterReset) - now.getTime()) / 3600000 : null;
    const unused = meter && typeof meter.usedPct === 'number' ? Math.max(0, 100 - meter.usedPct) : 0;
    const usable = !!meterReset && Date.parse(meterReset) > now.getTime() && !isStale;
    const eligible = usable && settings.hours > 0 && (Date.parse(meterReset) - now.getTime()) / 3600000 <= settings.hours && unused >= settings.open;
    const open = settings.hours > 0 && old?.open && !resetPassed ? (isStale || (usable && unused >= settings.close)) : eligible;
    const resetsAt = old?.open && !resetPassed && storedReset ? storedReset : meterReset;
    const budgetLeft = Math.max(0, unused - settings.margin - (old?.open && !resetPassed ? old.spent : 0));
    result[provider] = { open, hoursLeft: resetsAt && Date.parse(resetsAt) > now.getTime() && !isStale ? (Date.parse(resetsAt) - now.getTime()) / 3600000 : null, unused, budgetLeft, spent: open && budgetLeft <= 0, resetsAt, stale: isStale };
  }
  return result;
}

/** The binding weekly window's elapsed share minus its used share, in percentage points. */
export function paceGap(usage: UsageSnapshot | null, provider: string, now = new Date()): number | null {
  const source = usage?.providers[provider];
  if (!source || ageMinutes(source, now) > freshLimits(source).ignoreMin) return null;
  const meters = (source.meters ?? []).filter(m => paceMeter(m) && m.windowKind === 'weekly' && m.resetsAt && typeof m.windowSeconds === 'number' && m.windowSeconds > 0);
  if (!meters.length) return null;
  const gaps = meters.map(m => {
    const elapsed = 1 - Math.max(0, Math.min(1, (Date.parse(m.resetsAt as string) - now.getTime()) / 1000 / (m.windowSeconds as number)));
    return elapsed * 100 - (m.usedPct as number);
  });
  return Math.round(Math.min(...gaps) * 10) / 10;
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
  const role = req.role ? policy.roles?.[req.role] : undefined;
  if (req.role && !role) notes.push(`Unknown role ${req.role}.`);
  const balance = resolveBalance((policy as { balance?: unknown }).balance), caller = req.caller ?? 'interactive';
  const { state: gateState, gaps: gateGaps } = gateEvaluate(req.gateState ?? {}, usage, balance.gate, now);
  const surplus = surplusEvaluate(req.surplusState, usage, balance.gate.surplus, now);
  if (!usage) notes.push('Augur usage file missing; usage not weighed.');
  const rows: Array<{ model: string; provider: string; level: WeightLevel }> = [], blocked: Blocked[] = [];
  for (const [provider, p] of Object.entries(policy.providers)) {
    for (const [model, m] of Object.entries(p.models)) {
      const paused = m.pause && pauseActive(m.pause, now) ? m.pause : null;
      if (req.role && !role?.candidates.includes(model)) { blocked.push({ model, why: `not a candidate for role ${req.role}` }); continue; }
      let level = m.activities[req.activity], why: string | null = null;
      if (paused) {
        const w = paused.weights;
        if (w === null || w === undefined) why = `paused until ${paused.until}${paused.reason ? `: ${paused.reason}` : ''}`;
        else if (w[req.activity] === null) why = `paused for ${req.activity} until ${paused.until}`;
        else if (w[req.activity]) level = w[req.activity] as WeightLevel;
      }
      if (m.status !== 'confirmed') why = `status ${m.status}`;
      else if (why) { /* paused */ }
      else if ((m.askFirst || balance.gate.premium.includes(model)) && model !== req.named && !(caller === 'interactive' && balance.gate.paceLift.includes(model) && (gateState[labelPrefix(model)] || (surplus[labelPrefix(model)]?.open && !surplus[labelPrefix(model)]?.spent && !surplus[labelPrefix(model)]?.stale)))) why = 'ask first: runs only when it is named';
      else if (!level) why = `not permitted ${req.activity}`;
      else if (DATA_TIERS.indexOf(m.dataTier) < DATA_TIERS.indexOf(req.dataTier)) why = `cleared for ${m.dataTier} data, task is ${req.dataTier}`;
      if (balance.gate.premium.includes(model) && caller === 'automated') why = 'premium models are not used for automated tasks';
      if (why) blocked.push({ model, why }); else rows.push({ model, provider, level: level as WeightLevel });
    }
  }
  holdBack(policy, press, rows, blocked, notes);
  const governed = govern(policy, req.activity, req.depth, rows.map(r => r.model), req.named, usage, now, req.proseSwitched ?? false, req.snippet === true);
  for (const b of governed.blocks) { const at = rows.findIndex(r => r.model === b.model); if (at >= 0) { rows.splice(at, 1); blocked.push(b); } }
  notes.push(...governed.notes);
  // A route over its cap leaves the running, unless the caller named it.
  const caps = resolveBalance((policy as { balance?: unknown }).balance).caps;
  for (const r of [...rows]) {
    const cap = lookup(caps, { label: r.model, provider: r.provider, id: policy.providers[r.provider]?.models[r.model]?.id ?? '' });
    if (!cap || r.model === req.named) continue;
    const day = req.spent?.day[r.model] ?? 0, session = req.spent?.session[r.model] ?? 0;
    const over = cap.perDay > 0 && day >= cap.perDay ? `${day} picks in the last 24 hours (limit ${cap.perDay})` : cap.perSession > 0 && session >= cap.perSession ? `${session} picks in this session (limit ${cap.perSession})` : '';
    if (over) { rows.splice(rows.indexOf(r), 1); blocked.push({ model: r.model, why: `capped: ${over}; name the route to use it anyway` }); }
  }
  // A local route is gated and nudged by the live fleet: a machine that is down blocks it, and a model that is not loaded or a machine short of memory lowers its score.
  const local = new Map<string, { factor: number; why: string }>();
  for (const r of [...rows]) {
    if (r.provider !== LOCAL_PROVIDER) continue;
    const id = localId(policy, r.model), read = id ? localReading(usage, id, now, req.dataTier) : null;
    if (!read) continue;
    if (read.blocked) { rows.splice(rows.indexOf(r), 1); blocked.push({ model: r.model, why: read.blocked }); } else local.set(r.model, read);
  }
  const rules = balance;
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
    const pressWhy = press[r.provider]?.why ?? '', nudgeWhy = local.get(r.model)?.why ?? '';
    const base =!nudgeWhy ? pressWhy : /^(plenty left|no Augur data)$/.test(pressWhy) || !pressWhy ? nudgeWhy : `${pressWhy}. ${nudgeWhy}`;
    // Those two notes are dropped by the reason line, so the boost sentence is not glued onto them.
    const quiet = /^(plenty left|no Augur data)$/.test(base);
    const why = boost > 1 && raw.why ? (base && !quiet ? `${base}. ${raw.why}` : raw.why) : base;
    const nudge = local.get(r.model)?.factor ?? 1;
    return { model: r.model, score: Math.round(fit * weight * factor * nudge * tilt * boost * 1000) / 1000, fit, level: r.level, weight, usage: Math.round(factor * nudge * 1000) / 1000, tilt, boost, odds: 0, why };
  }).sort((a, b) => b.score - a.score);
  const pool = applyOdds(ranking, rules.draw.tail);
  const top = ranking[0];
  const named = req.named && ranking.some(r => r.model === req.named) ? req.named : null;
  const canDraw = req.draw === true && req.best !== true && rules.draw.enabled && !role?.callerChooses && !named && !!top && top.score > 0 && pool.length > 0;
  let pick = role?.callerChooses && !named ? null : named ?? top?.model ?? null;
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
  for (const model of balance.gate.premium) {
    const b = blocked.find(x => x.model === model && /ask first/.test(x.why));
    if (b) b.why = `ask-first: owner approval required`;
  }
  for (const model of balance.gate.paceLift) {
    const entry = Object.values(policy.providers).map(p => p.models[model]).find(Boolean);
    if (caller === 'interactive' && model !== req.named && surplus[labelPrefix(model)]?.open && !surplus[labelPrefix(model)]?.spent && !surplus[labelPrefix(model)]?.stale && (entry?.askFirst || balance.gate.premium.includes(model)) && rows.some(r => r.model === model)) notes.push(`ask-first lifted: ${labelPrefix(model)} resets in ${Math.ceil(surplus[labelPrefix(model)]?.hoursLeft ?? 0)} hours with ${Math.floor(surplus[labelPrefix(model)]?.unused ?? 0)} points unused`);
    else if (caller === 'interactive' && model !== req.named && gateState[labelPrefix(model)] && (entry?.askFirst || balance.gate.premium.includes(model)) && rows.some(r => r.model === model)) notes.push(`ask-first lifted: ${labelPrefix(model)} is ${Math.round(gateGaps[labelPrefix(model)] ?? 0)} points behind pace`);
  }
  const result: PickResult = { pick, drawn, seed, ranking, blocked, scarcity, unreviewed: policy.unreviewed, notes, depth: governed.depth, reason, seats: seatsFor(policy, ranking, pick, req.activity, now), proseSwitch: governed.proseSwitch, gateState, gateGaps, surplus };
  Object.defineProperties(result, { gateState: { enumerable: false }, gateGaps: { enumerable: false } });
  return result;
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
