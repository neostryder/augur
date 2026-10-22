import { describe, it, expect } from 'vitest';
import { openRules } from './open-rules.js';
import { addModels, buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { JOB_STATES, canTransition, exitCodeForState, isTerminal, statesBefore } from '../src/states.js';
import { rank } from '../src/pick.js';
import { checkLineage, evaluate } from '../src/rules.js';
import type { AdapterCapabilities, JobRequest, RouteConfig } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const RULES = { providers: {
  codex: { defaults: { dataTier: 'sensitive', output: 'write_files' }, models: {
    'codex/sol': { id: 'gpt-6-sol', rule: { activities: { write_code: 'preferred', review_code: 'often' } } },
    'codex/luna': { id: 'gpt-6-luna', rule: { activities: { summarize_extract: 'preferred' }, pause: { until: '2026-09-29T00:00:00Z', weights: null } } } } },
  minimax: { models: { 'minimax/m3': { id: 'MiniMax-M3', rule: { dataTier: 'public', sandbox: true, output: 'patch_only', activities: { write_code: 'last_resort' } } },
    'minimax/api': { id: 'MiniMax-M3', rule: { dataTier: 'public', output: 'patch_only', activities: { read_images: 'often' } } } } },
  fable: { models: { 'claude/fable': { id: 'fable', rule: { askFirst: true, dataTier: 'internal', activities: { research: 'normal' } } } } },
} };
function policy(confirm = ['codex/sol', 'codex/luna', 'minimax/m3', 'minimax/api', 'claude/fable']): PolicyFile {
  const p = emptyPolicy(); importPolicy(p, openRules(RULES), now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) if (confirm.includes(label)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
}
const host: AdapterCapabilities = { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: true };
const sandbox: AdapterCapabilities = { ...host, sandboxed: true, isolatesWorkspace: true };
const route = (model: string): RouteConfig => ({ model, adapter: 'x' });
const req = (over: Partial<JobRequest> = {}): JobRequest => ({ route: 'r', activity: 'write_code', dataTier: 'internal', tools: 'write', output: 'write_files', cwd: 'C:/x', prompt: { text: 'hi' }, caller: { kind: 'cli' }, ...over });

describe('job states', () => {
  it('lets terminal states go nowhere and running reach every outcome', () => {
    for (const s of JOB_STATES) if (isTerminal(s)) for (const t of JOB_STATES) expect(canTransition(s, t)).toBe(false);
    expect(canTransition('running', 'cancel_requested')).toBe(true);
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(statesBefore('cancelled')).toContain('cancel_requested');
  });
  it('maps every state to a CLI exit code', () => {
    expect(JOB_STATES.map(exitCodeForState)).toEqual([4, 3, 4, 6, 0, 4, 5, 6, 4, 7]);
  });
});

describe('rules', () => {
  it('allows a confirmed model for a permitted activity and data tier', () => {
    const d = evaluate(req(), { policy: policy(), usage: null, route: route('codex/sol'), capabilities: host, now });
    expect(d.allow).toBe(true);
  });
  it('rejects without a policy, for an unknown model, and for one that is not confirmed', () => {
    expect(evaluate(req(), { policy: null, usage: null, route: route('codex/sol'), capabilities: host, now })).toMatchObject({ rejection: { code: 'no_policy' } });
    expect(evaluate(req(), { policy: policy(), usage: null, route: route('nope/none'), capabilities: host, now })).toMatchObject({ rejection: { code: 'unknown_model' } });
    expect(evaluate(req(), { policy: policy([]), usage: null, route: route('codex/sol'), capabilities: host, now })).toMatchObject({ rejection: { code: 'model_unreviewed' } });
  });
  it('rejects an activity the model was not given, and data above its tier', () => {
    expect(evaluate(req({ activity: 'research' }), { policy: policy(), usage: null, route: route('codex/sol'), capabilities: host, now })).toMatchObject({ rejection: { code: 'activity_not_permitted' } });
    expect(evaluate(req({ dataTier: 'regulated' }), { policy: policy(), usage: null, route: route('codex/sol'), capabilities: host, now })).toMatchObject({ rejection: { code: 'data_tier_too_high' } });
  });
  it('holds ask-first models until they are named and honors a pause until its date', () => {
    const fable = req({ activity: 'research', tools: 'read', output: 'text_only', dataTier: 'internal' });
    expect(evaluate(fable, { policy: policy(), usage: null, route: route('claude/fable'), capabilities: host, now })).toMatchObject({ rejection: { code: 'ask_first' } });
    expect(evaluate({ ...fable, named: true }, { policy: policy(), usage: null, route: route('claude/fable'), capabilities: host, now }).allow).toBe(true);
    const luna = req({ activity: 'summarize_extract' });
    expect(evaluate(luna, { policy: policy(), usage: null, route: route('codex/luna'), capabilities: host, now })).toMatchObject({ rejection: { code: 'model_paused' } });
    expect(evaluate(luna, { policy: policy(), usage: null, route: route('codex/luna'), capabilities: host, now: new Date('2026-09-30T00:00:00Z') }).allow).toBe(true);
  });
  it('needs a sandbox and an isolated workspace for a sandbox-only, patch-only model', () => {
    const r = req({ dataTier: 'public', output: 'patch_only' });
    expect(evaluate(r, { policy: policy(), usage: null, route: route('minimax/m3'), capabilities: host, now })).toMatchObject({ rejection: { code: 'sandbox_required' } });
    expect(evaluate(r, { policy: policy(), usage: null, route: route('minimax/m3'), capabilities: sandbox, now }).allow).toBe(true);
    expect(evaluate({ ...r, output: 'write_files' }, { policy: policy(), usage: null, route: route('minimax/m3'), capabilities: sandbox, now })).toMatchObject({ rejection: { code: 'isolation_required' } });
  });
  it('lets a patch-only model run a text-only read job on a host adapter, and nothing that could write', () => {
    const read = req({ activity: 'read_images', dataTier: 'public', tools: 'read', output: 'text_only' });
    const api = route('minimax/api');
    expect(evaluate(read, { policy: policy(), usage: null, route: api, capabilities: host, now }).allow).toBe(true);
    expect(evaluate({ ...read, tools: 'write' }, { policy: policy(), usage: null, route: api, capabilities: host, now })).toMatchObject({ rejection: { code: 'isolation_required' } });
    expect(evaluate({ ...read, output: 'patch_only' }, { policy: policy(), usage: null, route: api, capabilities: host, now })).toMatchObject({ rejection: { code: 'isolation_required' } });
    expect(evaluate(read, { policy: policy(), usage: null, route: api, capabilities: { ...host, enforcesReadOnly: false }, now })).toMatchObject({ rejection: { code: 'isolation_required' } });
  });
  it('never picks a model added with a proposed rule until its status is confirmed', () => {
    const stored = emptyPolicy();
    addModels(stored, 'acme', [{ label: 'acme/fast', id: 'fast-1', rule: { activities: { write_code: 'preferred' }, dataTier: 'internal', askFirst: false, output: 'write_files', sandbox: false, pause: { until: '2099-01-01T00:00:00Z' }, notes: 'smuggled' } }], 'manual', now);
    const entry = stored.providers.acme?.models['acme/fast'];
    expect(entry?.status).toBe('unreviewed');
    expect(entry?.rule.pause).toBeUndefined();
    expect(entry?.rule.notes).toBeUndefined();
    expect(entry?.rule.activities).toEqual({ write_code: 'preferred' });
    const meta = [{ id: 'acme', name: 'acme', metered: false }];
    const file = buildPolicyFile(stored, meta, now);
    const blocked = rank(file, null, { activity: 'write_code', dataTier: 'internal' });
    expect(blocked.pick).toBeNull();
    expect(blocked.blocked.find(b => b.model === 'acme/fast')?.why).toBe('status unreviewed');
    expect(evaluate(req(), { policy: file, usage: null, route: route('acme/fast'), capabilities: host, now })).toMatchObject({ rejection: { code: 'model_unreviewed' } });
    setField(stored, fieldPath('acme', 'acme/fast', 'status'), 'confirmed', 'test', now);
    const confirmed = buildPolicyFile(stored, meta, now);
    expect(rank(confirmed, null, { activity: 'write_code', dataTier: 'internal' }).pick).toBe('acme/fast');
    expect(evaluate(req(), { policy: confirmed, usage: null, route: route('acme/fast'), capabilities: host, now }).allow).toBe(true);
  });
  it('denies at the deny threshold and warns at the warn threshold', () => {
    const usage = (pct: number) => ({ providers: { codex: { meters: [{ id: 'plan_weekly', usedPct: pct }] } } });
    expect(evaluate(req(), { policy: policy(), usage: usage(98), route: route('codex/sol'), capabilities: host, now })).toMatchObject({ rejection: { code: 'quota_denied' } });
    const warn = evaluate(req(), { policy: policy(), usage: usage(92), route: route('codex/sol'), capabilities: host, now });
    expect(warn.allow && warn.warnings).toHaveLength(1);
  });
});

describe('lineage', () => {
  const child = (depth: number) => req({ parent: { jobId: 'a', rootJobId: 'a', depth } });
  it('rejects a child unless the parent route grants delegation, and bounds depth and fan-out', () => {
    expect(checkLineage(req(), null, 0)).toBeNull();
    expect(checkLineage(child(0), { model: 'x/y', adapter: 'a' }, 0)).toMatchObject({ code: 'delegation_not_granted' });
    const granting = { model: 'x/y', adapter: 'a', delegation: true };
    expect(checkLineage(child(0), granting, 0)).toBeNull();
    expect(checkLineage(child(2), granting, 0)).toMatchObject({ code: 'depth_exceeded' });
    expect(checkLineage(child(0), granting, 16)).toMatchObject({ code: 'descendants_exceeded' });
  });
});
