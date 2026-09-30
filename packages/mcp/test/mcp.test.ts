import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { createTools } from '../src/tools.js';
import type { McpDeps } from '../src/tools.js';

const POLICY = JSON.stringify({ providers: { codex: { models: {
  'codex/luna': { status: 'confirmed', cost: 'cheap', dataTier: 'internal', activities: ['write_code'] },
  'codex/sol': { status: 'confirmed', cost: 'high', dataTier: 'private', askFirst: true, pause: { until: '2999-01-01T00:00:00Z' } },
  'xai/grok': { status: 'unconfirmed', cost: 'moderate', dataTier: 'public' },
} } } });

interface Calls { method: string; params: unknown }
function deps(answers: Record<string, unknown | (() => unknown)>, calls: Calls[] = [], policy: string | null = POLICY): McpDeps {
  return {
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params });
      const a = answers[method];
      const v = typeof a === 'function' ? (a as () => unknown)() : a;
      if (v instanceof Error) throw v;
      return v;
    }) as never,
    opts: {}, policyText: () => policy, session: 'mcp-test', cwd: '/work', sleep: async () => {},
  };
}
const ROUTES = [{ name: 'luna', model: 'codex/luna', adapter: 'codex-exec', problem: null }, { name: 'grok', model: 'xai/grok', adapter: 'exec', problem: 'no program' }];

describe('models', () => {
  it('lists every model with its routes, and counts the ones that can take jobs', async () => {
    const r = await createTools(deps({ routes: ROUTES })).models();
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('1 of 3 models can take jobs now.');
    const rows = (r.data as { models: Array<Record<string, unknown>> }).models;
    expect(rows.find(m => m.model === 'codex/luna')?.routes).toEqual([{ name: 'luna', canRun: true, problem: null }]);
    expect(rows.find(m => m.model === 'codex/sol')?.paused).toMatchObject({ until: '2999-01-01T00:00:00Z' });
  });
  it('says so when policy.json is missing', async () => {
    const r = await createTools(deps({}, [], null)).models();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('policy.json was not found');
  });
});

describe('pick', () => {
  it('needs a task or both an activity and a data tier', async () => {
    const t = createTools(deps({}));
    expect((await t.pick({ activity: 'write_code' })).isError).toBe(true);
    expect((await t.pick({ activity: 'nonsense', data_tier: 'public' })).text).toContain('not an activity');
  });
  it('sends the session so the run that follows is matched to the pick', async () => {
    const calls: Calls[] = [];
    const r = await createTools(deps({ pick: { pick: 'codex/luna', activity: 'write_code', dataTier: 'internal', ranking: [{ model: 'codex/luna', score: 0.8 }], routes: { 'codex/luna': ['luna'] } } }, calls))
      .pick({ activity: 'write_code', data_tier: 'internal' });
    expect(r.text).toContain('Pick: codex/luna');
    expect(calls[0]).toEqual({ method: 'pick', params: { activity: 'write_code', dataTier: 'internal', session: 'mcp-test' } });
  });
  it('reports an error result from the service as an error', async () => {
    const r = await createTools(deps({ pick: { error: 'could not classify' } })).pick({ task: 'do a thing' });
    expect(r).toMatchObject({ isError: true, text: 'could not classify' });
  });
});

describe('run', () => {
  const args = { route: 'luna', prompt: 'hi', activity: 'write_code', data_tier: 'internal' };
  it('never assumes a data tier or an activity', async () => {
    const calls: Calls[] = [];
    const t = createTools(deps({}, calls));
    expect((await t.run({ ...args, data_tier: 'secretish' })).isError).toBe(true);
    expect((await t.run({ ...args, activity: 'bogus' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('submits as an mcp caller with read tools and text output by default', async () => {
    const calls: Calls[] = [];
    await createTools(deps({ submit: { id: 'abc', warnings: [] }, result: { job: { id: 'abc', state: 'completed', route: 'luna' }, answer: 'done' } }, calls)).run(args);
    expect(calls[0]!.method).toBe('submit');
    expect(calls[0]!.params).toMatchObject({ route: 'luna', tools: 'read', output: 'text_only', cwd: '/work', caller: { kind: 'mcp', session: 'mcp-test' }, prompt: { text: 'hi' } });
  });
  it('passes the rules refusal back with its code and reason', async () => {
    const r = await createTools(deps({ submit: { rejected: { code: 'not_picked', reason: 'codex/luna was not picked for this session' } } })).run(args);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Rejected (not_picked): codex/luna was not picked for this session');
  });
  it('returns the answer once the job completes', async () => {
    let n = 0;
    const r = await createTools(deps({ submit: { id: 'abc', warnings: ['w1'] }, result: () => ({ job: { id: 'abc', state: ++n < 3 ? 'running' : 'completed' }, answer: 'the answer' }) })).run(args);
    expect(r.isError).toBeUndefined();
    expect(r.text).toBe('Warnings: w1\nthe answer');
  });
  it('flags a job that ended badly', async () => {
    const r = await createTools(deps({ submit: { id: 'abc', warnings: [] }, result: { job: { id: 'abc', state: 'failed', reason: 'exit 2' }, answer: null } })).run(args);
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('ended as failed. exit 2');
  });
  it('hands back the id when the wait runs out', async () => {
    const r = await createTools(deps({ submit: { id: 'abc', warnings: [] }, result: { job: { id: 'abc', state: 'running' }, answer: null } })).run({ ...args, wait_s: 0 });
    expect(r.text).toContain('Job abc is still running');
    expect(r.isError).toBeUndefined();
  });
});

describe('job, jobs, cancel, pressure, routes', () => {
  it('reports a missing job', async () => {
    const t = createTools(deps({ result: null, cancel: null }));
    expect((await t.job({ id: 'nope' })).text).toBe('No such job.');
    expect((await t.cancel({ id: 'nope' })).isError).toBe(true);
  });
  it('lists jobs and routes and turns a service error into an error result', async () => {
    const t = createTools(deps({ list: [{ id: 'abc', state: 'completed', route: 'luna', activity: 'write_code', createdAt: 0 }], routes: ROUTES, pressure: new Error('service is not running') }));
    expect((await t.jobs({})).text).toContain('abc  completed  luna');
    expect((await t.routes()).text).toContain('cannot run: no program');
    expect(await t.pressure()).toMatchObject({ isError: true, text: 'service is not running' });
  });
});

describe('the server', () => {
  it('offers eight tools with the rules in its instructions, and runs one through a client', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildServer(createTools(deps({ routes: ROUTES })), 'test');
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['augur_cancel', 'augur_job', 'augur_jobs', 'augur_models', 'augur_pick', 'augur_pressure', 'augur_routes', 'augur_run']);
    expect(client.getInstructions()).toContain('data tier is never assumed');
    const run = tools.find(t => t.name === 'augur_run')!;
    expect(run.inputSchema.required).toEqual(expect.arrayContaining(['route', 'prompt', 'activity', 'data_tier']));
    const res = await client.callTool({ name: 'augur_routes', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('cannot run: no program');
    expect((res.structuredContent as { routes: unknown[] }).routes).toHaveLength(2);
    await client.close();
  });
  it('refuses a run with an unknown data tier before it reaches the service', async () => {
    const calls: Calls[] = [];
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildServer(createTools(deps({}, calls)), 'test');
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: 'augur_run', arguments: { route: 'luna', prompt: 'x', activity: 'write_code', data_tier: 'bogus' } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await client.close();
  });
});
