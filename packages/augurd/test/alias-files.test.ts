import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { readAliasOffers, refreshAliasFiles, settleAliasOffer, withAliasFileLock } from '../src/alias-files.js';
import { singleFlight } from '../src/main.js';
import type { PolicyFile } from '@augur/core';

const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'augur-alias-')); dirs.push(dir); return dir; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function seed(dir: string, kind: 'llm' | 'image' | 'speech' | 'embed' = 'llm') {
  const policy: PolicyFile = { schema: 1, updatedAt: '2024-01-01T00:00:00Z', weights: { last_resort: 0.1, occasional: 0.5, normal: 1, often: 1.5, preferred: 2 }, dataTiers: ['public', 'internal', 'sensitive', 'regulated'], activities: ['write_code'], unreviewed: [], providers: { openrouter: { name: 'OpenRouter', metered: true, thresholds: { warnPct: 90, denyPct: 98, minBalance: 0 }, models: { label: { provider: 'openrouter', id: 'vendor/model-1', name: 'Model One', source: 'manual', status: 'confirmed', dataTier: 'sensitive', askFirst: false, output: 'write_files', sandbox: false, effort: null, cost: 'moderate', pause: null, activities: { write_code: 'preferred' }, dataHandling: { pinnedHost: 'us-east' }, useAfter: ['other'], notes: 'keep', inherited: [], series: { kind, pattern: 'vendor/model-*' } } } } } };
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
  mkdirSync(join(dir, 'dispatch'), { recursive: true });
  writeFileSync(join(dir, 'dispatch', 'routes.json'), JSON.stringify({ routes: { chat: { model: 'label', adapter: 'openai-api', options: { model: 'vendor/model-1', maxTokens: 7 }, budget: { usd: 3 } }, custom: { model: 'label', adapter: 'openai-api', options: { model: 'other/model' } } }, extra: true }));
}
const listings = { openrouter: async () => [{ id: 'vendor/model-2', name: 'Model Two', created: '2025-01-01T00:00:00Z', endpoints: ['us-east'] }] };
const smokeOk = async () => ({ status: 'succeeded' as const });

