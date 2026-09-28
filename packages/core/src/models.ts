// Live model lists: which models a provider offers, reduced to the newest version of each, and merged into the rules.

import type { ModelEntry, PolicyConfig } from './policy.js';
import { fieldPath, setField } from './policy.js';

export interface ListedModel { id: string; name?: string }
export type ListMode = 'auto' | 'catalog';

/** Each provider's last model list, kept apart from the config since a marketplace list runs to over a thousand entries. */
export type ModelCatalog = Record<string, { fetchedAt: string; models: ListedModel[]; error?: string | null }>;

/** How often a provider's model list is read again. */
export const MODEL_LIST_SECONDS = 86400;

const VERSION = /^v?\d+(\.\d+)*$/;
const DATE = /^\d{8}$/;

/**
 * Splits a model id into its family and version, so gpt-6-sol and gpt-5.6-sol are one family at versions 6 and 5.6.
 * Numeric parts are the version, eight-digit dates are ignored, and every other part names the family.
 */
export function modelFamily(id: string): { family: string; version: number[] } {
  const family: string[] = [], version: number[] = [];
  for (const part of id.toLowerCase().split(/[-_/:\s]+/).filter(Boolean)) {
    if (DATE.test(part)) continue;
    if (VERSION.test(part)) version.push(...part.replace(/^v/, '').split('.').map(Number));
    else family.push(part);
  }
  return { family: family.join('-'), version };
}

export function compareModelVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Keeps the newest version in each family. Of two ids at the same version, the shorter one wins, so an alias beats its dated snapshot. */
export function latestOnly(models: ListedModel[]): ListedModel[] {
  const best = new Map<string, { m: ListedModel; v: number[] }>();
  for (const m of models) {
    const { family, version } = modelFamily(m.id), cur = best.get(family);
    const c = cur ? compareModelVersions(version, cur.v) : 1;
    if (!cur || c > 0 || (c === 0 && m.id.length < cur.m.id.length)) best.set(family, { m, v: version });
  }
  return models.filter(m => best.get(modelFamily(m.id).family)?.m === m);
}

/**
 * Adds a provider's newest models to its rules. A model with no older version in the rules starts unreviewed with no rules.
 * A newer version of a model already there starts from a copy of that model's rules, marked imported, and records which model it replaces.
 * Returns the labels added.
 */
export function syncModelList(policy: PolicyConfig, provider: string, prefix: string, listed: ListedModel[], now = new Date()): string[] {
  const p = policy.providers[provider] ??= { defaults: {}, models: {} }, added: string[] = [];
  for (const m of latestOnly(listed)) {
    const entries = Object.entries(p.models);
    if (entries.some(([, e]) => e.id === m.id)) continue;
    const label = `${prefix}/${m.id}`;
    if (p.models[label]) continue;
    const { family, version } = modelFamily(m.id);
    const older = entries.filter(([, e]) => e.status !== 'hidden')
      .map(([l, e]) => ({ l, e, f: modelFamily(e.id) }))
      .filter(x => x.f.family === family && compareModelVersions(x.f.version, version) < 0)
      .sort((a, b) => compareModelVersions(b.f.version, a.f.version))[0];
    const at = now.toISOString();
    p.models[label] = older
      ? { id: m.id, name: m.name, source: 'live', status: 'imported', rule: structuredClone(older.e.rule), firstSeen: at, supersedes: older.l }
      : { id: m.id, name: m.name, source: 'live', status: 'unreviewed', rule: {}, firstSeen: at };
    added.push(label);
  }
  return added;
}

/** Sets a model's status. Confirming a model that replaces an older version hides the older one. */
export function setModelStatus(policy: PolicyConfig, provider: string, label: string, status: ModelEntry['status'], device: string, now = new Date()): void {
  setField(policy, fieldPath(provider, label, 'status'), status, device, now);
  const previous = policy.providers[provider]?.models[label]?.supersedes;
  if (status === 'confirmed' && previous && policy.providers[provider]?.models[previous]) setField(policy, fieldPath(provider, previous, 'status'), 'hidden', device, now);
}

export function listDue(entry: ModelCatalog[string] | undefined, now = new Date()): boolean {
  return !entry || now.getTime() - Date.parse(entry.fetchedAt) >= MODEL_LIST_SECONDS * 1000;
}
