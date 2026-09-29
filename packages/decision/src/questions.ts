// The typed questions Augur puts to a System One model, and how their answers are read. These are classifier input, worded to match
// what the routing script asks, so a model answers the same question whichever backend is behind it.
import { ACTIVITIES, DATA_TIERS } from '@augur/core';
import type { ActivityId, DataTier } from '@augur/core';

export type Question =
  | { type: 'choice'; criteria: Record<string, string>; instructions: string }
  | { type: 'score'; criteria: string[]; instructions: string }
  | { type: 'noul'; instructions: string };

export interface Answer { choice?: string; score?: number; noul?: number; confidence?: number; probabilities?: Record<string, number> }
export interface SystemOneResponse { answers?: Record<string, Answer>; error?: unknown; routing?: Record<string, unknown> }

export const ACTIVITY_TEXT: Record<ActivityId, string> = {
  write_code: 'Writing, changing or refactoring code, tests or scripts.',
  review_code: 'Reading code to review, audit, critique or explain it, without writing the change.',
  research: 'Finding and comparing information from the web or other sources.',
  reason_critique: 'Text-only reasoning: planning, architecture or design critique, second opinions, adversarial review of a brief or draft.',
  draft_prose: 'Writing prose for people: docs, posts, messages, changelog entries.',
  summarize_extract: 'Summarizing documents or pulling structured facts out of them.',
  long_context: 'Reading a whole codebase or a very long document at once.',
  bulk_tagging: 'Tagging, labeling or classifying many items in bulk.',
  typed_decisions: 'A yes/no gate, a pick among fixed options, or a ranking.',
  read_images: 'Reading or describing images, screenshots or video frames.',
  generate_images: 'Creating or editing images.',
  generate_video: 'Creating video.',
  speech: 'Transcribing or generating speech audio.',
};

export const DATA_TEXT: Record<DataTier, string> = {
  public: 'Only public information: open-source code, public docs, public posts.',
  internal: 'Private but not sensitive: unreleased plans for hobby projects, private repos, drafts, logs with no personal data.',
  sensitive: 'Personal data, customer data, credentials, work data for an employer, or private business plans.',
  regulated: 'Student records: grades, submissions, names or messages of students.',
};

export const FIT_LEVELS = [
  'Poor fit: this engine cannot do this task well, or cannot do it at all.',
  'Workable: it can do the task, with visible gaps in quality or capability.',
  'Good fit: it handles this kind of task well.',
  'Excellent fit: this is the kind of task it is best at.',
];

/** A data class this likely or more counts, and the strictest one wins. */
export const DATA_CAUTION = 0.25;
/** A task that could involve student records is judged on this machine only, and never below `sensitive`. */
export const STUDENT_RE = /\b(gcu|student|students|grad(e|es|ing)|halo|course|section|rubric|roster|ferpa|mis-?600|bit-?200)\b/i;

export const activityQuestion = (): Record<string, Question> => ({
  activity: { type: 'choice', criteria: { ...ACTIVITY_TEXT, none_of_these: 'None of these activities.' },
    instructions: 'Which kind of work is the task, taken as a whole? Pick the activity the engine will spend most of its effort on.' },
});

export const dataQuestion = (): Record<string, Question> => ({
  data: { type: 'choice', criteria: { ...DATA_TEXT },
    instructions: 'What is the most sensitive class of data the engine doing this task will see? Judge from the description; the data itself is not included.' },
});

const key = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_');

/** Each engine is asked twice, once with the levels ascending and once descending, so a position bias cancels out. */
export function fitQuestions(models: Array<{ model: string; description: string }>): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const m of models) {
    const instructions = `How well does this engine fit the task? Engine: ${m.model}. ${m.description}`;
    out[`f_${key(m.model)}`] = { type: 'score', criteria: FIT_LEVELS, instructions };
    out[`r_${key(m.model)}`] = { type: 'score', criteria: [...FIT_LEVELS].reverse(), instructions };
  }
  return out;
}

/** Fit on a 0 to 1 scale, averaging the two orders. A model with no usable answer counts as 0.5. */
export function readFits(models: string[], answers: Record<string, Answer>): Record<string, number> {
  const top = FIT_LEVELS.length - 1, out: Record<string, number> = {};
  for (const m of models) {
    const a = answers[`f_${key(m)}`], b = answers[`r_${key(m)}`], vals: number[] = [];
    if (typeof a?.score === 'number') vals.push(a.score / top);
    if (typeof b?.score === 'number') vals.push((top - b.score) / top);
    out[m] = vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 1000) / 1000 : 0.5;
  }
  return out;
}

export const isActivity = (v: unknown): v is ActivityId => typeof v === 'string' && (ACTIVITIES as readonly string[]).includes(v);
export const isTier = (v: unknown): v is DataTier => typeof v === 'string' && (DATA_TIERS as readonly string[]).includes(v);
