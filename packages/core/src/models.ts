// Live model lists: which models a provider offers, reduced to the newest version of each, and merged into the rules.

import type { ModelEntry, PolicyConfig } from './policy.js';
import { fieldPath, newProvider, setField } from './policy.js';

/** `created` is when the provider released or first listed the model, where it says. */
export interface ListedModel { id: string; name?: string; created?: string }
export type ListMode = 'auto' | 'catalog';

/** Each provider's last model list, kept apart from the config since a marketplace list runs to over a thousand entries. */
export type ModelCatalog = Record<string, { fetchedAt: string; models: ListedModel[]; error?: string | null }>;

/** How often a provider's model list is read again. */
export const MODEL_LIST_SECONDS = 86400;

/** A number, optionally after a few letters: 6, v4.1, m2.7, qwen3. The letters, except a lone v, stay part of the family name. */
const VERSION = /^([a-z]{0,5}?)(\d+(?:\.\d+)*)$/;
// Date stamps in ids, which are not versions: 20251101, 2025-07-28, 0731 and 02-23 style month and day.
const DATES = [/(^|[-_:@])20\d{2}[-_]?[01]\d[-_]?[0-3]\d(?=$|[-_:@])/g, /(^|[-_:@])[01]\d[-_][0-3]\d(?=$|[-_:@])/g, /(^|[-_:@])[01]\d[0-3]\d(?=$|[-_:@])/g];

/**
 * Splits a model id into its family and version, so gpt-6-sol and gpt-5.6-sol are one family at versions 6 and 5.6,
 * and MiniMax-M3 and MiniMax-M2.7 are one family at versions 3 and 2.7. Eight-digit dates are ignored.
 */
export function modelFamily(id: string): { family: string; version: number[] } {
  const family: string[] = [], version: number[] = [];
  const undated = DATES.reduce((text, date) => text.replace(date, '$1'), id.toLowerCase());
  for (const part of undated.split(/[-_/:@\s]+/).filter(Boolean)) {
    const v = VERSION.exec(part);
    if (!v) { family.push(part); continue; }
    if (v[1] && v[1] !== 'v') family.push(v[1]);
    version.push(...v[2]!.split('.').map(Number));
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

const DAY = 86400e3;

/**
 * Orders two models of one family, newest first. Release dates decide when both have one and they are more than a day apart,
 * since version numbers are not always decimal (Grok 4.20 came out before Grok 4.7). Otherwise the version decides,
 * and of two ids at the same version the shorter wins, so an alias beats its dated snapshot.
 */
function newer(a: ListedModel, b: ListedModel): number {
  const ta = a.created ? Date.parse(a.created) : NaN, tb = b.created ? Date.parse(b.created) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) > DAY) return ta - tb;
  return compareModelVersions(modelFamily(a.id).version, modelFamily(b.id).version) || b.id.length - a.id.length;
}

/** Keeps the newest model in each family. */
export function latestOnly(models: ListedModel[]): ListedModel[] {
  const best = new Map<string, ListedModel>();
  for (const m of models) {
    const family = modelFamily(m.id).family, cur = best.get(family);
    if (!cur || newer(m, cur) > 0) best.set(family, m);
  }
  return models.filter(m => best.get(modelFamily(m.id).family) === m);
}

/**
 * Adds a provider's newest models to its rules. A model with no older version in the rules starts unreviewed with no rules.
 * A newer version of a model already there starts from a copy of that model's rules, marked imported, and records which model it replaces.
 * Returns the labels added.
 */
export function syncModelList(policy: PolicyConfig, provider: string, prefix: string, listed: ListedModel[], now = new Date()): string[] {
  const p = policy.providers[provider] ??= newProvider(), added: string[] = [];
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
