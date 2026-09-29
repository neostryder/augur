// Readers for the files Augur writes (policy.json, usage.json) and the user's route registry, cached by modification time.
import { readFileSync, statSync } from 'node:fs';
import type { PolicyFile } from '@augur/core';
import type { RouteConfig, UsageSnapshot } from '@augur/dispatch-protocol';

class JsonSource<T> {
  private mtime = -1; private value: T | null = null;
  constructor(private path: string, private check: (v: unknown) => T | null) {}
  read(): T | null {
    let m: number;
    try { m = statSync(this.path).mtimeMs; } catch { this.mtime = -1; return this.value = null; }
    if (m === this.mtime) return this.value;
    try { this.value = this.check(JSON.parse(readFileSync(this.path, 'utf8'))); this.mtime = m; } catch { this.value = null; this.mtime = -1; }
    return this.value;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const policySource = (path: string) => new JsonSource<PolicyFile>(path, v => isObj(v) && v.schema === 1 && isObj(v.providers) ? v as unknown as PolicyFile : null);
export const usageSource = (path: string) => new JsonSource<UsageSnapshot>(path, v => isObj(v) && isObj(v.providers) ? v as unknown as UsageSnapshot : null);

/** routes.json: `{ "routes": { "<name>": { "model": "codex/sol", "adapter": "codex-exec", "options": { ... } } } }` */
export function parseRoutes(v: unknown): Record<string, RouteConfig> | null {
  if (!isObj(v) || !isObj(v.routes)) return null;
  const out: Record<string, RouteConfig> = {};
  for (const [name, raw] of Object.entries(v.routes)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || !isObj(raw) || typeof raw.model !== 'string' || typeof raw.adapter !== 'string') continue;
    const options: Record<string, string | number | boolean> = {};
    if (isObj(raw.options)) for (const [k, val] of Object.entries(raw.options)) if (['string', 'number', 'boolean'].includes(typeof val)) options[k] = val as string | number | boolean;
    out[name] = { model: raw.model, adapter: raw.adapter, options, ...(raw.delegation === true ? { delegation: true } : {}), ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}) };
  }
  return out;
}
export const routeSource = (path: string) => new JsonSource<Record<string, RouteConfig>>(path, parseRoutes);
