import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServiceError } from '@augur/augurd';
import type { JobRecord } from '@augur/dispatch-protocol';
import { DispatchPage, tail } from '../src/screens/dispatch.js';
import { pages } from '../src/index.js';
import { NOW, ch, k, setup, state } from './fixtures.js';

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: '0d26110efa99', state: 'running', route: 'luna', adapter: 'codex-exec', activity: 'write_code', dataTier: 'internal', tools: 'read', output: 'text_only',
  cwd: 'C:/work', createdAt: NOW - 60_000, startedAt: NOW - 30_000, endedAt: null, exitCode: null, reason: null, rootJobId: '0d26110efa99', parentJobId: null, depth: 0,
  caller: { kind: 'cli', label: 'claude' }, named: false, harnessVersion: null, usage: null, workspace: null, patch: null, ...over,
});

function dispatch(answers: Record<string, unknown> = {}, runJobs = true) {
  const home = mkdtempSync(join(tmpdir(), 'augur-tui-'));
  const env = { AUGURD_DATA: join(home, 'data'), AUGUR_HOME: join(home, 'home') } as NodeJS.ProcessEnv;
  const page = new DispatchPage({ env, wait: async () => {}, restart: async () => 'Restarted.' });
  const list = pages();
  list[3] = page;
  const s = state();
  s.config.dispatch = { runJobs };
  const t = setup(s, { pages: list, answers });
  t.app.active = 3;
  const ctx = () => t.app.ctx()!;
  const load = async () => { await page.refresh(ctx()); };
  const routesPath = join(home, 'home', 'dispatch', 'routes.json');
  const writeRoutes = (text: string) => { mkdirSync(join(home, 'home', 'dispatch'), { recursive: true }); writeFileSync(routesPath, text); };
  return { ...t, page, env, home, ctx, load, routesPath, writeRoutes, configPath: join(home, 'data', 'config.json') };
}

describe('dispatch page: jobs', () => {
  it('lists the jobs agents started, with their state', async () => {
    const t = dispatch({ list: [job(), job({ id: 'aaaaaaaaaaaa', state: 'failed', route: 'sol' })] });
    await t.load();
    const text = t.draw(100, 30);
    expect(text).toMatch(/Jobs\s+Routes\s+Service/);
    expect(text).toMatch(/luna.*Running/);
    expect(text).toMatch(/sol.*Failed/);
    expect(t.page.badge()).toBe('1');
  });

  it('says so when the service is set to usage only', async () => {
    const t = dispatch({ list: () => { throw new ServiceError('jobs_off', 'Augur is set to usage only.'); } });
    await t.load();
    expect(t.draw(100, 30)).toContain('usage only');
  });

  it('opens a job to show its result and output, and cancels a running one', async () => {
    const t = dispatch({ list: [job()], result: { job: job(), answer: 'all good' }, logs: { text: 'line one\nline two', next: 0, done: false }, cancel: { ok: true, state: 'cancel_requested' } });
    await t.load();
    t.page.form.focus = 'j:0d26110efa99';
    await t.app.key(k('enter'));
    await t.load();
    const text = t.draw(100, 50);
    expect(text).toContain('all good');
    expect(text).toContain('line two');
    expect(text).toContain('Cancel job');
    t.page.forms.job.focus = 'job-actions';
    await t.app.key(k('enter'));
    expect(t.calls).toContainEqual(['cancel', [{ id: '0d26110efa99' }]]);
    await t.app.key(k('escape'));
    expect(t.page.jobs.sel).toBeNull();
  });

  it('keeps the last lines of a long log', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n');
    expect(tail(lines, 3)).toEqual(['...', 'l97', 'l98', 'l99']);
    expect(tail('a\nb', 3)).toEqual(['a', 'b']);
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
    const t = dispatch({ submit: { id: 'job1', warnings: [] }, result: { job: job({ state: 'completed' }), answer: 'ok' } });
    await (t.page as unknown as { testRoute(c: unknown, n: string): Promise<void> }).testRoute(t.ctx(), 'luna');
    expect(t.page.routes.testNote).toBe('luna works. The model answered: ok');
    expect(t.page.routes.testing).toBe(false);
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
