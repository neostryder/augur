import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Host, ProviderPlugin, Snapshot, Meter } from '../src/types.js';
import { claude, codex, grok, minimax, openrouter, fal, jev, copilot } from '../src/providers/index.js';
import { genericProvider, readPath, evaluate } from '../src/generic.js';
import { calculatePace } from '../src/pace.js';
import { appendHistory } from '../src/history.js';
import { fetchStatus } from '../src/status.js';
import { evaluateAlerts } from '../src/alerts.js';
import { collect, dueProviders, refreshInterval, DEFAULT_REFRESH_SECONDS, RETRY_SECONDS } from '../src/engine.js';
import { defaultConfig, migrateConfig } from '../src/config.js';
import { compareVersions, releaseChanges } from '../src/changelog.js';

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const at = new Date('2026-09-26T12:00:00Z');
const fakeHost = (respond: (url: string, headers: Record<string, string>, body?: string) => unknown): Host => ({
  platform: 'windows', now: () => at, secret: async () => 'test-only',
  http: async req => ({ status: 200, headers: {}, body: JSON.stringify(respond(req.url, req.headers ?? {}, req.body)) })
});
const fetchOne = async (plugin: ProviderPlugin, data: unknown, extra?: unknown, settings: Record<string, string | boolean | undefined> = {}) => {
  const host = fakeHost(url => url.includes('models/usage') ? extra : url.endsWith('/key') ? { data: (data as any).key } : url.endsWith('/credits') ? { data: (data as any).credits } : data);
  if (plugin === claude || plugin === codex || plugin === grok) {
    host.readHomeFile = async path => path.includes('.claude') ? JSON.stringify({ claudeAiOauth: { accessToken: 'test-only', expiresAt: at.getTime() + 9999999, subscriptionType: 'pro' } }) :
      path.includes('.codex') ? JSON.stringify({ tokens: { access_token: `a.${btoa(JSON.stringify({ exp: at.getTime() / 1000 + 99999 }))}.c`, account_id: 'test-only' } }) :
      JSON.stringify({ test: { key: 'test-only', expires_at: '2099-01-01T00:00:00Z' } });
  }
  return plugin.fetch(host, settings);
};

