import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LedgerJob } from '@augur/dispatch-protocol';
import { DispatchPage, tail } from '../src/screens/dispatch.js';
import { pages } from '../src/index.js';
import { NOW, ch, k, setup, state } from './fixtures.js';

const job = (over: Partial<LedgerJob> = {}): LedgerJob => ({
  id: 'node:0d26110efa99', node: 'node', localId: '0d26110efa99', kind: 'augur-job', state: 'running', route: 'luna', model: null, activity: 'write_code',
  stamp: { sessionId: 's', sessionTitle: 'Review', origin: 'cli', pid: 42 }, attribution: { session: 'stamped', origin: 'stamped', process: 'stamped', host: 'unknown' },
  summary: 'Read notes', summarySource: 'caller', createdAt: NOW - 60000, startedAt: NOW - 30000, endedAt: null, durationMs: null, updatedAt: NOW, lastActivityAt: NOW - 12000,
  parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false, ...over,
});

function dispatch(answers: Record<string, unknown> = {}, runJobs = true, results: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'augur-tui-'));
  const env = { AUGURD_DATA: join(home, 'data'), AUGUR_HOME: join(home, 'home') } as NodeJS.ProcessEnv;
  const page = new DispatchPage({ env, wait: async () => {}, restart: async () => 'Restarted.' });
  const list = pages();
  list[3] = page;
  const s = state();
  s.config.dispatch = { runJobs };
  const t = setup(s, { pages: list, answers: { ledger_list: { jobs: [], next: null }, ledger_counts: { queued: 0, running: 1, stalled: 0, done: 0, failed: 0, canceled: 0, 'node-lost': 0 }, ledger_nodes: [], ledger_changes: { changes: [], cursor: '0', more: false }, ...answers }, results });
  t.app.active = 3;
  const ctx = () => t.app.ctx()!;
  const load = async () => { await page.refresh(ctx()); };
  const routesPath = join(home, 'home', 'dispatch', 'routes.json');
  const writeRoutes = (text: string) => { mkdirSync(join(home, 'home', 'dispatch'), { recursive: true }); writeFileSync(routesPath, text); };
  return { ...t, page, env, home, ctx, load, routesPath, writeRoutes, configPath: join(home, 'data', 'config.json') };
}

describe('dispatch page: jobs', () => {
  it('keeps a reachable node history gap visible on the Jobs page', async () => {
    const t = dispatch({ ledger_nodes: [{ node: 'eru', cursor: '10', lastSeenAt: NOW, unreachableSince: null, gap: { at: NOW, from: '1', to: '10', retentionDays: 7 } }] });
    await t.load();
    const text = t.draw(120, 50);
    expect(text).toContain('eru: History gap since '); expect(text).toContain('eru: Reachable');
    t.page.jobs.nodes[0]!.gap = null;
    expect(t.draw(120, 50)).not.toContain('History gap since');
  });
  it('lists ledger jobs and their state while local execution is disabled', async () => {
    const t = dispatch({ ledger_list: { jobs: [job({ summary: 'luna task' }), job({ id: 'node:failed', state: 'failed', summary: 'sol task' })], next: null } }, false);
    await t.load(); const text = t.draw(120, 50);
    expect(text).toMatch(/Jobs\s+Routes\s+Service/); expect(text).toContain('luna task'); expect(text).toContain('Failed'); expect(t.page.badge()).toBe('1');
    expect(t.calls.some(([method]) => method === 'list' || method === 'result' || method === 'logs')).toBe(false);
  });

  it('switches session scope and forwards terminal filters', async () => {
    const t = dispatch(); await t.load();
    t.page.jobs.session = 's'; t.page.form.focus = 'jobs-scope'; await t.app.key(k('enter'));
    expect(t.page.jobs.scope).toBe('session');
    expect(t.calls).toContainEqual(['ledger_list', [{ session: 's', limit: 50 }]]);
    t.page.jobs.setFilter('state', ['stalled']); await t.page.jobs.refresh({ call: (method, params) => t.link.call(method, params) });
    expect(t.calls).toContainEqual(['ledger_list', [{ state: ['stalled'], session: 's', limit: 50 }]]);
  });

  it('opens metadata, keeps text output out of the detail, and cancels by local id', async () => {
    const j = Object.assign(job(), { answer: 'PRIVATE_ANSWER', prompt: 'PRIVATE_PROMPT' });
    const t = dispatch({ ledger_list: { jobs: [j], next: null }, ledger_get: { job: j, parent: null, children: [], retries: [] }, cancel: { ok: true } });
    await t.load(); t.page.form.focus = 'j:' + j.id; await t.app.key(k('enter')); await t.load();
    const text = t.draw(120, 80); expect(text).toContain('Session attribution: stamped'); expect(text).toContain('Process: 42'); expect(text).not.toContain('PRIVATE_');
    t.page.forms.job.focus = 'job-cancel'; await t.app.key(k('enter')); expect(t.calls).toContainEqual(['cancel', [{ id: j.localId }]]);
    await t.app.key(k('escape')); expect(t.page.jobs.selected).toBeNull();
  });

  it('keeps the last lines of a long log for callers outside the ledger page', () => {
    const lines = Array.from({ length: 100 }, (_, i) => 'l' + i).join('\n');
    expect(tail(lines, 3)).toEqual(['...', 'l97', 'l98', 'l99']); expect(tail('a\nb', 3)).toEqual(['a', 'b']);
  });
});

