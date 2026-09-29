// Ranks the models a task may use, and checks a job against the picks made for its caller. Pure.
import { DATA_TIERS, pauseActive } from '@augur/core';
import type { ActivityId, DataTier, PolicyFile, WeightLevel } from '@augur/core';
import { pressure, usageFactors } from './pace.js';
import type { UsageSnapshot } from './pace.js';

export interface PickRequest {
  activity: ActivityId;
  dataTier: DataTier;
  /** The model the person named for this task. It is the only way an ask-first model becomes a candidate. */
  named?: string;
  /** How well each model fits the task, 0 to 1, judged by the caller. A model with no figure counts as 0.5. */
  fits?: Record<string, number>;
}

export interface Ranked { model: string; score: number; fit: number; level: WeightLevel; weight: number; usage: number; why: string }
export interface Blocked { model: string; why: string }
export interface PickResult { pick: string | null; ranking: Ranked[]; blocked: Blocked[]; scarcity: number; unreviewed: string[]; notes: string[] }

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
  const { factors, scarcity } = usageFactors(policy, press, rows.map(r => r.model));
  const ranking = rows.map(r => {
    const fit = req.fits?.[r.model] ?? 0.5, weight = policy.weights[r.level] ?? 1, factor = factors[r.model] ?? 1;
    return { model: r.model, score: Math.round(fit * weight * factor * 1000) / 1000, fit, level: r.level, weight, usage: factor, why: press[r.provider]?.why ?? '' };
  }).sort((a, b) => b.score - a.score);
  return { pick: ranking[0]?.model ?? null, ranking, blocked, scarcity, unreviewed: policy.unreviewed, notes };
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
