// Tools and instructions that go with an activity. The file `toolkits.json` in the Augur home maps an activity to a charter pack, the MCP servers a job
// of that activity needs, and the tools to keep off. A missing or unreadable file means no toolkits.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITIES } from '@augur/core';
import type { ActivityId } from '@augur/core';
import type { McpServer, Toolkit } from '@augur/dispatch-protocol';

const plain = (s: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(s);
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : null);

function server(name: string, raw: unknown, notes: string[]): McpServer | null {
  const r = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (!plain(name)) { notes.push(`MCP server name '${name}' is not a plain name and was skipped.`); return null; }
  if (typeof r.command !== 'string' || !r.command.trim()) { notes.push(`MCP server '${name}' has no command and was skipped.`); return null; }
  const args = r.args === undefined ? [] : strings(r.args);
  if (!args) { notes.push(`MCP server '${name}' has arguments that are not a list of text and was skipped.`); return null; }
  const env: Record<string, string> = {};
  if (typeof r.env === 'object' && r.env !== null && !Array.isArray(r.env)) for (const [k, v] of Object.entries(r.env)) if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = v;
  const deny = r.denyTools === undefined ? [] : strings(r.denyTools);
  if (!deny || deny.some(t => !plain(t))) { notes.push(`MCP server '${name}' has a denyTools list that is not tool names and was skipped.`); return null; }
  return { command: r.command.trim(), args, ...(Object.keys(env).length ? { env } : {}), ...(deny.length ? { denyTools: deny } : {}) };
}

/** The toolkits in `<home>/toolkits.json`, by activity, with a note for each entry that could not be used. */
export function loadToolkits(home: string): { kits: Partial<Record<ActivityId, Toolkit>>; notes: string[] } {
  const path = join(home, 'toolkits.json'), notes: string[] = [], kits: Partial<Record<ActivityId, Toolkit>> = {};
  if (!existsSync(path)) return { kits, notes };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return { kits, notes: ['toolkits.json could not be read, so no toolkit was used.'] }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kits, notes: ['toolkits.json could not be read, so no toolkit was used.'] };
  for (const [activity, value] of Object.entries(raw)) {
    if (!(ACTIVITIES as readonly string[]).includes(activity)) { notes.push(`toolkits.json names '${activity}', which is not an activity.`); continue; }
    const v = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as { pack?: unknown; mcp?: unknown };
    const kit: Toolkit = { mcp: {} };
    if (typeof v.pack === 'string' && plain(v.pack.trim())) kit.pack = v.pack.trim();
    else if (v.pack !== undefined) notes.push(`The pack for ${activity} is not a pack name and was skipped.`);
    if (typeof v.mcp === 'object' && v.mcp !== null && !Array.isArray(v.mcp)) for (const [name, s] of Object.entries(v.mcp)) { const ok = server(name, s, notes); if (ok) kit.mcp[name] = ok; }
    if (kit.pack || Object.keys(kit.mcp).length) kits[activity as ActivityId] = kit;
  }
  return { kits, notes };
}
