import { describe, expect, it } from 'vitest';
import { openRules } from './open-rules.js';
import { buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { BOOST, boostFor, govern, paceState, rank, resolveBalance } from '../src/index.js';
import type { PaceState, UsageSnapshot } from '../src/index.js';

const now = new Date('2026-09-28T12:00:00Z');
const WEEK = 7 * 24 * 3600;
const level = { write_code: 'normal', review_code: 'normal', draft_prose: 'normal' };

function policy(balance?: Record<string, unknown>, extra: Record<string, unknown> = {}): PolicyFile {
  const rules = { providers: {
    grok: { defaults: { dataTier: 'sensitive', output: 'write_files', cost: 'moderate' }, models: {
      'xai/grok': { id: 'grok-4.7', rule: { activities: level } } } },
    claude: { defaults: { dataTier: 'regulated', output: 'write_files', cost: 'moderate' }, models: {
      'claude/live': { id: 'claude-opus-5-5', rule: { activities: level } },
      'claude/claude-sonnet-5-5': { id: 'claude-sonnet-5-5', rule: { activities: level } } } },
    ...extra,
  } };
  const p = emptyPolicy(); importPolicy(p, openRules(rules), now);
  for (const [id, provider] of Object.entries(p.providers)) for (const label of Object.keys(provider.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
  if (balance) p.balance = balance;
  return buildPolicyFile(p, Object.keys(p.providers).map(id => ({ id, name: id, metered: true })), now);
}

/** A window `elapsed` of the way through, `used` percent spent. */
function meter(used: number, elapsed: number, kind: 'weekly' | 'session' = 'weekly') {
  const seconds = kind === 'weekly' ? WEEK : 5 * 3600;
  return { id: kind, label: kind, usedPct: used, windowKind: kind, windowSeconds: seconds, resetsAt: new Date(now.getTime() + (1 - elapsed) * seconds * 1000).toISOString() };
}
function snap(id: string, meters: object[], fetchedAt = now.toISOString()): UsageSnapshot {
  return { providers: { [id]: { fetchedAt, meters: meters as UsageSnapshot['providers'][string]['meters'] } } };
}
function boost(id: string, meters: object[], balance?: Record<string, unknown>, fetchedAt?: string) {
  const usage = snap(id, meters, fetchedAt), rules = resolveBalance(balance);
  return boostFor(paceState(usage, rules, id, now), usage, rules, now);
}

describe('the unused-allowance boost', () => {
  it('keeps the fade and the fit floor in one place', () => {
    expect(BOOST.rampEnd).toBe(0.1);
    expect(BOOST.fitFloor).toBe(0.6);
  });

  it('is the peak on a fresh window and fades as the allowance is used', () => {
    const fresh = boost('grok', [meter(0, 0)]);
    expect(fresh.boost).toBe(1.5);
    expect(fresh.why).toBe('Grok has used 0% of its week with 7 days left, so it gets a 1.5x boost');
    expect(boost('grok', [meter(50, 0.5)]).boost).toBe(1.25);
    // Spent through the curve, with the hot and reserve guards held off, is 1.
    const spent: PaceState = { provider: 'grok', stance: 'on pace', tracks: [], peak: 100, atReserve: false };
    const full = snap('grok', [meter(100, 0.5)]);
    expect(boostFor(spent, full, resolveBalance(undefined), now)).toEqual({ boost: 1, why: '' });
  });

  it('fades over the last tenth of the window', () => {
    const near = { id: 'weekly', label: 'weekly', usedPct: 0, windowKind: 'weekly', windowSeconds: WEEK, resetsAt: new Date(now.getTime() + 0.05 * WEEK * 1000).toISOString() };
    expect(boost('grok', [near]).boost).toBe(1.25);
  });

  it('stays at 1 with no reset, when hot, at the reserve, when the peak is 1, and when the figures are stale', () => {
    expect(boost('grok', [{ id: 'weekly', label: 'weekly', usedPct: 0, windowKind: 'weekly' }])).toEqual({ boost: 1, why: '' });
    expect(boost('grok', [meter(70, 0.4)]).boost).toBe(1);
    expect(boost('grok', [meter(92, 0.92)]).boost).toBe(1);
    expect(boost('grok', [meter(0, 0)], { pace: { grok: { boost: 1 } } }).boost).toBe(1);
    expect(boost('grok', [meter(0, 0)], undefined, new Date(now.getTime() - 3 * 3600e3).toISOString()).boost).toBe(1);
  });

  it('uses the window that is furthest spent', () => {
    const two = boost('grok', [meter(80, 0.8, 'session'), meter(10, 0.5)]);
    expect(two.boost).toBe(1.1);
    expect(two.why).toBe('Grok has used 80% of its session with 1 hour left, so it gets a 1.1x boost');
  });

  it('boosts Claude the same way', () => {
    const claude = boost('claude', [meter(0, 0)]);
    expect(claude.boost).toBe(1.5);
    expect(claude.why.startsWith('Claude has used 0% of its week')).toBe(true);
  });

  it('boosts a route at or above the fit floor, and a route the caller did not score', () => {
    const usage = snap('grok', [meter(0, 0)]);
    const open = rank(policy(), usage, { activity: 'write_code', dataTier: 'internal' }, now);
    expect(open.ranking.find(x => x.model === 'xai/grok')?.boost).toBe(1.5);
    const low = rank(policy(), usage, { activity: 'write_code', dataTier: 'internal', fits: { 'xai/grok': 0.59 } }, now);
    expect(low.ranking.find(x => x.model === 'xai/grok')?.boost).toBe(1);
    const at = rank(policy(), usage, { activity: 'write_code', dataTier: 'internal', fits: { 'xai/grok': 0.6 } }, now);
    expect(at.ranking.find(x => x.model === 'xai/grok')?.boost).toBe(1.5);
    const raised = rank(policy({ boostFitFloor: 0.8 }), usage, { activity: 'write_code', dataTier: 'internal', fits: { 'xai/grok': 0.7 } }, now);
    expect(raised.ranking.find(x => x.model === 'xai/grok')?.boost).toBe(1);
  });

  it('stays at 1 when the balance is off', () => {
    const r = rank(policy({ enabled: false }), snap('grok', [meter(0, 0)]), { activity: 'write_code', dataTier: 'internal' }, now);
    expect(r.ranking.every(x => x.boost === 1)).toBe(true);
  });
});

describe('a snippet', () => {
  const prose = (snippet?: boolean, usage?: UsageSnapshot) => rank(policy(), usage ?? null, { activity: 'draft_prose', dataTier: 'internal', ...(snippet ? { snippet: true } : {}) }, now);

  it('skips the prose tilt and the prose switch, and says so', () => {
    const plain = prose();
    expect(plain.pick).toBe('claude/live');
    expect(plain.ranking.find(x => x.model === 'claude/live')?.tilt).toBe(1.3);
    expect(plain.notes).not.toContain('snippet: prose routes are not preferred');
    const one = prose(true);
    expect(one.notes).toContain('snippet: prose routes are not preferred');
    expect(one.ranking.find(x => x.model === 'claude/live')?.tilt).toBe(0.85);
    expect(one.pick).toBe('claude/claude-sonnet-5-5');
  });

  it('does not move prose off a hot provider', () => {
    const hot = snap('claude', [meter(60, 0.4)]);
    expect(prose(false, hot).blocked.some(b => b.model === 'claude/live')).toBe(true);
    const one = prose(true, hot);
    expect(one.blocked.some(b => b.model === 'claude/live')).toBe(false);
    expect(one.notes).toContain('snippet: prose routes are not preferred');
  });

  it('adds the note even when the balance is off, and the old call still works', () => {
    const off = policy({ enabled: false });
    expect(govern(off, 'draft_prose', undefined, undefined, undefined, null, now, false, true).notes).toEqual(['snippet: prose routes are not preferred']);
    expect(govern(off, 'draft_prose').notes).toEqual([]);
  });
});
