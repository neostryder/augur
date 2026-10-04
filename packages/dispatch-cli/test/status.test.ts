import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IpcServer, ViewHub } from '@augur/augurd';
import { defaultConfig, emptyFeed, type EngineApi, type FeedAlert } from '@augur/core';
import { main } from '../src/cli.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const alert = (id: string, title: string): FeedAlert =>
  ({ id, kind: 'percent', severity: 'warn', title, body: `${title} body.`, raisedAt: '2026-10-04T11:00:00Z', outlets: ['augur'], clears: { when: 'never' } });

async function serve(withEngine = true) {
  const dir = mkdtempSync(join(tmpdir(), 'augur-status-')), token = 'k'.repeat(64);
  writeFileSync(join(dir, 'token'), token);
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augur-status-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(dir, 's.sock');
  const config = defaultConfig();
  config.providers = [{ id: 'claude', enabled: true, settings: {} }];
  const feed = emptyFeed();
  feed.alerts = [alert('a1', 'Claude at 75%'), alert('a2', 'Codex at 90%')];
  const calls: unknown[][] = [];
  const state = {
    config, feed, claudeError: '', claude: { code: '1.4.0', bundled: '1.4.0', desktop: false, desktopPossible: true },
    snapshot: { schema: 1, generatedAt: new Date().toISOString(), providers: { claude: { id: 'claude', name: 'Claude', ok: true, stale: false, fetchedAt: new Date().toISOString(), error: null, plan: null, money: [], notes: {},
      meters: [{ id: 'session', label: 'Session', usedPct: 32, windowKind: 'session', windowSeconds: 18_000 }, { id: 'weekly_all', label: 'Week', usedPct: 49, windowKind: 'weekly' }] } } },
  };
  const api = {
    state,
    onChange: () => () => {},
    async refresh(...a: unknown[]) { calls.push(['refresh', ...a]); },
    async dismiss(ids: string[]) { calls.push(['dismiss', ids]); },
    async setClaude(...a: unknown[]) { calls.push(['setClaude', ...a]); },
  } as unknown as EngineApi;
  const server = new IpcServer({} as never, {} as never, token, () => null);
  if (withEngine) server.attachEngine({ api, views: new ViewHub() });
  await server.start(pipe);
  cleanup.push(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = async (args: string[]) => {
    let out = '', err = '';
    const code = await main(args, { out: t => { out += t; }, err: t => { err += t; }, stdin: () => '', env: { ...process.env, AUGURD_DATA: dir, AUGURD_PIPE: pipe }, cwd: dir });
    return { code, out, err };
  };
  return { run, calls, dir };
}

describe('augur status', () => {
  it('prints one line of usage and the alert count, and the same as JSON for a status bar', async () => {
    const { run } = await serve();
    const line = await run(['status']);
    expect(line.code).toBe(0);
    expect(line.out.trim()).toBe('Claude 5h 32% | wk 49% | 2 Augur alerts');
    const bar = JSON.parse((await run(['status', '--waybar'])).out);
    expect(bar).toMatchObject({ text: 'Claude 5h 32% | wk 49% | 2 Augur alerts', class: 'warn' });
    expect(bar.tooltip).toContain('Codex at 90%');
  });

  it('still reports a job by its id', async () => {
    const { run } = await serve();
    expect((await run(['status', 'nosuchjob'])).code).not.toBe(0);
  });

  it('fails plainly when no service answers, and gives a bar an off block without failing it', async () => {
    const { run, dir } = await serve(false);
    rmSync(join(dir, 'token'));
    const plain = await run(['status']);
    expect(plain.code).toBe(4);
    expect(plain.err).toContain('not running');
    const bar = await run(['status', '--waybar']);
    expect(bar.code).toBe(0);
    expect(JSON.parse(bar.out).class).toBe('off');
  });
});

describe('augur refresh, alerts and claude', () => {
  it('refreshes every provider now', async () => {
    const { run, calls } = await serve();
    expect((await run(['refresh'])).code).toBe(0);
    expect(calls).toEqual([['refresh', true]]);
  });

  it('lists alerts, dismisses one by id or all of them, and refuses an id that matches none', async () => {
    const { run, calls } = await serve();
    const list = await run(['alerts']);
    expect(list.out).toContain('Claude at 75%');
    expect((await run(['alerts', 'dismiss', 'a2'])).out.trim()).toBe('Dismissed 1 alert.');
    expect((await run(['alerts', 'dismiss', '--all'])).out.trim()).toBe('Dismissed 2 alerts.');
    expect(calls).toEqual([['dismiss', ['a2']], ['dismiss', ['a1', 'a2']]]);
    const bad = await run(['alerts', 'dismiss', 'zzz']);
    expect(bad.code).toBe(1);
  });

  it('installs and removes the Claude parts, and says where they stand', async () => {
    const { run, calls } = await serve();
    expect((await run(['claude', 'status'])).out).toContain('Claude Code: installed (version 1.4.0)');
    expect((await run(['claude', 'install', 'desktop'])).out.trim()).toBe('Claude Desktop: installed.');
    expect((await run(['claude', 'remove', 'code'])).out.trim()).toBe('Claude Code: removed.');
    expect(calls).toEqual([['setClaude', 'desktop', true], ['setClaude', 'code', false]]);
    expect((await run(['claude', 'install', 'phone'])).code).toBe(1);
  });
});
