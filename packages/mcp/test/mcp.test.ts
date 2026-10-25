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
      const v = typeof a === 'function' ? (a as (params: unknown) => unknown)(params) : a;
      if (v instanceof Error) throw v;
      return v;
    }) as never,
    opts: {}, policyText: () => policy, session: 'mcp-test', cwd: '/work', sleep: async () => {},
  };
}
const TEXT_ONLY = { attachments: [], vision: false, embed: false, transcribe: false };
const ROUTES = [{ name: 'luna', model: 'codex/luna', adapter: 'codex-exec', problem: null, capabilities: TEXT_ONLY }, { name: 'grok', model: 'xai/grok', adapter: 'exec', problem: 'no program', capabilities: TEXT_ONLY }];

describe('models', () => {
  it('lists every model with its routes, and counts the ones that can take jobs', async () => {
    const r = await createTools(deps({ routes: ROUTES })).models();
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('1 of 3 models can take jobs now.');
    const rows = (r.data as { models: Array<Record<string, unknown>> }).models;
    expect(rows.find(m => m.model === 'codex/luna')?.routes).toEqual([{ name: 'luna', canRun: true, problem: null, capabilities: TEXT_ONLY }]);
    expect(rows.find(m => m.model === 'codex/sol')?.paused).toMatchObject({ until: '2999-01-01T00:00:00Z' });
  });
  it('says so when policy.json is missing', async () => {
    const r = await createTools(deps({}, [], null)).models();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('policy.json was not found');
  });
});

