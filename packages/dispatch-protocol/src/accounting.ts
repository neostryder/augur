// What a job cost, with every figure labelled by how sure Augur is of it. Pure.
//   reported  the harness or the provider gave the number
//   derived   arithmetic on reported numbers: reported tokens times a rate the owner set
//   imputed   an estimate: tokens guessed from text length, or a cost from those tokens
// An imputed figure is only produced when the route's own finished jobs show the guess is close, and it carries the error measured there. A figure
// that cannot be backed that way is left out, never filled in. There is no fit against plan quotas: a subscription's quota moves in units the provider
// does not publish, so the quota meters stay as the providers report them.
import type { JobRecord } from './spec.js';

export type Provenance = 'reported' | 'derived' | 'imputed';
export interface Figure { value: number; provenance: Provenance; /** Typical relative error of an imputed figure, as measured on the route's reported jobs (0.2 is 20%). */ error?: number }
export interface Accounted { inputTokens: Figure | null; outputTokens: Figure | null; costUsd: Figure | null }

/** Dollars per million tokens for a model, set by the owner. Input rates apply to input tokens that were not served from cache. */
export interface Rate { inputPerM: number; outputPerM: number; cachedReadPerM?: number; cachedWritePerM?: number }
export type RateCard = Record<string, Rate>;

/** A route's characters per token, measured on its own reported jobs. */
export interface Calibration { charsPerToken: number; samples: number; /** Median absolute relative error of the estimate over the samples. */ error: number }
export interface RouteCalibration { input: Calibration | null; output: Calibration | null }

/** A calibration needs this many samples, and is dropped when its typical error is worse than this. */
export const CALIBRATION = { minSamples: 8, maxError: 0.35 } as const;

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export function calibrate(samples: ReadonlyArray<{ chars: number; tokens: number }>): Calibration | null {
  const ok = samples.filter(s => s.chars > 0 && s.tokens > 0);
  if (ok.length < CALIBRATION.minSamples) return null;
  const charsPerToken = median(ok.map(s => s.chars / s.tokens));
  const error = median(ok.map(s => Math.abs(s.chars / charsPerToken - s.tokens) / s.tokens));
  return error > CALIBRATION.maxError ? null : { charsPerToken, samples: ok.length, error };
}

/** Calibrations per route, from jobs whose harness reported token counts and whose text lengths were recorded. */
export function calibrateRoutes(jobs: readonly JobRecord[]): Record<string, RouteCalibration> {
  const by = new Map<string, JobRecord[]>();
  for (const j of jobs) if (j.usage) by.set(j.route, [...(by.get(j.route) ?? []), j]);
  const out: Record<string, RouteCalibration> = {};
  for (const [route, js] of by) {
    out[route] = {
      input: calibrate(js.flatMap(j => j.promptChars ? [{ chars: j.promptChars, tokens: j.usage!.inputTokens }] : [])),
      output: calibrate(js.flatMap(j => j.answerChars ? [{ chars: j.answerChars, tokens: j.usage!.outputTokens + (j.usage!.reasoningTokens ?? 0) }] : [])),
    };
  }
  return out;
}

const per = (n: number, rate: number) => (n / 1_000_000) * rate;

/** Cost from token counts. Null when the counts include cached tokens the rate card does not price, since guessing their price would misstate the cost. */
export function costFor(input: number, output: number, cachedRead: number, cachedWrite: number, rate: Rate): number | null {
  if (cachedRead > 0 && rate.cachedReadPerM === undefined) return null;
  if (cachedWrite > 0 && rate.cachedWritePerM === undefined) return null;
  const fresh = Math.max(input - cachedRead - cachedWrite, 0);
  return per(fresh, rate.inputPerM) + per(output, rate.outputPerM) + per(cachedRead, rate.cachedReadPerM ?? 0) + per(cachedWrite, rate.cachedWritePerM ?? 0);
}

export function account(job: JobRecord, model: string | null, rates: RateCard, cal: RouteCalibration | undefined): Accounted {
  const u = job.usage, rate = model ? rates[model] : undefined;
  const reported = (value: number): Figure => ({ value, provenance: 'reported' });
  let inputTokens: Figure | null = u ? reported(u.inputTokens) : null;
  let outputTokens: Figure | null = u ? reported(u.outputTokens + (u.reasoningTokens ?? 0)) : null;
  if (!u) {
    if (cal?.input && job.promptChars) inputTokens = { value: Math.round(job.promptChars / cal.input.charsPerToken), provenance: 'imputed', error: cal.input.error };
    if (cal?.output && job.answerChars) outputTokens = { value: Math.round(job.answerChars / cal.output.charsPerToken), provenance: 'imputed', error: cal.output.error };
  }
  let costUsd: Figure | null = null;
  if (u?.costUsd !== undefined) costUsd = reported(u.costUsd);
  else if (rate && u) {
    const c = costFor(u.inputTokens, u.outputTokens + (u.reasoningTokens ?? 0), u.cachedReadTokens ?? 0, u.cachedWriteTokens ?? 0, rate);
    if (c !== null) costUsd = { value: c, provenance: 'derived' };
  } else if (rate && inputTokens?.provenance === 'imputed' && outputTokens?.provenance === 'imputed') {
    // A cost from guessed tokens carries the error of the larger share, since that share sets how far the total can be off. Cache use is unknown, so it is priced as fresh input.
    const inCost = per(inputTokens.value, rate.inputPerM), outCost = per(outputTokens.value, rate.outputPerM);
    const error = inCost >= outCost ? inputTokens.error! : outputTokens.error!;
    costUsd = { value: inCost + outCost, provenance: 'imputed', error };
  }
  return { inputTokens, outputTokens, costUsd };
}

/** A figure as one line of text: `1,200 (reported)`, `300 (imputed, about 25% off)`. */
export function describeFigure(f: Figure | null, unit: 'tokens' | 'usd'): string {
  if (!f) return 'unknown';
  const v = unit === 'usd' ? `$${f.value.toFixed(f.value < 0.01 ? 5 : 4)}` : Math.round(f.value).toLocaleString('en-US');
  return f.provenance === 'imputed' ? `${v} (imputed, about ${Math.round((f.error ?? 0) * 100)}% off)` : `${v} (${f.provenance})`;
}

export interface Totals { jobs: number; inputTokens: number; outputTokens: number; costUsd: number; costJobs: number; byProvenance: { reported: number; derived: number; imputed: number } }

/** Sums a route's jobs. Cost counts only the jobs that have one, and `costJobs` says how many. */
export function totalOf(accounted: readonly Accounted[]): Totals {
  const t: Totals = { jobs: accounted.length, inputTokens: 0, outputTokens: 0, costUsd: 0, costJobs: 0, byProvenance: { reported: 0, derived: 0, imputed: 0 } };
  for (const a of accounted) {
    t.inputTokens += a.inputTokens?.value ?? 0; t.outputTokens += a.outputTokens?.value ?? 0;
    if (a.costUsd) { t.costUsd += a.costUsd.value; t.costJobs++; t.byProvenance[a.costUsd.provenance]++; }
  }
  return t;
}