describe('provider parsers', () => {
  it('parses Claude usage', async () => {
    const result = await fetchOne(claude, await fixture('claude'));
    expect(result.meters[0]?.id).toBe('session');
    expect(result.meters[0]?.windowSeconds).toBe(18000);
    expect(result.meters.some(m => m.windowKind === 'weekly')).toBe(true);
  });
  it('reports the limit resets a person enters for Claude, since its API does not', async () => {
    expect((await fetchOne(claude, await fixture('claude'))).notes?.resets_available).toBeUndefined();
    expect((await fetchOne(claude, await fixture('claude'), undefined, { resets: '1' })).notes?.resets_available).toBe(1);
    expect((await fetchOne(claude, await fixture('claude'), undefined, { resets: 'many' })).notes?.resets_available).toBeUndefined();
  });
  it('parses Codex usage', async () => {
    const result = await fetchOne(codex, await fixture('codex'));
    expect(result.meters.find(m => m.id === 'plan_weekly')?.usedPct).toBe((await fixture('codex')).rate_limit.primary_window.used_percent);
    expect(result.meters[0]?.windowSeconds).toBe(604800);
  });
  it('parses Grok billing', async () => {
    const result = await fetchOne(grok, await fixture('grok'));
    expect(result.meters[0]?.id).toBe('supergrok');
    expect(result.meters[0]?.windowSeconds).toBeGreaterThan(0);
    expect(result.money[0]?.id).toBe('prepaid');
  });
  it('reads Copilot credits against the spending cap', async () => {
    const data = { copilot_plan: 'enterprise', quota_reset_date_utc: '2026-10-01T00:00:00.000Z', quota_snapshots: { premium_interactions: { credits_used: 253, overage_permitted: true, unlimited: true } } };
    const host = fakeHost(() => data);
    host.run = async (command, args) => command === 'gh' && args.join(' ') === 'auth token' ? { code: 0, stdout: 'test-only', stderr: '' } : { code: 1, stdout: '', stderr: '' };
    const result = await copilot.fetch(host, { capUsd: '250' });
    const meter = result.meters[0]!;
    expect(meter.id).toBe('monthly_credits');
    expect(meter.usedPct).toBe(1);
    expect(meter.resetsAt).toBe('2026-10-01T00:00:00.000Z');
    expect(meter.windowKind).toBe('monthly');
    expect(result.money[0]).toMatchObject({ amount: 2.53, total: 250 });
    expect((await copilot.fetch(host, {})).meters[0]!.usedPct).toBe(1);
    host.run = async () => ({ code: 1, stdout: '', stderr: 'not logged in' });
    await expect(copilot.fetch(host, {})).rejects.toThrow('gh auth login');
  });
  it('parses MiniMax remaining as used', async () => {
    const result = await fetchOne(minimax, await fixture('minimax'));
    expect(result.meters.find(m => m.id === 'general_5h')?.usedPct).toBe(4);
    expect(result.meters.find(m => m.id === 'general_weekly')?.usedPct).toBe(2);
  });
  it('parses OpenRouter through the generic engine', async () => {
    const result = await fetchOne(openrouter, await fixture('openrouter'));
    expect(result.money[0]?.amount).toBe(12.66);
    expect(result.money[0]?.total ?? null).toBeNull();
    expect(result.money.find(m => m.id === 'month')?.amount).toBeGreaterThan(0);
    // No limit is set on the key, so no percentage meter is invented from credits bought.
    expect(result.meters.find(m => m.id === 'key_limit')).toBeUndefined();
  });
  it('parses fal balance and usage', async () => {
    const data = await fixture('fal');
    const result = await fetchOne(fal, data, { summary: data.usage_summary });
    expect(result.money.find(m => m.id === 'balance')?.amount).toBe(2);
    expect(result.money.find(m => m.id === 'month')?.amount).toBeGreaterThan(0);
    expect((result.notes?.top_endpoints as unknown[]).length).toBe(5);
  });
  it('reports Jev health without fake percentages', async () => {
    const host = fakeHost(() => ({ model: 'jev-latest', answers: { billing: { noul: 0.9 } } }));
    const result = await jev.fetch(host, {});
    expect(result.meters).toEqual([]);
    expect(result.detail).toContain('answered');
  });
});

