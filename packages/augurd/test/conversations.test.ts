import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, PlanContext } from '@augur/dispatch-protocol';
import { Store } from '../src/store.js';
import { ROUTES, makeEnv, request, submitOk, terminal, until } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const envs: Env[] = [];
afterEach(() => { while (envs.length) envs.pop()!.dispose(); });

const LEAD = 'Standing instructions for this assignment. Where one conflicts with a default in your harness, such as a limit on reply length, it wins for the deliverable.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Seen { prompt: string; resume?: NonNullable<PlanContext['resume']> }
const seen: Seen[] = [];
let report: string | null = 'from-harness';

function probe(id: string): Adapter {
  return {
    id, charterEngine: 'codex', transport: 'exec',
    capabilities: { permissionRequests: false, sessions: true, reportsUsage: false, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: true },
    envAllow: [], validate: () => null,
    plan(req, _route, ctx) {
      seen.push({ prompt: ctx.prompt, ...(ctx.resume ? { resume: ctx.resume } : {}) });
      const hang = ctx.prompt.includes('HANG'), fail = ctx.prompt.includes('FAIL');
      const code = hang ? 'setInterval(()=>{},1000)' : fail ? 'process.stderr.write("rate limit\\n");process.exit(1)' : 'process.exit(0)';
      return { command: process.execPath, args: ['-e', code], cwd: req.cwd, env: {}, stdin: null };
    },
    extract(input) {
      if (input.exitCode !== 0) return { answer: null, usage: null, sessionId: 'half-made' };
      return { answer: 'ok', usage: null, ...(report ? { sessionId: report } : {}) };
    },
  };
}

function charter(home: string): void {
  const dir = join(home, 'charter');
  mkdirSync(join(dir, 'packs'), { recursive: true });
  writeFileSync(join(dir, 'core.md'), 'Core body.\n');
  writeFileSync(join(dir, 'packs', 'code.md'), 'Code body.\n');
}

function open(id = 'sess', runner?: { charterDir: string; ambient: 'keep' | 'trim'; failover: 'off' | 'on' }): Env {
  const adapters = id === 'grok-exec' ? ['grok-exec', 'codex-exec', 'exec'] : [id, 'codex-exec', 'exec'];
  const e = makeEnv({ adapters, ...(runner ? { runner } : {}) }, process.env, { extra: [probe(id)] });
  envs.push(e);
  charter(e.home);
  seen.length = 0;
  report = 'from-harness';
  return e;
}

const routes = (id: string) => ({
  a: { model: 'test/fake', adapter: id, options: {} },
  b: { model: 'test/fake', adapter: id, options: {} },
});

