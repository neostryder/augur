// The edit inbox: a file of rule edits that anything on this computer may append to and only the running app applies. The MCP server and `augur profile import` both write it here.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INBOX_FILE } from '@augur/core';
import { augurHome } from './paths.js';

/** Adds lines to the inbox. The app remembers 500 handled edits, so the inbox keeps fewer and an old edit is never applied twice. */
export function appendPolicyEdits(lines: string, home: string = augurHome()): void {
  mkdirSync(home, { recursive: true });
  const path = join(home, INBOX_FILE);
  let old: string[] = [];
  try { old = readFileSync(path, 'utf8').split('\n').filter(Boolean); } catch { /* no inbox yet */ }
  if (old.length < 300) { appendFileSync(path, lines, 'utf8'); return; }
  writeFileSync(`${path}.tmp`, `${[...old.slice(-250), ...lines.split('\n').filter(Boolean)].join('\n')}\n`, 'utf8');
  renameSync(`${path}.tmp`, path);
}