describe('dispatch page: switching screens', () => {
  it('moves between the screens with ] and [', async () => {
    const t = dispatch();
    await t.app.key(ch(']'));
    expect(t.page.sub).toBe('routes');
    await t.app.key(ch(']'));
    expect(t.page.sub).toBe('service');
    await t.app.key(ch('['));
    expect(t.page.sub).toBe('routes');
  });
});

describe('dispatch page: routes', () => {
  const FILE = JSON.stringify({ routes: { luna: { model: 'codex/luna', adapter: 'codex-exec', options: {} } } });

  it('lists the routes with whether each can run', async () => {
    const t = dispatch({ routes: [{ name: 'luna', model: 'codex/luna', adapter: 'codex-exec', problem: 'No key is saved for it.' }] });
    t.writeRoutes(FILE);
    t.page.sub = 'routes';
    await t.load();
    const text = t.draw(110, 30);
    expect(text).toContain('luna');
    expect(text).toContain('Cannot run');
    expect(text).toContain('No key is saved for it.');
  });

  it('adds a route, refusing a bad model first and writing routes.json when it passes', async () => {
    const t = dispatch({ routes: [] });
    t.page.sub = 'routes';
    await t.load();
    t.page.form.focus = 'route-new';
    t.page.form.cell = 1;
    await t.app.key(k('enter'));
    const d = t.page.routes.draft!;
    d.name = 'sol'; d.model = 'not a model';
    t.page.forms.route.focus = 'rt-actions';
    await t.app.key(k('enter'));
    expect(t.page.routes.formError).toContain('provider/model');
    expect(existsSync(t.routesPath)).toBe(false);
    d.model = 'codex/sol';
    await t.app.key(k('enter'));
    expect(t.page.routes.formError).toBe('');
    expect(JSON.parse(readFileSync(t.routesPath, 'utf8')).routes.sol.model).toBe('codex/sol');
    expect(t.page.routes.note).toBe('Added sol.');
    expect(t.page.routes.sel).toBeNull();
  });

  it('deletes a route only after a second press', async () => {
    const t = dispatch({ routes: [] });
    t.writeRoutes(FILE);
    t.page.sub = 'routes';
    await t.load();
    t.page.form.focus = 'r:luna';
    await t.app.key(k('enter'));
    expect(t.page.routes.sel).toBe('luna');
    t.page.forms.route.focus = 'rt-actions';
    t.page.forms.route.cell = 3;
    await t.app.key(k('enter'));
    expect(t.page.routes.confirmDelete).toBe(true);
    expect(JSON.parse(readFileSync(t.routesPath, 'utf8')).routes.luna).toBeDefined();
    await t.app.key(k('enter'));
    expect(JSON.parse(readFileSync(t.routesPath, 'utf8')).routes.luna).toBeUndefined();
  });

  it('tests a saved route and reports the model answering', async () => {
    const t = dispatch({ submit: { id: 'job1', warnings: [] }, result: { job: { state: 'completed' }, answer: 'ok' } });
    await (t.page as unknown as { testRoute(c: unknown, n: string): Promise<void> }).testRoute(t.ctx(), 'luna');
    expect(t.page.routes.testNote).toBe('luna works. The model answered: ok');
    expect(t.page.routes.testing).toBe(false);
  });
});