describe('refresh', () => {
  it.each(['expired', 'unauthorized'])('refreshes Claude on %s and re-reads before writing', async branch => {
    const data = await fixture('claude');
    let reads = 0, writes = 0, usageCalls = 0;
    const host = fakeHost(url => {
      if (url.includes('/oauth/token')) return { access_token: 'new-test-only', expires_in: 3600 };
      usageCalls++;
      return data;
    });
    host.readHomeFile = async () => { reads++; return JSON.stringify({ cli_field: reads, claudeAiOauth: { accessToken: 'old-test-only', refreshToken: 'refresh-test-only', expiresAt: branch === 'expired' ? 0 : at.getTime() + 9999999 } }); };
    host.writeHomeFileAtomic = async (_, value) => { writes++; expect(JSON.parse(value).cli_field).toBe(reads); };
    if (branch === 'unauthorized') {
      const http = host.http;
      host.http = async req => req.url.includes('/api/oauth/usage') && usageCalls++ === 0 ? { status: 401, headers: {}, body: '{}' } : http(req);
    }
    await claude.fetch(host, {});
    expect(writes).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(3);
  });
  it.each(['expired', 'unauthorized'])('refreshes Codex on %s and preserves latest auth fields', async branch => {
    const data = await fixture('codex');
    let reads = 0, writes = 0, usageCalls = 0;
    const host = fakeHost(url => url.includes('/oauth/token') ? { access_token: `a.${btoa(JSON.stringify({ exp: at.getTime() / 1000 + 10000 }))}.c` } : (usageCalls++, data));
    host.readHomeFile = async () => { reads++; return JSON.stringify({ cli_field: reads, tokens: { access_token: `a.${btoa(JSON.stringify({ exp: branch === 'expired' ? 0 : at.getTime() / 1000 + 10000 }))}.c`, refresh_token: 'test-only', account_id: 'test-only' } }); };
    host.writeHomeFileAtomic = async (_, value) => { writes++; expect(JSON.parse(value).cli_field).toBe(reads); };
    if (branch === 'unauthorized') {
      const http = host.http;
      host.http = async req => req.url.includes('/wham/usage') && usageCalls++ === 0 ? { status: 401, headers: {}, body: '{}' } : http(req);
    }
    await codex.fetch(host, {});
    expect(writes).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});

describe('generic definitions', () => {
  it('reads indexed and filtered paths and arithmetic without code execution', () => {
    const data = { main: { rows: [{ kind: 'a', value: 4 }, { kind: 'b', value: 8 }] } };
    expect(readPath(data.main, '$.rows[0].value')).toBe(4);
    expect(evaluate('=100 - (main:$.rows[kind=b].value * 2)', data)).toBe(84);
    expect(() => evaluate('=globalThis.process.exit()', data)).toThrow();
  });
  it.each(['bearer', 'header', 'query', 'none'] as const)('supports %s auth', async type => {
    let seenUrl = '', seenHeaders: Record<string, string> = {};
    const plugin = genericProvider({ id: 'sample', name: 'Sample', auth: { type, name: type === 'query' ? 'token' : 'X-Key' },
      requests: { main: { url: 'https://example.test/usage' } }, money: [{ id: 'balance', label: 'Balance', amount: 'main:$.balance' }] });
    const host = fakeHost((url, headers) => { seenUrl = url; seenHeaders = headers; return { balance: 3 }; });
    await plugin.fetch(host, {});
    if (type === 'query') expect(seenUrl).toContain('token=test-only');
    if (type === 'header') expect(seenHeaders['X-Key']).toBe('test-only');
    if (type === 'bearer') expect(seenHeaders.Authorization).toBe('Bearer test-only');
    if (type === 'none') expect(seenHeaders.Authorization).toBeUndefined();
  });
});

describe('engine, pace, history and alerts', () => {
  const meter: Meter = { id: 'session', label: 'Session', usedPct: 60, resetsAt: '2026-09-26T13:00:00Z', windowSeconds: 7200, windowKind: 'session' };
  const snapshot: Snapshot = { schema: 1, generatedAt: at.toISOString(), providers: { sample: { id: 'sample', name: 'Sample', ok: true, stale: false, fetchedAt: at.toISOString(), error: null,
    meters: [meter], money: [{ id: 'balance', label: 'Balance', amount: 3, currency: 'USD' }] } } };
  it('carries forward prior good data on a provider failure', async () => {
    const plugin: ProviderPlugin = { id: 'sample', name: 'Sample', links: {}, needsLocalLogin: false, fields: [], fetch: async () => { throw new Error('Missing key'); } };
    const result = await collect(fakeHost(() => ({})), { ...defaultConfig(), providers: [{ id: 'sample', enabled: true, settings: {} }] }, snapshot, [plugin], { force: true });
    expect(result.providers.sample?.stale).toBe(true);
    expect(result.providers.sample?.attemptedAt).toBe(at.toISOString());
    expect(result.providers.sample?.meters[0]?.usedPct).toBe(60);
    expect(result.providers.sample?.error).toBe('Missing key');
  });
  it('keeps a reading until its provider interval passes, unless forced', async () => {
    let calls = 0;
    const plugin: ProviderPlugin = { id: 'sample', name: 'Sample', links: {}, needsLocalLogin: false, fields: [], refreshSeconds: 3600,
      fetch: async () => { calls++; return { plan: null, meters: [{ ...meter, usedPct: 70 }], money: [] }; } };
    const config = { ...defaultConfig(), providers: [{ id: 'sample', enabled: true, settings: {} }] };
    const kept = await collect(fakeHost(() => ({})), config, snapshot, [plugin]);
    expect(calls).toBe(0);
    expect(kept.providers.sample?.meters[0]?.usedPct).toBe(60);
    const forced = await collect(fakeHost(() => ({})), config, snapshot, [plugin], { force: true });
    expect(calls).toBe(1);
    expect(forced.providers.sample?.meters[0]?.usedPct).toBe(70);
    const old = { ...snapshot, providers: { sample: { ...snapshot.providers.sample!, fetchedAt: new Date(at.getTime() - 7200_000).toISOString() } } };
    await collect(fakeHost(() => ({})), { ...config, providers: [{ ...config.providers[0]!, refreshSeconds: 1800 }] }, old, [plugin]);
    expect(calls).toBe(2);
  });
  it('reads unset providers on the default interval and retries failures sooner', () => {
    const config = { ...defaultConfig(), providers: [{ id: 'sample', enabled: true, settings: {} }] };
    const plugin: ProviderPlugin = { id: 'sample', name: 'Sample', links: {}, needsLocalLogin: false, fields: [], fetch: async () => ({ plan: null, meters: [], money: [] }) };
    const ago = (s: number) => new Date(at.getTime() - s * 1000).toISOString();
    const withLast = (last: Partial<Snapshot['providers'][string]>) => ({ ...snapshot, providers: { sample: { ...snapshot.providers.sample!, ...last } } });
    expect(refreshInterval(config, plugin)).toBe(DEFAULT_REFRESH_SECONDS);
    expect(dueProviders(config, null, [plugin], at.getTime())).toEqual(['sample']);
    expect(dueProviders(config, withLast({ fetchedAt: ago(DEFAULT_REFRESH_SECONDS - 60) }), [plugin], at.getTime())).toEqual([]);
    expect(dueProviders(config, withLast({ fetchedAt: ago(DEFAULT_REFRESH_SECONDS) }), [plugin], at.getTime())).toEqual(['sample']);
    expect(dueProviders(config, withLast({ ok: false, attemptedAt: ago(RETRY_SECONDS - 60) }), [plugin], at.getTime())).toEqual([]);
    expect(dueProviders(config, withLast({ ok: false, attemptedAt: ago(RETRY_SECONDS) }), [plugin], at.getTime())).toEqual(['sample']);
  });
  it('calculates pace and handles window edges', () => {
    const pace = calculatePace(meter, [], 'sample', at);
    expect(pace.burnRatio).toBeCloseTo(0.8);
    expect(pace.willExhaustBeforeReset).toBe(true);
    expect(calculatePace(meter, [], 'sample', new Date('2026-09-26T13:00:00Z')).burnRatio).toBeNull();
  });
  it('folds readings closer than a history row apart', () => {
    const at = (s: number) => ({ ...snapshot, generatedAt: new Date(Date.parse('2026-09-26T00:00:00Z') + s * 1000).toISOString() });
    let rows: ReturnType<typeof appendHistory> = [];
    for (let s = 0; s <= 900; s += 15) rows = appendHistory(rows, at(s), 86400);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows.at(-1)?.t).toBe(at(900).generatedAt);
    const failed = { ...at(915), providers: { sample: { ...snapshot.providers.sample!, ok: false } } };
    expect(appendHistory(rows, failed, 86400).at(-1)?.sample).toEqual(rows.at(-1)?.sample);
  });
  it('accepts a 15 second refresh interval and nothing shorter', () => {
    const migrated = (sec: number) => migrateConfig({ ...defaultConfig(), providers: [{ id: 'claude', enabled: true, refreshSeconds: sec, settings: {} }] }).providers.find(p => p.id === 'claude')?.refreshSeconds;
    expect(migrated(15)).toBe(15);
    expect(migrated(5)).toBeNull();
  });
  it('records money and meters, trims rows, and deduplicates alerts', () => {
    const rows = appendHistory([{ t: '2026-09-01T00:00:00Z' }], snapshot, 86400);
    expect(rows).toHaveLength(1);
    expect((rows[0]?.sample as Record<string, number>)['$balance']).toBe(3);
    const config = { ...defaultConfig().alerts, enabled: true, pctThresholds: [50], balanceBelow: { 'sample.balance': 5 }, paceRatio: { session: 0.9, weekly: null, other: null } };
    const first = evaluateAlerts(snapshot, [], config, {});
    expect(first.alerts.map(alert => alert.kind).sort()).toEqual(['balance', 'pace', 'percent']);
    expect(evaluateAlerts(snapshot, [], config, first.firedState).alerts).toEqual([]);
  });
  it('fills config defaults and drops unknown providers', () => {
    const config = migrateConfig({ providers: [{ id: 'unknown', enabled: true }, { id: 'claude', enabled: false }] });
    expect(config.providers.some(p => p.id === 'unknown')).toBe(false);
    expect(config.providers.find(p => p.id === 'claude')?.enabled).toBe(false);
    expect(config.providers).toHaveLength(8);
  });
  it('keeps jobs off until they are chosen, and reads only an explicit yes', () => {
    expect(migrateConfig({}).dispatch).toEqual({ runJobs: false });
    expect(migrateConfig({ dispatch: { runJobs: 'yes' } }).dispatch).toEqual({ runJobs: false });
    expect(migrateConfig({ dispatch: { runJobs: true } }).dispatch).toEqual({ runJobs: true });
  });
});

describe('changelog', () => {
  const log = ['# Changelog', '', '## [Unreleased]', '', '- [Visible] [UI] **Not out yet.**', '',
    '## [0.6.0] - 2026-09-28', '', '### Added', '', '- [Visible] [UI] **An update button.** It installs at once.', '- [Internal] [Docs] **Tooling only.**',
    '## [0.5.1] - 2026-09-27', '', '### Changed', '', '- [Visible] [Providers] Plain entry with no bold lead.',
    '## [0.5.0] - 2026-09-27', '', '- [Visible] [Sync] **Already installed.**'].join('\n');
  it('lists visible changes newer than the installed version, newest first', () => {
    expect(releaseChanges(log, '0.5.0', '0.6.0')).toEqual([
      { version: '0.6.0', changes: ['An update button.'] },
      { version: '0.5.1', changes: ['Plain entry with no bold lead.'] },
    ]);
    expect(releaseChanges(log, '0.6.0', '0.6.0')).toEqual([]);
  });
  it('compares versions by number', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.5.1', '0.5.1')).toBe(0);
    expect(compareVersions('0.5.0', '0.5.1')).toBe(-1);
  });
});

