// Finds the hosted API key. The value stays in this process: it is never logged, never returned, and never written back.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { KeySource } from './config.js';

const DEFAULT_ENV = ['TYPESAFE_API_KEY', 'JEV_API_KEY'];

/** The key, or null when no source yields one. Each source is tried in the order env, file, command. */
export function readKey(source: KeySource, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of source.env ?? DEFAULT_ENV) { const v = env[name]?.trim(); if (v) return v; }
  if (source.file) { try { const v = readFileSync(source.file, 'utf8').trim(); if (v) return v; } catch { /* try the next source */ } }
  if (source.command?.length) {
    const [program, ...args] = source.command as [string, ...string[]];
    try { const v = execFileSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (v) return v; } catch { /* no key */ }
  }
  return null;
}

/** Keeps the key for a few minutes so a request does not run a command. `forget` drops it after the upstream refuses it. */
export class KeyCache {
  private value: { key: string | null; at: number } | null = null;
  constructor(private read: () => string | null, private ttlMs = 300_000, private now: () => number = Date.now) {}
  get(): string | null {
    if (this.value && this.value.key && this.now() - this.value.at < this.ttlMs) return this.value.key;
    // A missing key is looked for again on the next request, so adding one needs no restart.
    const key = this.read();
    this.value = { key, at: this.now() };
    return key;
  }
  forget(): void { this.value = null; }
}