describe('alias persistence', () => {
  it('writes one offer without swapping and records embedding flags and alerts', async () => {
    const dir = fresh(); seed(dir);
    const once = await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), smokeOk);
    const twice = await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-02T00:00:00Z'), smokeOk);
    expect(once.offers).toHaveLength(1); expect(twice.offers).toHaveLength(1);
    expect(readAliasOffers(dir)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8')).providers.openrouter.models.label.id).toBe('vendor/model-1');
    seed(dir, 'embed');
    writeFileSync(join(dir, 'alerts.json'), JSON.stringify({ schema: 1, generatedAt: '2025-01-01T00:00:00Z', alerts: Array.from({ length: 55 }, (_, i) => ({ id: `old-${i}` })) }));
    const embedded = await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-03T00:00:00Z'), smokeOk);
    expect(embedded.offers).toEqual([]);
    expect(readFileSync(join(dir, 'alerts.json'), 'utf8')).toContain('re-making stored vectors');
    expect(JSON.parse(readFileSync(join(dir, 'alerts.json'), 'utf8')).alerts).toHaveLength(50);
  });

  it('accepts a swap while preserving rules and rejects failed offers', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), smokeOk);
    const offer = readAliasOffers(dir)[0]!;
    expect(settleAliasOffer(dir, offer.id, true, new Date('2025-02-02T00:00:00Z'), join(dir, 'dispatch-data')).ok).toBe(true);
    const model = JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8')).providers.openrouter.models.label;
    expect(model).toMatchObject({ id: 'vendor/model-1', name: 'Model One', dataTier: 'sensitive', status: 'confirmed', askFirst: false, output: 'write_files', sandbox: false, effort: null, cost: 'moderate', pause: null, series: { kind: 'llm', pattern: 'vendor/model-*' }, dataHandling: { pinnedHost: 'us-east' }, activities: { write_code: 'preferred' }, useAfter: ['other'], notes: 'keep' });
    expect(JSON.parse(readFileSync(join(dir, 'policy-edits.jsonl'), 'utf8'))).toMatchObject({ provider: 'openrouter', model: 'label', field: 'id', value: 'vendor/model-2' });
    const routes = JSON.parse(readFileSync(join(dir, 'dispatch', 'routes.json'), 'utf8'));
    expect(routes).toMatchObject({ extra: true, routes: { chat: { options: { model: 'vendor/model-2', maxTokens: 7 }, budget: { usd: 3 } }, custom: { options: { model: 'other/model' } } } });
    expect(readAliasOffers(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'dispatch-data', 'decisions.jsonl'), 'utf8')).toContain('"kind":"alias_swap"');
    const inbox = join(dir, 'alias-inbox.jsonl');
    writeFileSync(inbox, JSON.stringify({ ...offer, id: 'failed', status: 'failed' }) + '\n');
    expect(settleAliasOffer(dir, 'failed', true)).toMatchObject({ ok: false, error: 'A failed offer cannot be accepted.' });
    expect(settleAliasOffer(dir, 'failed', false, new Date(), join(dir, 'dispatch-data')).ok).toBe(true);
  });

  it('fails an offer when the fake smoke job fails and refuses acceptance', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), async () => ({ status: 'failed', reason: 'runner exited 1' }));
    const offer = readAliasOffers(dir)[0]!;
    expect(offer).toMatchObject({ status: 'failed', reason: 'smoke check failed: failed' });
    expect(settleAliasOffer(dir, offer.id, true)).toEqual({ ok: false, error: 'A failed offer cannot be accepted.' });
  });

  it('fails on an attachment mismatch before calling the smoke job', async () => {
    const dir = fresh(); seed(dir);
    let smoked = false;
    const listing = { openrouter: async () => [
      { id: 'vendor/model-1', created: '2024-01-01T00:00:00Z', inputModalities: ['text', 'image'], endpoints: ['us-east'] },
      { id: 'vendor/model-2', created: '2025-01-01T00:00:00Z', inputModalities: ['text'], endpoints: ['us-east'] },
    ] };
    await refreshAliasFiles(dir, listing, undefined, new Date('2025-02-01T00:00:00Z'), async () => { smoked = true; return { status: 'succeeded' }; });
    expect(readAliasOffers(dir)[0]).toMatchObject({ status: 'failed', reason: 'new model does not accept current input kinds' });
    expect(smoked).toBe(false);
  });

  it('skips capability comparison when the listing has no capability data and records its note', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), smokeOk);
    expect(readAliasOffers(dir)[0]).toMatchObject({ tested: true, notes: ['capabilities not compared'] });
  });

  it('keeps a policy-blocked smoke offer pending and requires --untested to accept it', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), async () => ({ status: 'untested', reason: 'model is paused' }));
    const offer = readAliasOffers(dir)[0]!;
    expect(offer).toMatchObject({ status: 'pending', tested: false, notes: ['capabilities not compared', 'not smoke-tested: model is paused'] });
    expect(settleAliasOffer(dir, offer.id, true)).toMatchObject({ ok: false, error: expect.stringContaining('Pass --untested') });
    expect(settleAliasOffer(dir, offer.id, true, new Date(), join(dir, 'dispatch-data'), true).ok).toBe(true);
  });

  it('checks pins before capability data and smoke work', async () => {
    const dir = fresh(); seed(dir);
    let smoked = false;
    const listing = { openrouter: async () => [{ id: 'vendor/model-1', created: '2024-01-01T00:00:00Z', inputModalities: ['text', 'image'] }, { id: 'vendor/model-2', created: '2025-01-01T00:00:00Z', endpoints: ['other'], inputModalities: ['text'] }] };
    await refreshAliasFiles(dir, listing, undefined, new Date('2025-02-01T00:00:00Z'), async () => { smoked = true; return { status: 'succeeded' }; });
    expect(readAliasOffers(dir)[0]).toMatchObject({ status: 'failed', reason: 'pinned provider does not serve model' });
    expect(smoked).toBe(false);
  });

  it('fails closed for a pin with no endpoint data', async () => {
    const dir = fresh(); seed(dir);
    const listing = { openrouter: async () => [{ id: 'vendor/model-2', created: '2025-01-01T00:00:00Z' }] };
    await refreshAliasFiles(dir, listing, undefined, new Date('2025-02-01T00:00:00Z'), smokeOk);
    expect(readAliasOffers(dir)[0]).toMatchObject({ status: 'failed', reason: 'pin not verifiable' });
  });

  it('uses the resolved policy dataHandling pin and fails before smoke when it does not match', async () => {
    const dir = fresh(); seed(dir);
    let smoked = false;
    await refreshAliasFiles(dir, { openrouter: async () => [{ id: 'vendor/model-2', created: '2025-01-01T00:00:00Z', endpoints: ['other'] }] }, undefined, new Date('2025-02-01T00:00:00Z'), async () => { smoked = true; return { status: 'succeeded' }; });
    expect(readAliasOffers(dir)[0]).toMatchObject({ status: 'failed', reason: 'pinned provider does not serve model' });
    expect(smoked).toBe(false);
  });

  it('supersedes a failed offer when a newer target appears', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), async () => ({ status: 'failed', reason: 'private provider response body' }));
    expect(readAliasOffers(dir)[0]?.reason).toBe('smoke check failed: failed');
    const next = { openrouter: async () => [{ id: 'vendor/model-3', created: '2026-01-01T00:00:00Z', endpoints: ['us-east'] }] };
    await refreshAliasFiles(dir, next, undefined, new Date('2026-02-01T00:00:00Z'), smokeOk);
    expect(readAliasOffers(dir).map(x => [x.to, x.status])).toEqual([['vendor/model-2', 'failed'], ['vendor/model-3', 'pending']]);
  });

  it('marks a pending offer for an older target as superseded', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), smokeOk);
    await refreshAliasFiles(dir, { openrouter: async () => [{ id: 'vendor/model-3', created: '2026-01-01T00:00:00Z', endpoints: ['us-east'] }] }, undefined, new Date('2026-02-01T00:00:00Z'), smokeOk);
    expect(readAliasOffers(dir).map(x => [x.to, x.status])).toEqual([['vendor/model-2', 'superseded'], ['vendor/model-3', 'pending']]);
  });

  it('filters refreshes by label and writes refresh state', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, 'other-label', new Date('2025-02-01T00:00:00Z'), smokeOk);
    expect(readAliasOffers(dir)).toEqual([]);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-02T00:00:00Z'), smokeOk);
    expect(JSON.parse(readFileSync(join(dir, 'alias-refresh.json'), 'utf8'))).toMatchObject({ label: { newestSeenId: 'vendor/model-2', lastRefreshAt: '2025-02-02T00:00:00.000Z' } });
  });

  it('serializes interleaving writers in separate processes under the alias file lock', async () => {
    const dir = fresh(), path = join(dir, 'alias-inbox.jsonl');
    writeFileSync(path, '');
    const script = "import { readFileSync, writeFileSync } from 'node:fs'; import { withAliasFileLock } from './src/alias-files.ts'; const [path, value] = process.argv.slice(1); withAliasFileLock(path, () => { const old = readFileSync(path, 'utf8').split(/\\r?\\n/).filter(Boolean); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); writeFileSync(path, [...old, value].join('\\n') + '\\n'); });";
    const run = promisify(execFile);
    await Promise.all(['first', 'second'].map(value => run(process.execPath, ['--import', 'tsx', '-e', script, path, value], { windowsHide: true })));
    expect(readFileSync(path, 'utf8').trim().split(/\r?\n/).sort()).toEqual(['first', 'second']);
  });

  it('takes over an alias lock left by a dead process and creates a missing folder', () => {
    const dir = fresh(), path = join(dir, 'sub', 'alias-inbox.jsonl');
    expect(withAliasFileLock(path, () => 'made')).toBe('made');
    writeFileSync(`${path}.lock`, '2147483646');
    expect(withAliasFileLock(path, () => 'taken')).toBe('taken');
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('refuses a stale offer when policy id changed', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), smokeOk);
    const policy = JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8')); policy.providers.openrouter.models.label.id = 'vendor/model-9'; writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
    const offer = readAliasOffers(dir)[0]!;
    expect(settleAliasOffer(dir, offer.id, true, new Date(), join(dir, 'dispatch-data'))).toMatchObject({ ok: false, error: 'The policy now names vendor/model-9; refresh to get a current offer.' });
    expect(readAliasOffers(dir)[0]?.status).toBe('stale');
  });

  it('keeps the offer pending when routes.json cannot be read after queueing the policy edit', async () => {
    const dir = fresh(); seed(dir);
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), smokeOk);
    rmSync(join(dir, 'dispatch', 'routes.json'));
    const offer = readAliasOffers(dir)[0]!;
    expect(settleAliasOffer(dir, offer.id, true, new Date(), join(dir, 'dispatch-data'))).toMatchObject({ ok: false, error: 'routes.json could not be read. The policy edit is queued; the offer is still pending.' });
    expect(readAliasOffers(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, 'policy-edits.jsonl'), 'utf8')).toContain('"value":"vendor/model-2"');
  });

  it('does not overlap an in-flight alias refresh', async () => {
    let release!: () => void, calls = 0;
    const slow = singleFlight(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return { offers: [] }; });
    const first = slow();
    expect(await slow()).toEqual({ error: 'An alias refresh is already running.' });
    expect(calls).toBe(1);
    release(); await first;
  });

  it('skips image and speech smoke prompts and records their kind', async () => {
    for (const kind of ['image', 'speech'] as const) {
      const dir = fresh(); seed(dir, kind); let smoked = false;
      await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), async () => { smoked = true; return { status: 'succeeded' }; });
      expect(smoked).toBe(false);
      expect(readAliasOffers(dir)[0]).toMatchObject({ tested: false, notes: ['capabilities not compared', `not smoke-tested: ${kind}`] });
    }
  });

  it('backs up malformed state, inbox lines, and flags and continues refresh', async () => {
    const dir = fresh(); seed(dir);
    writeFileSync(join(dir, 'alias-refresh.json'), '{bad');
    writeFileSync(join(dir, 'alias-flags.json'), '{bad');
    writeFileSync(join(dir, 'alias-inbox.jsonl'), '{bad\n');
    await refreshAliasFiles(dir, listings, undefined, new Date('2025-02-01T00:00:00Z'), smokeOk);
    expect(readAliasOffers(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, 'alias-refresh.json.bad'), 'utf8')).toBe('{bad');
    expect(readFileSync(join(dir, 'alias-flags.json.bad'), 'utf8')).toBe('{bad');
    expect(readFileSync(join(dir, 'alias-inbox.jsonl.bad'), 'utf8')).toBe('{bad\n');
  });
});