describe('dispatch page: add provider', () => {
  const open = async (t: ReturnType<typeof dispatch>) => {
    t.page.sub = 'routes';
    await t.load();
    t.page.form.focus = 'route-new';
    t.page.form.cell = 0;
    await t.app.key(k('enter'));
  };
  const added = { addProvider: { labels: { 'gpt-5': 'openai/gpt-5' }, added: ['openai/gpt-5'] } };
  const TAKEN = '{"routes":{"luna":{"model":"codex/luna","adapter":"codex-exec"}}}';

  it('opens from the Routes screen, shows the plan as the fields are filled, and leaves with Esc', async () => {
    const t = dispatch({ routes: [] });
    await open(t);
    expect(t.page.routes.add).not.toBeNull();
    let text = t.draw(110, 40);
    expect(text).toContain('Add provider');
    expect(text).toContain('Fill in the route name and the model');
    const f = t.page.routes.add!;
    f.route = 'gpt'; f.model = 'gpt-5';
    text = t.draw(110, 50);
    expect(text).toContain('Route: gpt, a chat route to https://api.openai.com/v1');
    expect(text).toContain('Model: gpt-5 under OpenAI');
    await t.app.key(k('escape'));
    expect(t.page.routes.add).toBeNull();
  });

  it('adds the provider: rules entry, route file and key, then reports what to do next', async () => {
    const t = dispatch({ routes: [] }, true, added);
    t.writeRoutes('{"routes":{}}');
    await open(t);
    const f = t.page.routes.add!;
    f.route = 'gpt'; f.model = 'gpt-5'; f.key = 'sk-test';
    t.page.forms.provider.focus = 'ap-actions';
    await t.app.key(k('enter'));
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(readFileSync(t.routesPath, 'utf8')).routes.gpt).toMatchObject({ model: 'openai/gpt-5', adapter: 'openai-api' });
    expect(t.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['addProvider', 'setSecret']));
    expect(t.calls.find((c) => c[0] === 'setSecret')![1]).toEqual(['dispatch.gpt', 'sk-test']);
    expect(t.page.routes.add).toBeNull();
    expect(t.page.routes.note).toContain('Added the route gpt, openai/gpt-5 in the rules, a key for the gpt route.');
    expect(t.page.routes.note).toContain('Open Model rules and confirm openai/gpt-5');
  });

  it('shows the problem and offers no Add button until the plan is valid', async () => {
    const t = dispatch({ routes: [] });
    await open(t);
    const f = t.page.routes.add!;
    f.route = 'gpt';
    const text = t.draw(110, 50);
    expect(text).toContain('--model needs the model id');
    expect(text).not.toMatch(/\[ ?Add provider ?\]/);
  });

  it('refuses a route name that is already in routes.json', async () => {
    const t = dispatch({ routes: [] });
    t.writeRoutes(TAKEN);
    await open(t);
    const f = t.page.routes.add!;
    f.route = 'luna'; f.model = 'gpt-5';
    expect(t.draw(110, 50)).toContain('A route named luna already exists');
  });
});

describe('dispatch page: service', () => {
  it('offers the mode switch, and hides the settings while jobs are off', async () => {
    const t = dispatch({}, false);
    t.page.sub = 'service';
    await t.load();
    const text = t.draw(110, 40);
    expect(text).toContain('Usage only');
    expect(text).not.toContain('Jobs at once');
  });

  it('shows the agent approval level whether or not jobs run', async () => {
    const t = dispatch({}, false);
    t.page.sub = 'service';
    await t.load();
    const text = t.draw(130, 40);
    expect(text).toContain('When an agent asks to change your rules');
    expect(text).toContain('Ask me for risky edits');
    expect(text).toContain('Agents cannot change this setting');
  });

  it('saves a setting to config.json and says to restart', async () => {
    const t = dispatch({ ping: { pid: 4242, version: 1, startedAt: 0 } });
    t.page.sub = 'service';
    await t.load();
    expect(t.draw(110, 60)).toContain('Service running (process 4242).');
    t.page.form.focus = 'cfg:persistPrompts';
    await t.app.key(ch(' '));
    expect(JSON.parse(readFileSync(t.configPath, 'utf8')).persistPrompts).toBe(true);
    expect(t.page.service.note).toContain('Restart the service');
  });

  it('leaves a setting that lowers the checks to be changed by hand', async () => {
    const t = dispatch({ ping: { pid: 1, version: 1, startedAt: 0 } });
    t.page.sub = 'service';
    await t.load();
    const text = t.draw(130, 80);
    expect(text).toContain('Require a pick');
    expect(text).toContain('augur config set');
  });
});


it('shows live activity, elapsed time, stalls, and compacted records', async () => {
  const j = job({ state: 'stalled', activityLine: 'Reading files', compacted: true });
  const t = dispatch({ ledger_list: { jobs: [j], next: null } });
  await t.load(); const text = t.draw(120, 55);
  expect(text).toContain('Stalled'); expect(text).toContain('Reading files'); expect(text).toContain('12s ago'); expect(text).toContain('Compacted'); expect(text).toContain('30s');
});
