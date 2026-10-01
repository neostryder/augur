import { describe, expect, it } from 'vitest';
import { buildPolicyFile, migratePolicy, processInbox, emptyEditState } from '@augur/core';
import type { PolicyEdit } from '@augur/core';
import { createTools } from '../src/tools.js';
import type { McpDeps } from '../src/tools.js';

const now = new Date('2026-10-01T00:30:00Z');
const stored = migratePolicy({ providers: {
  minimax: { defaults: { activities: { review_code: 'often', long_context: 'normal', write_code: 'normal' }, cost: 'free' },
    models: { 'minimax/m3': { id: 'MiniMax-M3', source: 'manual', status: 'confirmed', rule: { dataTier: 'public', askFirst: false } } } },
  openrouter: { defaults: {}, models: { 'deepseek/v4.1-flash': { id: 'deepseek/deepseek-v4.1-flash', source: 'live', status: 'confirmed',
    rule: { dataTier: 'internal', cost: 'cheap', activities: { review_code: 'often', write_code: 'normal' } } } } },
} });
const POLICY = JSON.stringify(buildPolicyFile(stored, [{ id: 'minimax', name: 'MiniMax', metered: false }, { id: 'openrouter', name: 'OpenRouter', metered: false }], now));

function rig(files: { inbox?: string; state?: string } = {}) {
  const inbox: string[] = files.inbox ? [files.inbox] : [];
  const deps: McpDeps = {
    call: (async () => { throw new Error('the service is not used here'); }) as never, opts: {}, policyText: () => POLICY, usageText: () => null,
    inboxText: () => inbox.join(''), editStateText: () => files.state ?? null, appendInbox: lines => { inbox.push(lines); },
    session: 'mcp-test', cwd: '/work',
  };
  return { tools: createTools(deps), inbox };
}
const sent = (inbox: string[]): PolicyEdit[] => inbox.join('').split('\n').filter(Boolean).map(l => JSON.parse(l) as PolicyEdit);

describe('augur_policy', () => {
  it('returns every model with its fields, and the edits waiting', async () => {
    const edit: PolicyEdit = { id: 'q1', at: now.toISOString(), by: 'a', provider: 'minimax', model: 'minimax/m3', field: 'activities.long_context', value: 'preferred' };
    const r = await rig({ inbox: `${JSON.stringify(edit)}\n` }).tools.policy();
    expect(r.text).toContain('2 models. 1 edit queued for the app, 0 waiting for the owner.');
    const providers = (r.data as { providers: Record<string, { models: Record<string, { dataTier: string; activities: Record<string, string> }> }> }).providers;
    expect(providers.minimax!.models['minimax/m3']).toMatchObject({ dataTier: 'public', activities: { long_context: 'normal' } });
  });
  it('says so when policy.json is missing', async () => {
    const t = createTools({ call: (async () => null) as never, opts: {}, policyText: () => null, session: 's', cwd: '/' });
    expect(await t.policy()).toMatchObject({ isError: true });
  });
});

