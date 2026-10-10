// Standing instructions prefixed to a job prompt. The folder holds core.md, engines/<engine>.md,
// packs/<name>.md and an optional charter.json. A missing folder means no charter.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CharterRule {
  tools?: string[];
  cwdContains?: string;
  pack: string;
}

export interface CharterInput {
  dir: string | null;
  /** Engine file under engines/. Null or omitted means none. */
  engine?: string | null;
  tools: string;
  cwd: string;
  /** Each entry is one pack name or a comma-separated list. */
  packs?: readonly string[];
}

export interface BuiltCharter {
  text: string;
  parts: string[];
  notes: string[];
}

const LEAD = 'Standing instructions for this assignment. Where one conflicts with a default in your harness, such as a limit on reply length, it wins for the deliverable.';
const DEFAULT_RULES: readonly CharterRule[] = [{ tools: ['write', 'full'], pack: 'code' }];

const slash = (p: string): string => p.replace(/\\/g, '/');

/** A pack or engine name that cannot leave the charter folder. */
function plainName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('..');
}

function isDir(path: string): boolean {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}

function readBlock(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, 'utf8').trim();
  } catch { return null; }
}

/** `runner.charterDir` when it is set, otherwise `<home>/charter` when that folder exists. */
export function resolveCharterDir(configured: string, home: string): string | null {
  const set = configured.trim();
  if (set) return set;
  const dir = join(home, 'charter');
  return isDir(dir) ? dir : null;
}

/** A route option named `ambient` wins. Anything else uses the service setting, and the default is keep. */
export function resolveAmbient(routeValue: unknown, setting: 'keep' | 'trim' | undefined): 'keep' | 'trim' {
  if (routeValue === 'keep' || routeValue === 'trim') return routeValue;
  return setting === 'trim' ? 'trim' : 'keep';
}

function rulesOf(dir: string, notes: string[]): CharterRule[] {
  const path = join(dir, 'charter.json');
  if (!existsSync(path)) return [...DEFAULT_RULES];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { notes.push('charter.json could not be read, so the default pack rule was used.'); return [...DEFAULT_RULES]; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { notes.push('charter.json could not be read, so the default pack rule was used.'); return [...DEFAULT_RULES]; }
  const auto = (raw as { auto?: unknown }).auto;
  if (!Array.isArray(auto)) return [...DEFAULT_RULES];
  const rules: CharterRule[] = [];
  for (const item of auto) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as { tools?: unknown; cwdContains?: unknown; pack?: unknown };
    if (typeof rec.pack !== 'string' || !plainName(rec.pack.trim())) continue;
    const rule: CharterRule = { pack: rec.pack.trim() };
    if (Array.isArray(rec.tools)) rule.tools = rec.tools.filter((t): t is string => typeof t === 'string');
    if (typeof rec.cwdContains === 'string') rule.cwdContains = rec.cwdContains;
    rules.push(rule);
  }
  return rules;
}

function matches(rule: CharterRule, tools: string, cwd: string): boolean {
  if (rule.tools && !rule.tools.includes(tools)) return false;
  if (rule.cwdContains !== undefined && !slash(cwd).includes(slash(rule.cwdContains))) return false;
  return true;
}

/**
 * Builds the charter text for one job. Returns null when there is no folder and nothing to note.
 * An empty text means a note was recorded and no file was sent. Packs are the request's packs, then each
 * auto rule whose conditions all hold. A missing pack is skipped.
 */
export function buildCharter(input: CharterInput): BuiltCharter | null {
  if (!input.dir || !isDir(input.dir)) return null;
  const notes: string[] = [];
  const rules = rulesOf(input.dir, notes);
  const packs: string[] = [];
  const add = (raw: string): void => {
    for (const piece of raw.split(',')) {
      const name = piece.trim();
      if (name && !packs.includes(name)) packs.push(name);
    }
  };
  for (const p of input.packs ?? []) add(p);
  for (const rule of rules) if (matches(rule, input.tools, input.cwd)) add(rule.pack);

  const parts: string[] = [];
  const blocks: string[] = [];
  const take = (path: string, part: string): boolean => {
    const text = readBlock(path);
    if (text === null) return false;
    blocks.push(text);
    parts.push(part);
    return true;
  };
  take(join(input.dir, 'core.md'), 'core');
  if (input.engine && plainName(input.engine)) take(join(input.dir, 'engines', `${input.engine}.md`), input.engine);
  for (const name of packs) {
    if (!plainName(name)) { notes.push(`Charter pack '${name}' is not a pack name and was skipped.`); continue; }
    if (!take(join(input.dir, 'packs', `${name}.md`), name)) notes.push(`Charter pack '${name}' was not found and was skipped.`);
  }
  if (!blocks.length) return notes.length ? { text: '', parts: [], notes } : null;
  return { text: `${LEAD}\n\n${blocks.join('\n\n')}\n\n--- Assignment ---\n`, parts, notes };
}
