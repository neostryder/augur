// A rubric grader: a Score per dimension on a task and a candidate answer, read back as numbers and held to a stakes ladder.
// The grade is recorded and compared with a person's labels first (shadow). What it may then be used for depends on what a wrong grade costs.
import { createHash } from 'node:crypto';
import { DATA_TIERS } from '@augur/core';
import type { DataTier } from '@augur/core';
import type { DecisionBackend } from './backend.js';
import { STUDENT_RE } from './questions.js';
import type { Question } from './questions.js';

export type Stakes = 'low' | 'medium' | 'high';
export const STAKES: readonly Stakes[] = ['low', 'medium', 'high'];

export interface RubricDimension {
  id: string;
  /** What this dimension measures, worded as a question about the candidate. */
  instructions: string;
  /** Ordered from the worst level to the best, two to ten of them, each a sentence that says what that level looks like. */
  levels: string[];
  /** Counts in the overall score; 1 when omitted. */
  weight?: number;
}

export interface Rubric {
  id: string;
  /** Raise it when the wording changes. Labels belong to a version, so a new version starts over in shadow. */
  version: number;
  /** What a wrong grade costs: low (a retry or a re-read), medium (a wasted review or a wrong pick), high (a wrong grade does real harm). */
  stakes: Stakes;
  /** Says what the task and the candidate are, once, for every dimension. */
  intro?: string;
  /** The overall score a candidate needs to pass, 0 to 1. Without it the grader scores and never judges. */
  passAt?: number;
  /** The most the two question orders may disagree on a dimension before the grade goes to a person. Defaults to 0.34. */
  maxSpread?: number;
  dimensions: RubricDimension[];
}

export interface GradeInput { task: string; candidate: string; reference?: string }
export interface DimensionGrade {
  /** 0 (worst level) to 1 (best level), the mean of the two question orders. */
  score: number;
  /** How far apart the two orders were, 0 to 1. A large spread means the model is not sure of this dimension. */
  spread: number;
}
export interface Grade {
  rubric: string;
  version: number;
  dims: Record<string, DimensionGrade>;
  overall: number;
  /** The largest spread of any dimension. */
  uncertainty: number;
  backend: string;
}

/** Bounds on what is sent in one question, so a request is refused where a hosted model would reject it. */
export const MAX_CANDIDATE_CHARS = 20000;
export const MAX_TASK_CHARS = 6000;
const DEFAULT_MAX_SPREAD = 0.34;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A rubric read from JSON, or every reason it is not usable. */
export function parseRubric(raw: unknown): { rubric: Rubric } | { errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { errors: ['A rubric is a JSON object.'] };
  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(id)) errors.push('id: lowercase letters, digits, - and _, starting with a letter, up to 48 characters.');
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) errors.push('version: a whole number from 1.');
  if (!(STAKES as readonly unknown[]).includes(raw.stakes)) errors.push(`stakes: one of ${STAKES.join(', ')}.`);
  if (raw.intro !== undefined && typeof raw.intro !== 'string') errors.push('intro: text.');
  if (raw.passAt !== undefined && !(typeof raw.passAt === 'number' && raw.passAt >= 0 && raw.passAt <= 1)) errors.push('passAt: a number from 0 to 1.');
  if (raw.maxSpread !== undefined && !(typeof raw.maxSpread === 'number' && raw.maxSpread > 0 && raw.maxSpread <= 1)) errors.push('maxSpread: a number above 0 and up to 1.');
  const dims: RubricDimension[] = [];
  if (!Array.isArray(raw.dimensions) || !raw.dimensions.length || raw.dimensions.length > 12) errors.push('dimensions: a list of 1 to 12.');
  else {
    const seen = new Set<string>();
    for (const [i, d] of raw.dimensions.entries()) {
      const at = `dimensions[${i}]`;
      if (!isObject(d)) { errors.push(`${at}: an object.`); continue; }
      if (typeof d.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(d.id)) errors.push(`${at}.id: lowercase letters, digits and _, starting with a letter, up to 32 characters.`);
      else if (seen.has(d.id)) errors.push(`${at}.id: ${d.id} is used twice.`); else seen.add(d.id);
      if (typeof d.instructions !== 'string' || !d.instructions.trim()) errors.push(`${at}.instructions: text.`);
      if (!Array.isArray(d.levels) || d.levels.length < 2 || d.levels.length > 10 || !d.levels.every(l => typeof l === 'string' && l.trim())) errors.push(`${at}.levels: 2 to 10 sentences, worst first.`);
      if (d.weight !== undefined && !(typeof d.weight === 'number' && d.weight > 0 && d.weight <= 100)) errors.push(`${at}.weight: a number above 0 and up to 100.`);
      if (typeof d.id === 'string' && typeof d.instructions === 'string' && Array.isArray(d.levels)) dims.push({ id: d.id, instructions: d.instructions, levels: d.levels as string[], ...(typeof d.weight === 'number' ? { weight: d.weight } : {}) });
    }
  }
  if (errors.length) return { errors };
  return { rubric: { id: id as string, version: raw.version as number, stakes: raw.stakes as Stakes, ...(typeof raw.intro === 'string' ? { intro: raw.intro } : {}),
    ...(typeof raw.passAt === 'number' ? { passAt: raw.passAt } : {}), ...(typeof raw.maxSpread === 'number' ? { maxSpread: raw.maxSpread } : {}), dimensions: dims } };
}

