// Importing a rules file adds its models as `imported`. They route nowhere until confirmed on the rules page.

import type { PolicyConfig } from './policy.js';
import { migratePolicy } from './policy.js';

/**
 * Adds the providers and models from a rules file, in the same shape as the stored policy.
 * Provider defaults and thresholds fill only fields that are still empty, and models that already exist are left alone.
 * Returns the labels of the models added.
 */
export function importPolicy(policy: PolicyConfig, data: unknown, now = new Date()): string[] {
  const incoming = migratePolicy(data), added: string[] = [], at = now.toISOString();
  for (const [id, source] of Object.entries(incoming.providers)) {
    const target = policy.providers[id] ??= { defaults: {}, models: {} };
    target.defaults = { ...source.defaults, ...target.defaults };
    if (source.thresholds) target.thresholds = { ...source.thresholds, ...target.thresholds };
    for (const [label, model] of Object.entries(source.models)) {
      if (target.models[label]) continue;
      target.models[label] = { ...model, source: 'import', status: 'imported', firstSeen: at };
      added.push(label);
    }
  }
  return added;
}