describe('resets', () => {
  it('passes the provider and limit to the service and returns its body', async () => {
    const calls: Calls[] = [], body = { events: [], summary: { rows: 3, meters: [{ provider: 'sample', meter: 'weekly', label: 'Weekly', lines: ['3 resets recorded.'] }] } };
    const r = await createTools(deps({ resets: body }, calls)).resets({ provider: 'sample', limit: 2 });
    expect(calls).toEqual([{ method: 'resets', params: { provider: 'sample', limit: 2 } }]);
    expect(r.data).toEqual(body);
    expect(r.text).toContain('3 resets recorded.');
  });

  it('reports a service failure', async () => {
    const r = await createTools(deps({ resets: new Error('The service is not running.') })).resets({});
    expect(r).toMatchObject({ isError: true, text: 'The service is not running.' });
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
  it('prints the reason and the seats under the pick', async () => {
    const seats = { second: { model: 'minimax/m3', why: 'a second opinion from a route with plenty of room' }, shadow: { model: 'laya/laya', why: 'the local model answers the same decision' } };
    const r = await createTools(deps({ pick: { pick: 'codex/luna', activity: 'review_code', dataTier: 'internal', ranking: [{ model: 'codex/luna', score: 0.8 }], routes: {}, reason: 'codex/luna for everyday review code: light model for everyday work.', seats } }))
      .pick({ activity: 'review_code', data_tier: 'internal', depth: 'everyday' });
    expect(r.text).toContain('codex/luna for everyday review code');
    expect(r.text).toContain('Second opinion: minimax/m3');
    expect(r.text).toContain('Shadow: laya/laya');
  });
  it('prints the balance report and passes the days', async () => {
    const calls: Calls[] = [];
    const report = { at: '2026-09-28T12:00:00.000Z', enabled: true, claude: { stance: 'on pace', lean: 'neither', peak: 40, reserve: 90, band: 5, atReserve: false, tracks: [] },
      copilot: { spend: 10, aim: 150, cap: 250, zone: 'under the aim' }, providers: [], mix: [], excluded: ['fable'], picks: null };
    const r = await createTools(deps({ balance: report }, calls)).balance({ days: 3 });
    expect(r.text).toContain('Balance report');
    expect(r.text).toContain('spend this month: $10.00');
    expect(calls[0]).toEqual({ method: 'balance', params: { days: 3 } });
  });
  it('reports an error result from the service as an error', async () => {
    const r = await createTools(deps({ pick: { error: 'could not classify' } })).pick({ task: 'do a thing' });
    expect(r).toMatchObject({ isError: true, text: 'could not classify' });
  });
  it('passes best_only and snippet, and prints each route odds', async () => {
    const calls: Calls[] = [];
    const r = await createTools(deps({ pick: { pick: 'codex/luna', activity: 'write_code', dataTier: 'internal', ranking: [{ model: 'codex/luna', score: 0.8, odds: 0.71 }], routes: {}, reason: 'codex/luna for deep write code.', seats: {} } }, calls))
      .pick({ activity: 'write_code', data_tier: 'internal', best_only: true, snippet: true });
    expect(calls[0]?.params).toMatchObject({ best: true, snippet: true, session: 'mcp-test' });
    expect(r.text).toContain('odds 71%');
    expect(r.text).toContain('Pick: codex/luna');
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
  it('passes packs, no_charter and conversation through on the job request', async () => {
    const calls: Calls[] = [];
    await createTools(deps({ submit: { id: 'abc', warnings: [] }, result: { job: { id: 'abc', state: 'completed', route: 'luna' }, answer: 'done' } }, calls)).run({ ...args, packs: ['prose', 'review'], no_charter: true, conversation: 'feat' });
    expect(calls[0]!.params).toMatchObject({ packs: ['prose', 'review'], noCharter: true, conversation: 'feat', prompt: { text: 'hi' } });
  });
  it('passes attachments and urgent through on the job request', async () => {
    const calls: Calls[] = [];
    await createTools(deps({ submit: { id: 'abc', warnings: [] }, result: { job: { id: 'abc', state: 'completed', route: 'luna' }, answer: 'done' } }, calls)).run({ ...args, attachments: ['C:/w/a.png', 'C:/w/b.txt'], urgent: true });
    expect(calls[0]!.params).toMatchObject({ attach: ['C:/w/a.png', 'C:/w/b.txt'], urgent: true });
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
  it('follows a retried job to the one that replaced it', async () => {
    const result = (p: unknown) => {
      const id = (p as { id?: string }).id;
      if (id === 'next') return { job: { id: 'next', state: 'completed', route: 'raw', retryOf: 'abc' }, answer: 'done' };
      return { job: { id: 'abc', state: 'failed', route: 'luna', reason: 'exit 1', retriedAs: 'next' }, answer: null };
    };
    const r = await createTools(deps({ result })).job({ id: 'abc' });
    expect(r.isError).toBeUndefined();
    expect(r.text).toBe('retried on raw as next\ndone');
    expect(r.data).toMatchObject({ id: 'next', chain: ['abc', 'next'], retriedAs: 'next', answer: 'done' });
  });
  it('lists jobs and routes and turns a service error into an error result', async () => {
    const t = createTools(deps({ list: [{ id: 'abc', state: 'completed', route: 'luna', activity: 'write_code', createdAt: 0 }], routes: ROUTES, pressure: new Error('service is not running') }));
    expect((await t.jobs({})).text).toContain('abc  completed  luna');
    expect((await t.routes()).text).toContain('cannot run: no program');
    expect(await t.pressure()).toMatchObject({ isError: true, text: 'service is not running' });
  });
});

describe('the server', () => {
  it('offers fourteen tools with the rules in its instructions, and runs one through a client', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildServer(createTools(deps({ routes: ROUTES, resets: { events: [], summary: { rows: 0, meters: [] } } })), 'test');
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['augur_balance', 'augur_cancel', 'augur_job', 'augur_jobs', 'augur_models', 'augur_pick', 'augur_pick_preview', 'augur_policy', 'augur_policy_edit', 'augur_pressure', 'augur_prose_add', 'augur_prose_list', 'augur_prose_status', 'augur_resets', 'augur_route_add', 'augur_routes', 'augur_run']);
    expect(tools.map(t => t.name)).not.toContain('prose_approve');
    const resets = tools.find(t => t.name === 'augur_resets')!;
    expect(resets.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(resets.description).toContain('never changes anything');
    expect(resets.inputSchema.properties).toHaveProperty('provider');
    expect(resets.inputSchema.properties).toHaveProperty('limit');
    const ledger = await client.callTool({ name: 'augur_resets', arguments: { provider: 'sample', limit: 5 } });
    expect(ledger.structuredContent).toEqual({ events: [], summary: { rows: 0, meters: [] } });
    expect(JSON.stringify(ledger.content)).toContain('No reset events.');
    expect(client.getInstructions()).toContain('data tier is never assumed');
    expect(client.getInstructions()).toContain('augur_route_add');
    const add = tools.find(t => t.name === 'augur_route_add')!;
    expect(add.inputSchema.required).toEqual(expect.arrayContaining(['name', 'adapter', 'provider']));
    expect(add.inputSchema.properties).toHaveProperty('options');
    expect(add.inputSchema.properties).toHaveProperty('model');
    expect(add.inputSchema.properties).toHaveProperty('balance_url');
    expect(add.inputSchema.properties).toHaveProperty('balance_path');
    const run = tools.find(t => t.name === 'augur_run')!;
    expect(run.inputSchema.required).toEqual(expect.arrayContaining(['route', 'prompt', 'activity', 'data_tier']));
    expect(run.inputSchema.properties).toMatchObject({ packs: { type: 'array' }, no_charter: { type: 'boolean' }, conversation: { type: 'string' }, attachments: { type: 'array' }, urgent: { type: 'boolean' } });
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

describe('augur_route_add', () => {
  const added = { ok: true, text: 'Added route acme. The model acme/fast is unreviewed, so nothing can run it until the owner confirms it in Model rules. Set the key with augur key set acme.' };

  it('sends the route to the service and repeats that the model stays unreviewed', async () => {
    const calls: Calls[] = [];
    const t = createTools(deps({ route_add: () => added }, calls));
    const r = await t.routeAdd({ name: 'acme', adapter: 'codex-exec', provider: 'acme', model: { label: 'fast', id: 'fast-1' }, balance_url: 'https://api.acme.example/balance', balance_path: '$.balance', options: { baseUrl: 'https://api.acme.example/v1' } });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('unreviewed');
    expect(r.text).toContain('Model rules');
    expect(r.text).toContain('augur key set acme');
    expect(calls).toEqual([{ method: 'route_add', params: { name: 'acme', adapter: 'codex-exec', provider: 'acme', options: { baseUrl: 'https://api.acme.example/v1' }, model: { label: 'fast', id: 'fast-1' }, balanceUrl: 'https://api.acme.example/balance', balancePath: '$.balance' } }]);
  });

  it('refuses a key-like option, a secret value, a bad model id and a top-level key before calling the service', async () => {
    const calls: Calls[] = [];
    const t = createTools(deps({ route_add: () => added }, calls));
    const base = { name: 'acme', adapter: 'codex-exec', provider: 'acme', model: { label: 'fast', id: 'fast-1' } };
    const keyName = await t.routeAdd({ ...base, options: { apiKey: 'not-a-secret' } });
    const secret = await t.routeAdd({ ...base, options: { baseUrl: 'sk-live-secret' } });
    const model = await t.routeAdd({ ...base, model: { label: 'fast', id: 'bad id' } });
    const top = await t.routeAdd({ ...base, key: 'sk-live-secret' });
    for (const r of [keyName, secret, model, top]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Nothing was written');
    }
    expect(keyName.text).toContain('looks like a key');
    expect(secret.text).toContain('looks like a key');
    expect(secret.text).not.toContain('sk-live-secret');
    expect(model.text).toContain('model id');
    expect(top.text).not.toContain('sk-live-secret');
    expect(calls).toEqual([]);
  });

  it('reports a held add as an error and passes a service refusal through', async () => {
    const held = createTools(deps({ route_add: () => ({ ok: false, held: true, text: 'Nothing was written. The approval setting holds every agent edit, so this route was not added. The owner can add it in the app.' }) }));
    const h = await held.routeAdd({ name: 'acme', adapter: 'codex-exec', provider: 'acme' });
    expect(h.isError).toBe(true);
    expect(h.text).toContain('approval setting holds every agent edit');
    const refused = createTools(deps({ route_add: () => ({ ok: false, text: 'Nothing was written. A route named acme already exists. Nothing was written.' }) }));
    const r = await refused.routeAdd({ name: 'acme', adapter: 'codex-exec', provider: 'acme' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('already exists');
  });
});