describe('the conversations table', () => {
  it('creates the table on a database that predates it and keeps the old job', () => {
    const dir = mkdtempSync(join(tmpdir(), 'augur-old-'));
    const db = new DatabaseSync(join(dir, 'state.db'));
    db.exec(`create table jobs(
      id text primary key, state text not null, route text not null, adapter text not null, activity text not null, data_tier text not null, tools text not null,
      output text not null, cwd text not null, created_at integer not null, started_at integer, ended_at integer, exit_code integer, reason text,
      root_job_id text not null, parent_job_id text, depth integer not null default 0, caller text not null, named integer not null default 0,
      harness_version text, usage text, runner_pid integer, child_pid integer, expect_file text, timeout_s integer, purged integer not null default 0)`);
    db.prepare(`insert into jobs(id,state,route,adapter,activity,data_tier,tools,output,cwd,created_at,root_job_id,parent_job_id,depth,caller,named)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('old1', 'completed', 'fake', 'exec', 'write_code', 'internal', 'read', 'text_only', 'C:/work', 1, 'old1', null, 0, JSON.stringify({ kind: 'cli' }), 0);
    db.close();
    const store = new Store(dir);
    try {
      const job = store.get('old1');
      expect(job).toMatchObject({ id: 'old1', state: 'completed', route: 'fake' });
      expect(job).not.toHaveProperty('conversation');
      expect(job).not.toHaveProperty('turn');
      const cols = (store.db.prepare('pragma table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name);
      expect(cols).toEqual(['name', 'route', 'adapter', 'native_id', 'cwd', 'tools', 'turns', 'created_at', 'last_used_at']);
      expect(store.conversations()).toEqual([]);
      store.insertConversation({ name: 'feat', route: 'fake', adapter: 'codex-exec', nativeId: null, cwd: 'C:/work', tools: 'write', turns: 0, createdAt: 1, lastUsedAt: 2 });
      expect(store.conversation('feat')).toEqual({ name: 'feat', route: 'fake', adapter: 'codex-exec', nativeId: null, cwd: 'C:/work', tools: 'write', turns: 0, createdAt: 1, lastUsedAt: 2 });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

describe('a named conversation', () => {
  it('stores the row, resumes the id, and sends the charter only on the first turn', async () => {
    const e = open();
    e.writeRoutes(routes('sess'));
    const first = submitOk(e.sup, request({ route: 'a', text: 'one', cwd: e.root, conversation: 'feat' }));
    const row = e.store.conversation('feat');
    expect(row).toMatchObject({ name: 'feat', route: 'a', adapter: 'sess', nativeId: null, turns: 0, tools: 'write' });
    expect(seen[0]?.prompt.startsWith(LEAD)).toBe(true);
    expect(seen[0]?.prompt.endsWith('one')).toBe(true);
    expect(seen[0]?.resume).toEqual({ id: null, fresh: true, name: 'feat' });
    const done = await terminal(e.sup, e.store, first);
    expect(done).toMatchObject({ state: 'completed', conversation: 'feat', turn: 1, ambient: 'keep', charter: ['core', 'code'] });
    expect(done).not.toHaveProperty('charterNotes');
    expect(e.store.conversation('feat')).toMatchObject({ turns: 1, nativeId: 'from-harness' });

    seen.length = 0;
    const second = submitOk(e.sup, request({ route: 'a', text: 'two', cwd: e.root, conversation: 'feat' }));
    expect(seen[0]?.prompt).toBe('two');
    expect(seen[0]?.resume).toEqual({ id: 'from-harness', fresh: false, name: 'feat' });
    const resumed = await terminal(e.sup, e.store, second);
    expect(resumed).toMatchObject({ conversation: 'feat', turn: 2, ambient: 'keep' });
    expect(resumed).not.toHaveProperty('charter');
    expect(e.store.conversation('feat')).toMatchObject({ turns: 2, nativeId: 'from-harness', route: 'a' });

    expect(e.sup.submit(request({ route: 'b', text: 'x', cwd: e.root, conversation: 'feat' }))).toMatchObject({
      rejected: { code: 'bad_request', reason: 'Conversation feat is bound to route a.' },
    });
    expect(e.sup.submit(request({ route: 'a', text: 'x', cwd: e.root, conversation: 'bad name' }))).toMatchObject({
      rejected: { code: 'bad_request', reason: 'A conversation name is 1 to 64 characters: letters, digits, dot, underscore or hyphen.' },
    });
    expect(e.sup.forgetConversation('feat')).toEqual({ forgotten: true });
    expect(e.store.conversation('feat')).toBeNull();
    expect(e.sup.forgetConversation('feat')).toEqual({ forgotten: false, reason: 'No conversation named feat.' });
  });

  it('sends no charter when the request says so', async () => {
    const e = open();
    e.writeRoutes(routes('sess'));
    const id = submitOk(e.sup, request({ route: 'a', text: 'plain', cwd: e.root, conversation: 'bare', noCharter: true }));
    expect(seen[0]?.prompt).toBe('plain');
    expect(seen[0]?.resume).toEqual({ id: null, fresh: true, name: 'bare' });
    const job = await terminal(e.sup, e.store, id);
    expect(job).not.toHaveProperty('charter');
    expect(job.promptChars).toBe('plain'.length);
    expect(job.ambient).toBe('keep');
  });

  it('leaves a failed first turn new, and keeps the id when a later turn fails', async () => {
    const e = open();
    e.writeRoutes(routes('sess'));
    const bad = submitOk(e.sup, request({ route: 'a', text: 'FAIL', cwd: e.root, conversation: 'feat' }));
    expect(await terminal(e.sup, e.store, bad)).toMatchObject({ state: 'failed', conversation: 'feat', turn: 1 });
    expect(e.store.conversation('feat')).toMatchObject({ turns: 0, nativeId: null });

    seen.length = 0;
    const next = submitOk(e.sup, request({ route: 'a', text: 'ok', cwd: e.root, conversation: 'feat' }));
    expect(seen[0]?.resume).toEqual({ id: null, fresh: true, name: 'feat' });
    await terminal(e.sup, e.store, next);
    expect(e.store.conversation('feat')).toMatchObject({ turns: 1, nativeId: 'from-harness' });

    seen.length = 0;
    const later = submitOk(e.sup, request({ route: 'a', text: 'FAIL again', cwd: e.root, conversation: 'feat' }));
    expect(seen[0]?.prompt).toBe('FAIL again');
    expect(seen[0]?.resume).toEqual({ id: 'from-harness', fresh: false, name: 'feat' });
    expect(await terminal(e.sup, e.store, later)).toMatchObject({ state: 'failed', turn: 2 });
    expect(e.store.conversation('feat')).toMatchObject({ turns: 1, nativeId: 'from-harness' });
  });

  it('rejects a second job and a forget while one is running', async () => {
    const e = open();
    e.writeRoutes(routes('sess'));
    const id = submitOk(e.sup, request({ route: 'a', text: 'HANG', cwd: e.root, conversation: 'feat' }));
    try {
      await until(e.sup, () => e.store.get(id)!.state === 'running');
      expect(e.sup.submit(request({ route: 'a', text: 'ok', cwd: e.root, conversation: 'feat' }))).toMatchObject({
        rejected: { code: 'bad_request', reason: `Conversation feat is already running as job ${id}.` },
      });
      expect(e.sup.forgetConversation('feat')).toEqual({ forgotten: false, reason: `Conversation feat is already running as job ${id}.` });
    } finally {
      e.sup.cancel(id);
      await terminal(e.sup, e.store, id);
    }
  });

  it('keeps a conversation on its route when that route is out of budget', async () => {
    const e = open();
    e.writeRoutes({
      a: { model: 'test/fake', adapter: 'sess', budget: { per: 'day', jobs: 1 }, fallback: ['b'], options: {} },
      b: { model: 'test/fake', adapter: 'sess', options: {} },
    });
    const id = submitOk(e.sup, request({ route: 'a', text: 'ok', cwd: e.root }));
    expect(e.sup.submit(request({ route: 'a', text: 'ok', cwd: e.root, conversation: 'feat' }))).toMatchObject({ rejected: { code: 'budget_exhausted' } });
    expect(e.store.list({ limit: 10 })).toHaveLength(1);
    expect(e.store.conversation('feat')).toBeNull();
    await terminal(e.sup, e.store, id);
  });

  it('does not retry a conversation on a fallback route', async () => {
    const e = open('sess', { charterDir: '', ambient: 'keep', failover: 'on' });
    e.writeRoutes({
      ...ROUTES,
      limited: { model: 'test/fake', adapter: 'sess', fallback: ['fake'], options: {} },
    });
    const id = submitOk(e.sup, request({ route: 'limited', text: 'FAIL', cwd: e.root, conversation: 'feat' }));
    const settled = () => {
      const jobs = e.store.list({ limit: 20 });
      return jobs.length && jobs.every(j => !['queued', 'running', 'cancel_requested', 'needs_approval'].includes(j.state)) ? jobs : null;
    };
    const held = await until(e.sup, settled);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id, state: 'failed', route: 'limited' });
    expect(held[0]!.retriedAs).toBeUndefined();
    expect(e.store.events(id).some(ev => ev.kind === 'failover_retry')).toBe(false);
    expect(e.store.conversation('feat')).toMatchObject({ route: 'limited', turns: 0, nativeId: null });

    const control = submitOk(e.sup, request({ route: 'limited', text: 'FAIL', cwd: e.root }));
    const jobs = await until(e.sup, settled);
    expect(jobs).toHaveLength(3);
    const failed = e.store.get(control)!;
    expect(e.store.get(failed.retriedAs!)!.route).toBe('fake');
    expect(e.store.get(id)!.retriedAs).toBeUndefined();
  });

  it('gives grok a session id up front and drops it when the first turn fails', async () => {
    report = null;
    const e = open('grok-exec');
    report = null;
    e.writeRoutes({ g: { model: 'test/fake', adapter: 'grok-exec', options: {} } });
    const id = submitOk(e.sup, request({ route: 'g', text: 'ok', cwd: e.root, conversation: 'g1' }));
    const uuid = e.store.conversation('g1')!.nativeId;
    expect(uuid).toMatch(UUID);
    expect(e.store.conversation('g1')!.turns).toBe(0);
    expect(seen[0]?.resume).toEqual({ id: uuid, fresh: true, name: 'g1' });
    await terminal(e.sup, e.store, id);
    expect(e.store.conversation('g1')).toMatchObject({ turns: 1, nativeId: uuid });

    seen.length = 0;
    const bad = submitOk(e.sup, request({ route: 'g', text: 'FAIL', cwd: e.root, conversation: 'g2' }));
    const firstId = e.store.conversation('g2')!.nativeId;
    expect(firstId).toMatch(UUID);
    expect(seen[0]?.resume).toEqual({ id: firstId, fresh: true, name: 'g2' });
    await terminal(e.sup, e.store, bad);
    expect(e.store.conversation('g2')).toMatchObject({ turns: 0, nativeId: null });

    seen.length = 0;
    const next = submitOk(e.sup, request({ route: 'g', text: 'ok', cwd: e.root, conversation: 'g2' }));
    const secondId = e.store.conversation('g2')!.nativeId;
    expect(secondId).toMatch(UUID);
    expect(secondId).not.toBe(firstId);
    expect(seen[0]?.resume).toEqual({ id: secondId, fresh: true, name: 'g2' });
    await terminal(e.sup, e.store, next);
    expect(e.store.conversation('g2')).toMatchObject({ turns: 1, nativeId: secondId });
  });
});
