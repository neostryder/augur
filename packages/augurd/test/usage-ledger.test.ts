import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { JobRecord, RouteConfig } from '@augur/dispatch-protocol';
import { usageLedger } from '../src/usage-ledger.js';
import { Store } from '../src/store.js';

const job = (extra: Partial<JobRecord> = {}): JobRecord => ({ id: 'one', state: 'completed', route: 'api', adapter: 'openai-api', activity: 'research',
  dataTier: 'public', tools: 'none', output: 'text_only', cwd: '.', createdAt: 100, startedAt: 101, endedAt: 102, exitCode: 0, reason: null,
  rootJobId: 'one', parentJobId: null, replayOf: null, depth: 0, caller: { kind: 'cli' }, named: false, harnessVersion: null,
  usage: { inputTokens: 1000, outputTokens: 100, cachedReadTokens: 200, reasoningTokens: 10, source: 'reported' }, workspace: null, patch: null, ...extra });

describe('usage ledger projection', () => {
  it('reads the inclusive execution window from the store and excludes jobs that never started', () => {
    const dir = mkdtempSync(join(process.cwd(), '.augur-usage-')), store = new Store(dir);
    try {
      for (const [id, createdAt, startedAt] of [['one', 1, 200], ['old', 1, 199], ['queued', 300, null]] as const) {
        store.insert({ ...job({ id, createdAt }), expectFile: null, timeoutS: 30 });
        if (startedAt !== null) store.transition(id, 'running', { startedAt }, startedAt);
      }
      const jobs = store.list({ since: 200, limit: 2147483647 });
      expect(jobs.map(j => j.id).sort()).toEqual(['one', 'queued']);
      const result = usageLedger(jobs, { api: { model: 'openai-api/sol', adapter: 'openai-api' } }, null, {}, dir);
      expect(result).toHaveLength(1);
      expect(result[0]!.at).toBe(200);
    } finally { store.close(); if (dirname(dir) === process.cwd()) rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses configured chat prices and reports unknown prices without trusting a supplied dollar figure', () => {
    const routes: Record<string, RouteConfig> = { api: { model: 'openai-api/sol', adapter: 'openai-api', options: { model: 'gpt-6.1-sol' } } };
    const [row] = usageLedger([job()], routes, null, { 'openai-api/sol': { inputPerM: 2, outputPerM: 8, cachedReadPerM: 0.5 } }, '.');
    expect(row).toMatchObject({ model: 'gpt-6.1-sol', provider: 'openai-api', at: 101, images: 0, usage: { inputTokens: 1000, outputTokens: 110, cachedReadTokens: 200 } });
    expect(row!.costUsd).toBeCloseTo(0.00258);
    expect(usageLedger([job({ usage: { inputTokens: 3, outputTokens: 4, costUsd: 99, source: 'reported' } })], routes, null, {}, '.')[0]!.costUsd).toBeNull();
  });

  it('counts saved image outputs and keeps retained rows with removed output directories unknown', () => {
    const dir = mkdtempSync(join(process.cwd(), '.augur-usage-'));
    try {
      mkdirSync(join(dir, 'jobs', 'one'), { recursive: true });
      for (const file of ['image-1.png', 'image-2.webp', 'answer.txt']) writeFileSync(join(dir, 'jobs', 'one', file), 'fixture');
      const routes = { api: { model: 'openai-api/image', adapter: 'openai-api', options: { model: 'gpt-image-2' } } };
      expect(usageLedger([job({ activity: 'generate_images' })], routes, null, {}, dir)[0]!.images).toBe(2);
      // A generation job's input is all text, so its text token count is known; an edit job's split is not.
      expect(usageLedger([job({ activity: 'generate_images' })], routes, null, {}, dir)[0]!.usage).toMatchObject({ textInputTokens: 800 });
      expect(usageLedger([job({ activity: 'image_to_image' })], routes, null, {}, dir)[0]!.usage).not.toHaveProperty('textInputTokens');
      expect(usageLedger([job({ id: 'removed', activity: 'image_to_image' })], routes, null, {}, dir)[0]!.images).toBeNull();
    } finally { if (dirname(dir) === process.cwd()) rmSync(dir, { recursive: true, force: true }); }
  });

  it('counts launched ChatGPT jobs while excluding queued jobs and unrelated providers', () => {
    const routes = { api: { model: 'chatgpt/research', adapter: 'web-chat' } };
    expect(usageLedger([job(), job({ startedAt: null, usage: null, state: 'queued' })], routes, null, {}, '.')).toHaveLength(1);
    expect(usageLedger([job()], { api: { model: 'other/chat', adapter: 'openai-api' } }, null, {}, '.')).toEqual([]);
  });
});