describe('provider status badge', () => {
  const links = { status: 'https://status.example/', statusApi: 'https://status.example/api/v2/status.json', statusComponents: ['CLI', 'Codex API'] };
  const page = (overall: string, components: Array<{ name: string; status: string; group?: boolean }>) => fakeHost(url => url.endsWith('/components.json') ? { components } : { status: { indicator: overall, description: 'Partial System Degradation' } });

  it('follows only the components a provider depends on, so an unrelated incident shows nothing', async () => {
    const host = page('minor', [{ name: 'Space', status: 'degraded_performance' }, { name: 'CLI', status: 'operational' }, { name: 'Codex API', status: 'operational' }]);
    expect(await fetchStatus(host, links)).toEqual({ indicator: 'none', description: 'All Systems Operational', url: links.status });
  });

  it('reports the worst of the named components and says which are affected', async () => {
    const host = page('none', [{ name: 'CLI', status: 'degraded_performance' }, { name: 'Codex API', status: 'partial_outage' }, { name: 'Space', status: 'major_outage' }]);
    expect(await fetchStatus(host, links)).toMatchObject({ indicator: 'major', description: 'CLI, Codex API: a partial outage' });
  });

  it('falls back to the whole page when the list names none of the components or cannot be read', async () => {
    expect(await fetchStatus(page('minor', [{ name: 'Other', status: 'operational' }]), links)).toMatchObject({ indicator: 'minor' });
    const broken = fakeHost(() => ({}));
    broken.http = async req => req.url.endsWith('/components.json') ? { status: 500, headers: {}, body: '' } : { status: 200, headers: {}, body: JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } }) };
    expect(await fetchStatus(broken, links)).toMatchObject({ indicator: 'none' });
    expect(await fetchStatus(page('minor', []), { ...links, statusComponents: undefined })).toMatchObject({ indicator: 'minor' });
  });
});
