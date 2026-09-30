// Readers for the files Augur writes (policy.json, usage.json) and the user's route registry, cached by modification time and size.
import { readFileSync, statSync } from 'node:fs';
import type { PolicyFile } from '@augur/core';
import { BUDGET_PERIODS } from '@augur/dispatch-protocol';
import type { RouteBudget, RouteConfig, UsageSnapshot } from '@augur/dispatch-protocol';

class JsonSource<T> {
  /** Modification time and size together: two writes inside one timestamp tick still differ in length. */
  private stamp = ''; private value: T | null = null;
  constructor(private path: string, private check: (v: unknown) => T | null) {}
  read(): T | null {
    let stamp: string;
    try { const st = statSync(this.path); stamp = `${st.mtimeMs}:${st.size}`; } catch { this.stamp = ''; return this.value = null; }
    if (stamp === this.stamp) return this.value;
    try { this.value = this.check(JSON.parse(readFileSync(this.path, 'utf8'))); this.stamp = stamp; } catch { this.value = null; this.stamp = ''; }
    return this.value;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const TIERS = ['public', 'internal', 'sensitive', 'regulated'], OUTPUTS = ['write_files', 'patch_only', 'text_only'], STATUSES = ['confirmed', 'imported', 'unreviewed', 'hidden'];
/** A policy.json is a security input that people also edit by hand, so a malformed model rejects the whole file rather than being read with missing fields. */
export function validPolicyFile(v: unknown): boolean {
  if (!isObj(v) || v.schema !== 1 || !isObj(v.providers)) return false;
  for (const p of Object.values(v.providers)) {
    if (!isObj(p) || !isObj(p.models) || !isObj(p.thresholds)) return false;
    for (const m of Object.values(p.models)) {
      if (!isObj(m) || typeof m.id !== 'string' || !STATUSES.includes(m.status as string) || !isObj(m.activities)) return false;
      if (!TIERS.includes(m.dataTier as string) || typeof m.askFirst !== 'boolean' || !OUTPUTS.includes(m.output as string) || typeof m.sandbox !== 'boolean') return false;
      if (m.pause !== null && m.pause !== undefined && (!isObj(m.pause) || typeof m.pause.until !== 'string')) return false;
    }
  }
  return true;
}

export const policySource = (path: string) => new JsonSource<PolicyFile>(path, v => validPolicyFile(v) ? v as unknown as PolicyFile : null);
export const usageSource = (path: string) => new JsonSource<UsageSnapshot>(path, v => isObj(v) && isObj(v.providers) ? v as unknown as UsageSnapshot : null);

/** A budget with a known period and at least one positive limit; anything else is ignored rather than guessed at. */
export function parseBudget(v: unknown): RouteBudget | null {
  if (!isObj(v) || !(BUDGET_PERIODS as readonly unknown[]).includes(v.per)) return null;
  const pos = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
  const usd = pos(v.usd), jobs = pos(v.jobs);
  if (usd === undefined && jobs === undefined) return null;
  return { per: v.per as RouteBudget['per'], ...(usd !== undefined ? { usd } : {}), ...(jobs !== undefined ? { jobs: Math.floor(jobs) } : {}) };
}

/** routes.json: `{ "routes": { "<name>": { "model": "codex/sol", "adapter": "codex-exec", "options": { ... } } } }` */
export function parseRoutes(v: unknown): Record<string, RouteConfig> | null {
  if (!isObj(v) || !isObj(v.routes)) return null;
  const out: Record<string, RouteConfig> = {};
  for (const [name, raw] of Object.entries(v.routes)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || !isObj(raw) || typeof raw.model !== 'string' || typeof raw.adapter !== 'string') continue;
    const options: Record<string, string | number | boolean> = {};
    if (isObj(raw.options)) for (const [k, val] of Object.entries(raw.options)) if (['string', 'number', 'boolean'].includes(typeof val)) options[k] = val as string | number | boolean;
    const budget = parseBudget(raw.budget), fallback = Array.isArray(raw.fallback) ? raw.fallback.filter((n): n is string => typeof n === 'string' && n !== name) : [];
    out[name] = { model: raw.model, adapter: raw.adapter, options, ...(raw.delegation === true ? { delegation: true } : {}), ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
      ...(budget ? { budget } : {}), ...(fallback.length ? { fallback } : {}) };
  }
  return out;
}
export const routeSource = (path: string) => new JsonSource<Record<string, RouteConfig>>(path, parseRoutes);