/** Each dimension is asked twice, once with the levels ascending and once descending, so a bias toward the first option cancels out. */
export function gradeQuestions(rubric: Rubric): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const d of rubric.dimensions) {
    const instructions = `${rubric.intro ? rubric.intro + ' ' : ''}Judge only the candidate answer against the task. ${d.instructions}`;
    out[`g_${d.id}`] = { type: 'score', criteria: d.levels, instructions };
    out[`r_${d.id}`] = { type: 'score', criteria: [...d.levels].reverse(), instructions };
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The grade from the answers, or null when a dimension has no usable answer in either order. A partly answered rubric is not graded: a missing dimension is not a middling one. */
export function readGrade(rubric: Rubric, answers: Record<string, { score?: number }>, backend: string): Grade | null {
  const dims: Record<string, DimensionGrade> = {};
  let weighted = 0, total = 0, spread = 0;
  for (const d of rubric.dimensions) {
    const top = d.levels.length - 1, a = answers[`g_${d.id}`]?.score, b = answers[`r_${d.id}`]?.score;
    const vals: number[] = [];
    if (typeof a === 'number' && Number.isFinite(a)) vals.push(a / top);
    if (typeof b === 'number' && Number.isFinite(b)) vals.push((top - b) / top);
    if (!vals.length) return null;
    const score = vals.reduce((s, v) => s + v, 0) / vals.length, sp = vals.length === 2 ? Math.abs(vals[0]! - vals[1]!) : 1;
    dims[d.id] = { score: round(score), spread: round(sp) };
    weighted += score * (d.weight ?? 1); total += d.weight ?? 1; spread = Math.max(spread, sp);
  }
  return { rubric: rubric.id, version: rubric.version, dims, overall: round(weighted / total), uncertainty: round(spread), backend };
}

/** The tier of a grading request: what the caller declared, raised to regulated when the text mentions students and nothing was declared. */
export function gradeTier(declared: DataTier | undefined, text: string): DataTier {
  if (declared) return declared;
  return STUDENT_RE.test(text) ? 'regulated' : 'internal';
}

/** Grading text in the sensitive and regulated tiers goes only to a backend on this network. */
export const hostedTier = (tier: DataTier): boolean => DATA_TIERS.indexOf(tier) < DATA_TIERS.indexOf('sensitive');

export async function grade(backends: { primary: DecisionBackend; local?: DecisionBackend }, rubric: Rubric, input: GradeInput, tier: DataTier, model?: string): Promise<{ grade: Grade } | { error: string }> {
  if (input.candidate.length > MAX_CANDIDATE_CHARS) return { error: `The candidate is over ${MAX_CANDIDATE_CHARS} characters. It is not cut, so grade it in parts.` };
  if (input.task.length > MAX_TASK_CHARS) return { error: `The task is over ${MAX_TASK_CHARS} characters. State it more briefly.` };
  const { primary } = backends, local = backends.local ?? (primary.local ? primary : undefined);
  const asker = hostedTier(tier) ? primary : local;
  if (!asker) return { error: `No backend on this network can grade text in the ${tier} tier.` };
  const state = { task: input.task, candidate: input.candidate, ...(input.reference ? { reference: input.reference } : {}) };
  const res = await asker.ask(state, gradeQuestions(rubric), model);
  if (res.error || !res.answers) return { error: String(typeof res.error === 'string' ? res.error : JSON.stringify(res.error ?? 'no answers')).slice(0, 300) };
  const g = readGrade(rubric, res.answers, asker.id);
  return g ? { grade: g } : { error: 'The backend did not answer every dimension.' };
}

// ---------------------------------------------------------------- what a grade may be used for

/** shadow: recorded and compared, nothing acts on it. advise: shown beside the work, a person decides. gate: low-stakes callers may act on the verdict, with spot checks. */
export type GradeMode = 'shadow' | 'advise' | 'gate';

interface Step { labels: number; agree: number }
/** How many labelled grades, and what share a person agreed with, a rubric needs before each step. A high-stakes rubric never reaches gate. */
export const LADDER: Record<Stakes, { advise: Step; gate: Step | null; audit: number }> = {
  low: { advise: { labels: 10, agree: 0.7 }, gate: { labels: 30, agree: 0.85 }, audit: 0.1 },
  medium: { advise: { labels: 30, agree: 0.8 }, gate: { labels: 100, agree: 0.92 }, audit: 0.25 },
  high: { advise: { labels: 100, agree: 0.9 }, gate: null, audit: 1 },
};

export type GradeVerdictLabel = 'agree' | 'high' | 'low';
export const GRADE_LABELS: readonly GradeVerdictLabel[] = ['agree', 'high', 'low'];

export interface GradeRow { kind: 'grade'; id: string; at?: number; rubric: string; version: number; tier: string; backend: string; overall: number; uncertainty: number; mode?: string; verdict?: string | null }
export interface GradeLabelRow { kind: 'gradelabel'; at?: number; grade: string; label: GradeVerdictLabel; note?: string }

export interface GradeStats { rubric: string; version: number; grades: number; labeled: number; agree: number; high: number; low: number; agreeShare: number | null; mode: GradeMode; next: string | null }

/** The latest label for each grade of this rubric version, counted over the most recent 200 labelled grades. */
export function gradeStats(rows: Array<{ kind: string }>, rubric: Rubric): GradeStats {
  const mine = new Map<string, GradeRow>(), labels = new Map<string, GradeLabelRow>();
  for (const r of rows) {
    if (r.kind === 'grade') { const g = r as GradeRow; if (g.rubric === rubric.id && g.version === rubric.version) mine.set(g.id, g); }
    else if (r.kind === 'gradelabel') labels.set((r as GradeLabelRow).grade, r as GradeLabelRow);
  }
  const labeled = [...mine.keys()].filter(id => labels.has(id)).map(id => labels.get(id) as GradeLabelRow).slice(-200);
  const agree = labeled.filter(l => l.label === 'agree').length, high = labeled.filter(l => l.label === 'high').length, low = labeled.filter(l => l.label === 'low').length;
  const share = labeled.length ? agree / labeled.length : null, rung = LADDER[rubric.stakes];
  const reached = (s: Step | null) => !!s && labeled.length >= s.labels && (share ?? 0) >= s.agree;
  const mode: GradeMode = reached(rung.gate) ? 'gate' : reached(rung.advise) ? 'advise' : 'shadow';
  const target = mode === 'shadow' ? rung.advise : mode === 'advise' ? rung.gate : null;
  const next = target ? `${target.labels} labelled grades with ${Math.round(target.agree * 100)}% agreement for ${mode === 'shadow' ? 'advise' : 'gate'} (now ${labeled.length}, ${share === null ? 'none yet' : Math.round(share * 100) + '%'})` : null;
  return { rubric: rubric.id, version: rubric.version, grades: mine.size, labeled: labeled.length, agree, high, low, agreeShare: share === null ? null : round(share), mode, next };
}

export interface Verdict { mode: GradeMode; /** pass or fail only in gate mode and only when the rubric has a passAt; review when the grade should go to a person; null otherwise. */ verdict: 'pass' | 'fail' | 'review' | null; audit: boolean }

/** What the caller may do with a grade. Outside gate mode nothing is decided. In gate mode a clear grade passes or fails, an unsure one goes to review, and a share of the rest is flagged for a spot check. */
export function decide(rubric: Rubric, g: Grade, mode: GradeMode, id: string): Verdict {
  const audit = mode === 'gate' && fraction(id) < LADDER[rubric.stakes].audit;
  if (mode !== 'gate' || rubric.passAt === undefined) return { mode, verdict: null, audit: false };
  if (g.uncertainty > (rubric.maxSpread ?? DEFAULT_MAX_SPREAD)) return { mode, verdict: 'review', audit: false };
  return { mode, verdict: g.overall >= rubric.passAt ? 'pass' : 'fail', audit };
}

/** A fixed number from 0 up to 1 for an id, so the spot-check draw is repeatable. */
function fraction(id: string): number { return parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) / 0x100000000; }
