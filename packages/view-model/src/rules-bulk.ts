// Setting one rule field on many models at once, with a preview of exactly what would change. Kept free of the DOM so it can be tested.
import { COST_TIERS, DATA_TIERS, OUTPUT_MODES, fieldPath } from '@augur/core';
import type { PolicyConfig } from '@augur/core';

export interface BulkField {
  field: 'dataTier' | 'askFirst' | 'output' | 'sandbox' | 'cost' | 'effort';
  label: string;
  kind: 'choice' | 'bool' | 'text';
  choices?: readonly string[];
}

export const BULK_FIELDS: readonly BulkField[] = [
  { field: 'dataTier', label: 'Most sensitive data', kind: 'choice', choices: DATA_TIERS },
  { field: 'askFirst', label: 'Ask first', kind: 'bool' },
  { field: 'output', label: 'Output', kind: 'choice', choices: OUTPUT_MODES },
  { field: 'sandbox', label: 'Needs a sandbox', kind: 'bool' },
  { field: 'cost', label: 'Cost', kind: 'choice', choices: COST_TIERS },
  { field: 'effort', label: 'Reasoning effort', kind: 'text' },
];

export interface BulkChange { provider: string; label: string; path: string; from: unknown; to: unknown }
export interface BulkPreview {
  field: BulkField['field'];
  /** The value to write; undefined clears the field so each model follows its provider again. */
  value: string | boolean | undefined;
  changes: BulkChange[];
  /** Models that already hold this value of their own. */
  unchanged: number;
}

/** What one text box or menu value means for a field: an empty one clears it, and anything a menu could not offer is refused. */
export function parseBulkValue(f: BulkField, raw: string): { ok: true; value: string | boolean | undefined } | { ok: false; error: string } {
  const t = raw.trim();
  if (t === '') return { ok: true, value: undefined };
  if (f.kind === 'bool') return t === 'yes' || t === 'no' ? { ok: true, value: t === 'yes' } : { ok: false, error: `${f.label} is yes or no.` };
  if (f.kind === 'choice') return (f.choices ?? []).includes(t) ? { ok: true, value: t } : { ok: false, error: `${f.label} is not one of its choices.` };
  return { ok: true, value: t };
}

/** Lists the models whose own value would change, so nothing is written until the person has seen the list. `picked` holds `<provider>|<model label>`. */
export function previewBulk(policy: PolicyConfig, picked: Iterable<string>, field: BulkField['field'], raw: string): BulkPreview | { error: string } {
  const def = BULK_FIELDS.find((f) => f.field === field);
  if (!def) return { error: 'Choose a field.' };
  const parsed = parseBulkValue(def, raw);
  if (!parsed.ok) return { error: parsed.error };
  const changes: BulkChange[] = [];
  let unchanged = 0;
  for (const key of picked) {
    const [provider = '', label = ''] = key.split('|');
    const entry = policy.providers[provider]?.models[label];
    if (!entry) continue;
    const from = entry.rule[field];
    if (JSON.stringify(from) === JSON.stringify(parsed.value)) { unchanged++; continue; }
    changes.push({ provider, label, path: fieldPath(provider, label, field), from, to: parsed.value });
  }
  return { field, value: parsed.value, changes, unchanged };
}
