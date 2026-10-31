// The approval the Claude guard writes when Aaron names a premium model in his newest message. An automated caller
// cannot claim it itself: only the guard can write this file, and the service takes one use per dispatch.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WINDOW_MS = 30 * 60 * 1000;

export function takeNamedApproval(route: string, now = Date.now(), file = join(process.env.AUGUR_DIR || join(homedir(), '.augur'), 'named-approvals.json')): boolean {
  let state: Record<string, { at: number; uses: number }>;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  const entry = state[route];
  if (!entry || now - entry.at > WINDOW_MS || entry.uses <= 0) return false;
  state[route] = { at: entry.at, uses: entry.uses - 1 };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
  return true;
}