describe('augur_policy_edit', () => {
  it('queues weight edits, holds data-access edits for the owner, and rejects bad ones, writing only the valid to the inbox', async () => {
    const { tools, inbox } = rig();
    const r = await tools.editPolicy({ edits: [
      { model: 'minimax/m3', field: 'activities.long_context', value: 'preferred' },
      { model: 'minimax/m3', field: 'dataTier', value: 'internal', reason: 'Most tasks are internal.' },
      { model: 'minimax/m3', field: 'activities.cooking', value: 'often' },
      { model: 'nothing/here', field: 'notes', value: 'x' },
    ] });
    const rows = (r.data as { edits: Array<Record<string, unknown>> }).edits;
    expect(rows.map(x => x.status)).toEqual(['queued', 'needs-owner', 'rejected', 'rejected']);
    expect(rows[0]).toMatchObject({ before: 'normal', value: 'preferred' });
    expect(rows[1]).toMatchObject({ before: 'public', value: 'internal' });
    expect(r.text).toContain('1 queued, 1 waiting for the owner');
    const written = sent(inbox);
    expect(written.map(e => [e.provider, e.model, e.field])).toEqual([['minimax', 'minimax/m3', 'activities.long_context'], ['minimax', 'minimax/m3', 'dataTier']]);
    expect(written[1]).toMatchObject({ reason: 'Most tasks are internal.' });
  });
  it('is an error when nothing in the request is valid, and writes nothing', async () => {
    const { tools, inbox } = rig();
    const r = await tools.editPolicy({ edits: [{ model: 'minimax/m3', field: 'dataTier', value: 'top-secret' }] });
    expect(r.isError).toBe(true);
    expect(inbox).toEqual([]);
  });
  it('takes a provider thresholds edit by provider name', async () => {
    const { tools, inbox } = rig();
    const r = await tools.editPolicy({ edits: [{ provider: 'minimax', field: 'thresholds.denyPct', value: 95 }] });
    expect((r.data as { edits: Array<Record<string, unknown>> }).edits[0]).toMatchObject({ status: 'needs-owner' });
    expect(sent(inbox)[0]).toMatchObject({ provider: 'minimax', model: '', field: 'thresholds.denyPct' });
  });
  it('writes edits the app can read back and apply', async () => {
    const { tools, inbox } = rig();
    await tools.editPolicy({ edits: [{ model: 'minimax/m3', field: 'activities.long_context', value: 'preferred' }] });
    const applied = processInbox(stored, sent(inbox), emptyEditState(), 'desktop', now);
    expect(applied.changed).toBe(true);
    expect(applied.state.results[0]).toMatchObject({ status: 'applied', before: 'normal', after: 'preferred' });
  });
});

describe('augur_pick_preview', () => {
  it('ranks now and with the edits, and leaves what is not applicable listed', async () => {
    const { tools } = rig();
    const r = await tools.pickPreview({ activity: 'long_context', data_tier: 'public', edits: [
      { model: 'minimax/m3', field: 'activities.long_context', value: 'preferred' },
      { model: 'minimax/m3', field: 'activities.long_context', value: 'inherit' },
    ] });
    const d = r.data as { now: { pick: string | null }; withEdits: { pick: string | null }; applied: number; problems: string[] };
    expect(d.applied).toBe(1);
    expect(d.problems).toHaveLength(1);
    expect(d.withEdits.pick).toBe('minimax/m3');
    expect(r.text).toContain('long_context on public data.');
  });
  it('shows a model dropping out when its data tier is lowered, without touching the real rules', async () => {
    const { tools } = rig();
    const r = await tools.pickPreview({ activity: 'review_code', data_tier: 'internal', edits: [{ model: 'deepseek/v4.1-flash', field: 'dataTier', value: 'public' }] });
    const d = r.data as { now: { ranking: Array<{ model: string }> }; withEdits: { ranking: Array<{ model: string }> } };
    expect(d.now.ranking.map(x => x.model)).toContain('deepseek/v4.1-flash');
    expect(d.withEdits.ranking.map(x => x.model)).not.toContain('deepseek/v4.1-flash');
  });
  it('can include the edits already waiting', async () => {
    const edit: PolicyEdit = { id: 'w1', at: now.toISOString(), by: 'a', provider: 'minimax', model: 'minimax/m3', field: 'dataTier', value: 'internal' };
    const r = await rig({ inbox: `${JSON.stringify(edit)}\n` }).tools.pickPreview({ activity: 'long_context', data_tier: 'internal', include_pending: true });
    expect((r.data as { now: { ranking: unknown[] }; withEdits: { ranking: unknown[] } }).withEdits.ranking.length).toBeGreaterThan((r.data as { now: { ranking: unknown[] } }).now.ranking.length);
  });
});
