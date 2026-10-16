// Importing a rules file adds its models as `imported` unless the caller says otherwise. They route nowhere until confirmed on the rules page.

import type { PolicyConfig } from './policy.js';
import { STARTER_DEFAULTS, migratePolicy, newProvider } from './policy.js';
import type { ModelStatus } from './policy.js';

/**
 * Adds the providers and models from a rules file, in the same shape as the stored policy.
 * A provider the rules do not have yet starts from the starter defaults (named before use, public data only) and the file's values override them. Provider defaults and thresholds of an existing provider fill only fields that are still empty, and models that already exist are left alone.
 * `status` is what the added models start as. Setup confirms them at once when the person accepts the recommended rules.
 * Returns the labels of the models added.
 */
export function importPolicy(policy: PolicyConfig, data: unknown, now = new Date(), status: ModelStatus = 'imported'): string[] {
  const incoming = migratePolicy(data), added: string[] = [], at = now.toISOString();
  for (const [id, source] of Object.entries(incoming.providers)) {
    const fresh = !policy.providers[id], target = policy.providers[id] ??= newProvider();
    target.defaults = fresh ? { ...STARTER_DEFAULTS, ...source.defaults } : { ...source.defaults, ...target.defaults };
    if (source.thresholds) target.thresholds = { ...source.thresholds, ...target.thresholds };
    for (const [label, model] of Object.entries(source.models)) {
      if (target.models[label]) continue;
      target.models[label] = { ...model, source: 'import', status, firstSeen: at };
      added.push(label);
    }
  }
  return added;
}
