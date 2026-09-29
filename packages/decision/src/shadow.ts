// Asks a second backend the same questions, compares the answers, and returns the first backend's answers untouched.
import { createHash } from 'node:crypto';
import type { DecisionBackend } from './backend.js';
import { STUDENT_RE } from './questions.js';
import type { Answer, Question, SystemOneResponse } from './questions.js';

export interface Comparison {
  at: string;
  model: string | null;
  primary: string;
  shadow: string;
  /** Hash of the state, so a row can be matched to its decision without keeping the text. */
  state: string;
  agree: Record<string, boolean>;
  primaryAnswers: Record<string, Answer>;
  shadowAnswers: Record<string, Answer>;
}

/** The answer's top pick as a comparable value: the choice, the nearest level, or whether the yes/no is at least even. */
export function topOf(a: Answer | undefined): string | number | boolean | null {
  if (!a) return null;
  if (a.choice !== undefined) return a.choice;
  if (typeof a.score === 'number') return Math.round(a.score);
  if (typeof a.noul === 'number') return a.noul >= 0.5;
  return null;
}

export function compare(primary: SystemOneResponse, shadow: SystemOneResponse): Record<string, boolean> {
  const agree: Record<string, boolean> = {};
  for (const [q, a] of Object.entries(primary.answers ?? {})) {
    const b = shadow.answers?.[q];
    if (b) agree[q] = topOf(a) === topOf(b);
  }
  return agree;
}

export class ShadowBackend implements DecisionBackend {
  readonly id: string;
  readonly local: boolean;
  private pending = new Set<Promise<void>>();
  constructor(private primary: DecisionBackend, private shadow: DecisionBackend, private record: (c: Comparison) => void) {
    this.id = primary.id;
    this.local = primary.local;
  }

  async ask(state: unknown, questions: Record<string, Question>, model?: string): Promise<SystemOneResponse> {
    const result = await this.primary.ask(state, questions, model);
    // Text that could be about students never goes to a backend the person does not run.
    if (this.shadow.local || !STUDENT_RE.test(JSON.stringify(state))) {
      const job = this.shadow.ask(state, questions, model).then(other => {
        if (result.error || other.error) return;
        this.record({ at: new Date().toISOString(), model: model ?? null, primary: this.primary.id, shadow: this.shadow.id,
          state: createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16), agree: compare(result, other),
          primaryAnswers: result.answers ?? {}, shadowAnswers: other.answers ?? {} });
      }).catch(() => undefined).finally(() => this.pending.delete(job));
      this.pending.add(job);
    }
    return result;
  }

  /** Resolves when every comparison started so far has been recorded. */
  async idle(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }
}
