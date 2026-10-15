// The owner's rubrics: one JSON file per rubric in `<home>/rubrics`, read each time so an edit needs no restart.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRubric } from '@augur/decision';
import type { Rubric } from '@augur/decision';

export const RUBRIC_ID = /^[a-z][a-z0-9_-]{0,47}$/;

export class RubricStore {
  constructor(private dir: string) {}

  /** One rubric by id, or why it cannot be used. The id is checked before it touches a path. */
  get(id: string): { rubric: Rubric } | { error: string } {
    if (!RUBRIC_ID.test(id)) return { error: 'A rubric id is lowercase letters, digits, - and _, starting with a letter.' };
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return { error: `No rubric named ${id} in ${this.dir}.` };
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return { error: `${id}.json is not valid JSON.` }; }
    const r = parseRubric(raw);
    if ('errors' in r) return { error: `${id}.json: ${r.errors.join(' ')}` };
    if (r.rubric.id !== id) return { error: `${id}.json names the rubric ${r.rubric.id}. The file name and the id must match.` };
    return { rubric: r.rubric };
  }

  /** Every usable rubric, and a line for each file that is not. */
  list(): { rubrics: Rubric[]; problems: string[] } {
    const rubrics: Rubric[] = [], problems: string[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter(n => n.endsWith('.json')).sort(); } catch { return { rubrics, problems }; }
    for (const n of names) {
      const r = this.get(n.slice(0, -5));
      if ('rubric' in r) rubrics.push(r.rubric); else problems.push(r.error);
    }
    return { rubrics, problems };
  }
}
