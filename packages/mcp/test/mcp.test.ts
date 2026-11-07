import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { REPLAY_TEXT, createTools } from '../src/tools.js';
import type { McpDeps } from '../src/tools.js';
import type { LedgerJob } from '@augur/dispatch-protocol';
import { readFleet } from '@augur/core';

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
const ledgerJob = (over: Partial<LedgerJob> = {}): LedgerJob => ({ id: 'node:abc', node: 'node', localId: 'abc', kind: 'llm-request', state: 'done', stamp: { sessionId: 'mcp-test' }, attribution: { session: 'stamped', origin: 'unknown', process: 'unknown', host: 'unknown' }, summary: 'Read notes', summarySource: 'caller', route: 'luna', model: null, activity: 'research', createdAt: 0, startedAt: 0, endedAt: 1000, durationMs: 1000, updatedAt: 1000, lastActivityAt: 0, parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false, ...over });
const ROUTES = [{ name: 'luna', model: 'codex/luna', adapter: 'codex-exec', problem: null, capabilities: TEXT_ONLY }, { name: 'grok', model: 'xai/grok', adapter: 'exec', problem: 'no program', capabilities: TEXT_ONLY }];

describe('run attribution', () => {
  it('stamps the tool origin and passes through the host session and caller summary', async () => {
    const calls: Calls[] = [], d = deps({ submit: { id: 'job', warnings: [] } }, calls);
    d.stamp = { sessionId: 'host-session', sessionTitle: 'Review', summary: 'Read notes', origin: 'other' };
    await createTools(d).run({ route: 'luna', prompt: 'private', activity: 'research', data_tier: 'public', wait_s: 0 });
    expect(calls.find(c => c.method === 'submit')?.params).toMatchObject({ stamp: { sessionId: 'host-session', sessionTitle: 'Review', summary: 'Read notes', origin: 'mcp', originLabel: 'augur-mcp' } });
  });
});

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

  it('shows live uses, chains, and owner offers without writing or accepting anything', async () => {
    const calls: Calls[] = [];
    const d = deps({ routes: [{ ...ROUTES[0], name: 'judge', model: 'cogitator/judge' }] }, calls, JSON.stringify({ providers: { cogitator: { models: { 'cogitator/judge': { id: 'judge', status: 'confirmed', activities: {} }, 'cogitator/describe': { id: 'describe', status: 'unreviewed' } } } } }));
    const fetchedAt = '2026-10-29T12:00:00Z';
    d.usageText = () => JSON.stringify({ providers: { cogitator: { fetchedAt, stale: true, notes: { fleet: readFleet({ self: { name: 'eru', ledger: { models: [{ id: 'laya', uses: ['live tagging'], strengths: 'Live strength.', limits: 'Live limit.' }] }, roles: [{ name: 'judge', chain: ['laya'], uses: ['live judgment'] }, { name: 'describe', chain: ['laya'] }] } }) } } } });
    const result = await createTools(d).models();
    expect(result.text).toContain('live tagging'); expect(result.text).toContain('live judgment');
    expect(result.text).toContain('chain: laya'); expect(result.text).toContain('(stale)');
    expect(result.text).toContain('augur models accept laya');
    const data = result.data as { models: Array<{ model: string; uses: string[] }>; cogitator: unknown[]; offers: Array<{ id: string; missingModel: boolean; missingRoute: boolean }> };
    expect(data.models.find(entry => entry.model === 'cogitator/judge')?.uses).toEqual(['live judgment']);
    expect(data.offers.map(offer => offer.id)).toEqual(['laya', 'describe']);
    expect(data.offers.find(offer => offer.id === 'describe')).toMatchObject({ missingModel: false, missingRoute: true });
    expect(calls).toEqual([{ method: 'routes', params: undefined }]);
  });

  it('lists a fleet before any rules exist and leaves unknown uses unspecified', async () => {
    const d = deps({ routes: [] }, [], null);
    d.usageText = () => JSON.stringify({ providers: { cogitator: { fetchedAt: '2026-10-29T12:00:00Z', notes: { fleet: readFleet({ self: { ledger: { models: [{ id: 'unknown' }] } } }) } } } });
    const result = await createTools(d).models();
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('uses unknown');
    expect(result.data?.offers).toHaveLength(1);
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

describe('gate and backlog output', () => {
  it('includes the last approval in gate status and item fields in backlog list', async () => {
    const approved = '2026-10-01T12:00:00Z';
    const gate = await createTools(deps({ gate_status: { providers: [{ provider: 'claude', state: 'open', gap: 3, window: 'window open', labels: ['claude/opus'], lastApproval: approved }] } })).gateStatus();
    expect(gate.text).toContain(`approved ${approved}`);
    const waiting = await createTools(deps({ gate_status: { providers: [], backlog: { awaiting: [{ id: 'a', task: 't', route: 'claude/opus', estimate: 1, requester: 'r', deadline: null }], queued: 0, running: 0 } } })).gateStatus();
    expect(waiting.text).toContain('1 premium task waits for the owner');
    const row = { id: 'item', author: 'agent', status: 'awaiting-approval', route: 'claude/opus', task: 'write', activity: 'write_code', requester: 'agent-7', repo: 'augur', data: 'internal', tools: 'write', output: 'patch_only', cwd: '/work/repo', prompt: { text: 'prompt' }, estimate: 2, deadline: approved };
    const list = await createTools(deps({ backlog_list: [row] })).backlogList({});
    expect(list.text).toContain('data=internal tools=write output=patch_only');
    expect(list.text).toContain('prompt=inline 6 chars');
    expect(list.text).toContain('activity=write_code requester=agent-7 repo=augur');
    expect((list.data as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ id: 'item', route: 'claude/opus', promptSource: { inlineLength: 6 }, data: 'internal', tools: 'write', output: 'patch_only', cwd: '/work/repo', estimate: 2, deadline: approved, author: 'agent' });
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
    expect(calls[0]).toEqual({ method: 'pick', params: { caller: 'interactive', activity: 'write_code', dataTier: 'internal', session: 'mcp-test' } });
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
  it('refuses a model without a role, so an agent cannot name a model in a plain pick', async () => {
    const calls: Calls[] = [];
    const r = await createTools(deps({ pick: { pick: 'codex/luna', activity: 'write_code', dataTier: 'internal', ranking: [], routes: {} } }, calls)).pick({ activity: 'write_code', data_tier: 'internal', model: 'codex/luna' });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('needs role too');
    expect(calls).toEqual([]);
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
  it('sends per-call effort and schema to the service', async () => {
    const calls: Calls[] = [], schema = { type: 'object' };
    await createTools(deps({ submit: { id: 'abc', warnings: [] } }, calls)).run({ route: 'luna', prompt: 'hi', activity: 'write_code', data_tier: 'internal', effort: 'high', schema, wait_s: 0 });
    expect(calls[0]!.params).toMatchObject({ effort: 'high', schema });
  });

  it('refuses invalid per-call effort or schema without calling the service', async () => {
    const calls: Calls[] = [], tools = createTools(deps({}, calls));
    for (const options of [{ effort: 'high;exit' }, { schema: [] }, { schema: { description: 'x'.repeat(65536) } }]) {
      const result = await tools.run({ route: 'luna', prompt: 'hi', activity: 'write_code', data_tier: 'internal', ...options } as never);
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  const args = { route: 'luna', prompt: 'hi', activity: 'write_code', data_tier: 'internal' };
  it('never assumes a data tier or an activity', async () => {
    const calls: Calls[] = [];
    const t = createTools(deps({}, calls));
    expect((await t.run({ ...args, data_tier: 'secretish' })).isError).toBe(true);
    expect((await t.run({ ...args, activity: 'bogus' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('rejects a released flag before submitting a job', async () => {
    const calls: Calls[] = [], result = await createTools(deps({}, calls)).run({ ...args, released: true } as unknown as import('../src/tools.js').RunArgs);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Only the service runner');
    expect(calls).toHaveLength(0);
  });
  it('rejects the unpicked release bypass before submitting a job', async () => {
    const calls: Calls[] = [], result = await createTools(deps({}, calls)).run({ ...args, allow: ['unpicked'] } as never);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Only the service runner');
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
  it('returns the selected record with its retry chain and no answer', async () => {
    const job = ledgerJob({ state: 'failed', retriedAs: 'node:next' });
    const retries = [ledgerJob({ id: 'node:next', localId: 'next', retryOf: job.id })];
    const calls: Calls[] = [];
    const r = await createTools(deps({ ledger_get: { job, parent: null, children: [], retries } }, calls)).job({ id: 'abc' });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Retried as: node:next');
    expect(r.data).toMatchObject({ job, retries, history: [] });
    expect(r.data).not.toHaveProperty('answer');
    expect(calls.map(c => c.method)).toEqual(['ledger_get']);
  });
  it('lists jobs and routes and turns a service error into an error result', async () => {
    const t = createTools(deps({ ledger_list: { jobs: [ledgerJob()], next: null }, routes: ROUTES, pressure: new Error('service is not running') }));
    expect((await t.jobs({})).text).toContain('node:abc  done  llm-request  luna');
    expect((await t.routes()).text).toContain('cannot run: no program');
    expect(await t.pressure()).toMatchObject({ isError: true, text: 'service is not running' });
  });
});

describe('premium backlog tools', () => {
  it('offers add, list and status calls without run or drop operations', async () => {
    const calls: Calls[] = [], t = createTools(deps({ backlog_add: { id: 'item-1' }, backlog_list: [], backlog_status: { counts: { queued: 0 } } }, calls));
    expect((await t.backlogAdd({ item: { requester: 'owner' } })).isError).toBeUndefined();
    expect((await t.backlogList({ status: 'queued' })).text).toBe('No backlog items.');
    expect((await t.backlogStatus()).text).toContain('queued');
    expect(calls.map(x => x.method)).toEqual(['backlog_add', 'backlog_list', 'backlog_status']);
    expect(Object.keys(t)).not.toContain('backlogRun');
    expect(Object.keys(t)).not.toContain('backlogDrop');
  });
});

describe('ledger tools', () => {
  it('uses the host session by default, permits all sessions, and passes every query filter', async () => {
    const calls: Calls[] = [], d = deps({ ledger_list: { jobs: [], next: 'page-2' }, ledger_counts: { running: 2 } }, calls);
    d.stamp = { sessionId: 'host' };
    const tools = createTools(d);
    expect((await tools.jobs({})).data).toEqual({ jobs: [], next: 'page-2' });
    expect(calls.at(-1)).toEqual({ method: 'ledger_list', params: { session: 'host', limit: 20 } });
    await tools.jobs({ all: true }); expect(calls.at(-1)?.params).toEqual({ limit: 20 });
    await tools.jobs({ session: 's', origin: 'cli', node: 'eru', kind: ['download'], state: ['running'], running: true, root: 'root', route: 'r', from: '2026-01-01', until: '2026-02-01', text: 'notes', page: 'next', limit: 3 });
    expect(calls.at(-1)?.params).toEqual({ session: 's', origin: 'cli', node: 'eru', kind: ['download'], state: ['running', 'stalled'], localState: 'running', root: 'root', route: 'r', from: Date.parse('2026-01-01'), to: Date.parse('2026-02-01'), text: 'notes', page: 'next', limit: 3 });
    expect((await tools.jobCounts({ all: true, node: 'eru' })).data).toEqual({ counts: { running: 2 } });
    expect(calls.at(-1)).toEqual({ method: 'ledger_counts', params: { node: 'eru' } });
  });
  it('filters replayed changes and advances the global cursor through unrelated changes', async () => {
    const calls: Calls[] = [], job = ledgerJob();
    const tools = createTools(deps({ ledger_changes: { changes: [{ cursor: '7', at: 10, job }, { cursor: '8', at: 11, job: ledgerJob({ id: 'other:job' }) }], cursor: '8', more: true }, ledger_list: { jobs: [job], next: null } }, calls));
    const r = await tools.jobs({ since: '6', limit: 2 });
    expect(r.data).toMatchObject({ changes: [{ cursor: '7' }], cursor: '8', more: true });
    expect(calls[0]).toEqual({ method: 'ledger_changes', params: { since: '6', limit: 2 } });
    expect((await tools.jobs({ since: '6', page: 'x' })).isError).toBe(true);
  });
  it('reads nodes, alert times, and local history without exposing event detail', async () => {
    const node = { node: 'eru', cursor: '8', lastSeenAt: 1000, unreachableSince: 2000 };
    const recent = { at: Date.parse('2026-11-07'), type: 'job.failed', jobId: 'node:abc', summary: 'Read notes' };
    const tools = createTools(deps({ ledger_nodes: [node], ledger_alerts: [{ ...recent, at: 0 }, recent], ledger_get: { job: ledgerJob({ kind: 'augur-job' }), parent: null, children: [], retries: [] }, events: [{ at: 0, kind: 'queued', detail: 'private-sentinel' }] }));
    expect((await tools.nodes()).data).toEqual({ nodes: [node] });
    expect((await tools.nodes()).text).toContain('unreachable since 1970');
    expect((await tools.alerts({ since: '2026-11-01' })).data).toEqual({ alerts: [recent] });
    const r = await tools.job({ id: 'abc' });
    expect(r.data?.history).toEqual([{ at: 0, kind: 'queued' }]); expect(JSON.stringify(r)).not.toContain('private-sentinel');
  });
  it('refuses remote execution ids and converts local qualified ids', async () => {
    const calls: Calls[] = [], d = deps({ ledger_get: { job: ledgerJob(), parent: null, children: [], retries: [] } }, calls);
    expect((await createTools(d).cancel({ id: 'node:abc' })).text).toContain('not a local execution job');
    expect(calls.map(c => c.method)).toEqual(['ledger_get']);
    d.call = deps({ ledger_get: { job: ledgerJob({ kind: 'augur-job' }) }, cancel: { ok: true, state: 'cancel_requested' } }, calls).call;
    expect((await createTools(d).cancel({ id: 'node:abc' })).isError).toBeUndefined();
    expect(calls.at(-1)).toEqual({ method: 'cancel', params: { id: 'abc' } });
  });
  it('publishes read-only schemas and validates filters through the protocol', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair(), calls: Calls[] = [];
    const server = buildServer(createTools(deps({ ledger_list: { jobs: [ledgerJob()], next: null }, ledger_counts: { done: 1 }, ledger_nodes: [], ledger_alerts: [] }, calls)), 'test');
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const { tools } = await client.listTools();
      for (const name of ['augur_jobs', 'augur_job', 'augur_job_counts', 'augur_nodes', 'augur_alerts']) expect(tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      const schema = tools.find(t => t.name === 'augur_jobs')!.inputSchema;
      for (const name of ['all', 'session', 'origin', 'node', 'kind', 'state', 'running', 'root', 'route', 'from', 'until', 'text', 'limit', 'page', 'since']) expect(schema.properties).toHaveProperty(name);
      expect((await client.callTool({ name: 'augur_jobs', arguments: { kind: ['invalid'] } })).isError).toBe(true);
      const r = await client.callTool({ name: 'augur_jobs', arguments: { all: true, limit: 2 } });
      expect(r.structuredContent).toEqual({ jobs: [ledgerJob()], next: null });
      expect(calls.at(-1)?.params).toEqual({ limit: 2 });
      for (const name of ['augur_job_counts', 'augur_nodes', 'augur_alerts']) expect((await client.callTool({ name, arguments: {} })).isError).toBeUndefined();
    } finally { await client.close(); await server.close(); }
  });
});

describe('the server', () => {
  it('offers the MCP tools with the rules in its instructions, and runs one through a client', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildServer(createTools(deps({ routes: ROUTES, resets: { events: [], summary: { rows: 0, meters: [] } } })), 'test');
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['alias_list', 'augur_alerts', 'augur_backlog_add', 'augur_backlog_list', 'augur_backlog_status', 'augur_balance', 'augur_cancel', 'augur_job', 'augur_job_counts', 'augur_jobs', 'augur_models', 'augur_nodes', 'augur_pick', 'augur_pick_preview', 'augur_policy', 'augur_policy_edit', 'augur_pressure', 'augur_prose_add', 'augur_prose_list', 'augur_prose_status', 'augur_replay', 'augur_resets', 'augur_route_add', 'augur_routes', 'augur_run', 'gate_report', 'gate_status']);
    expect(tools.map(t => t.name)).not.toContain('prose_approve');
    expect(tools.some(t => /alias_(accept|reject)/.test(t.name))).toBe(false);
    expect(tools.some(t => /backlog_(run|drop|release)/.test(t.name))).toBe(false);
    const resets = tools.find(t => t.name === 'augur_resets')!;
    expect(resets.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(resets.description).toContain('never changes anything');
    expect(resets.inputSchema.properties).toHaveProperty('provider');
    expect(resets.inputSchema.properties).toHaveProperty('limit');
    expect(tools.find(t => t.name === 'augur_pick')!.inputSchema.properties).toHaveProperty('role');
    expect(tools.find(t => t.name === 'augur_pick')!.inputSchema.properties).toHaveProperty('model');
    expect(tools.find(t => t.name === 'alias_list')!.annotations).toMatchObject({ readOnlyHint: true });
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
    expect(run.inputSchema.properties).toHaveProperty('persistPrompt', { type: 'boolean', description: REPLAY_TEXT.persistPrompt });
    expect(tools.find(t => t.name === 'augur_replay')?.inputSchema.required).toEqual(['job', 'route']);
    expect(JSON.stringify(run.inputSchema)).toContain('"enum":["read","write","full"]');
    expect(run.inputSchema.properties).not.toHaveProperty('allow');
    expect(tools.find(t => t.name === 'gate_status')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find(t => t.name === 'gate_report')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.some(t => /gate_record/.test(t.name))).toBe(false);
    expect(run.inputSchema.required).toEqual(expect.arrayContaining(['route', 'prompt', 'activity', 'data_tier']));
    expect(run.inputSchema.properties).toMatchObject({ packs: { type: 'array' }, no_charter: { type: 'boolean' }, conversation: { type: 'string' }, attachments: { type: 'array' }, urgent: { type: 'boolean' } });
    expect(run.inputSchema.properties).not.toHaveProperty('caller');
    expect(run.inputSchema.properties).not.toHaveProperty('released');
    expect(tools.find(t => t.name === 'augur_pick')?.inputSchema.properties).not.toHaveProperty('caller');
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
  it('refuses a released flag in an external MCP run request', async () => {
    const calls: Calls[] = [], [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildServer(createTools(deps({}, calls)), 'test'), client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: 'augur_run', arguments: { route: 'luna', prompt: 'x', activity: 'write_code', data_tier: 'internal', released: true } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await client.close();
  });
});

describe('replay and prompt storage', () => {
  it('passes all three prompt storage states to submit', async () => {
    const calls: Calls[] = [], tools = createTools(deps({ submit: { id: 'new', warnings: [] } }, calls));
    for (const persistPrompt of [true, false, undefined]) {
      await tools.run({ route: 'raw', prompt: 'hello', activity: 'write_code', data_tier: 'internal', persistPrompt, wait_s: 0 });
      const req = calls.at(-1)?.params as Record<string, unknown>;
      expect(req.persistPrompt).toBe(persistPrompt);
      expect(Object.hasOwn(req, 'persistPrompt')).toBe(persistPrompt !== undefined);
    }
  });

  it('starts a replay for this session and returns service refusals', async () => {
    const calls: Calls[] = [];
    const tools = createTools(deps({ replay: { id: 'new', warnings: [] } }, calls));
    expect(await tools.replay({ job: 'original', route: 'raw' })).toMatchObject({ text: REPLAY_TEXT.started('new'), data: { id: 'new' } });
    expect(calls).toEqual([{ method: 'replay', params: { job: 'original', route: 'raw', caller: { stamp: { origin: 'mcp', originLabel: 'augur-mcp', sessionId: 'mcp-test' }, kind: 'mcp', label: 'augur-mcp', session: 'mcp-test', intent: 'interactive' } } }]);
    const refusal = { code: 'inputs_not_replayable', reason: 'input file source.txt' };
    expect(await createTools(deps({ replay: { rejected: refusal } })).replay({ job: 'original', route: 'raw' })).toMatchObject({ isError: true, data: { rejected: refusal } });
  });

  it('shows the replay link in job metadata and lists', async () => {
    const job = ledgerJob({ replayOf: 'node:original' });
    const tools = createTools(deps({ ledger_get: { job, parent: null, children: [], retries: [] }, ledger_list: { jobs: [job], next: null } }));
    const result = await tools.job({ id: 'new' });
    expect(result.text).toContain('replay of node:original');
    expect(result.data?.job).toMatchObject({ replayOf: 'node:original' });
    expect((await tools.jobs({})).text).toContain('replay of node:original');
  });

  it('calls replay and validates prompt storage through an MCP client', async () => {
    const calls: Calls[] = [], [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildServer(createTools(deps({ replay: { id: 'new', warnings: [] }, submit: { id: 'kept', warnings: [] } }, calls)), 'test');
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      expect((await client.callTool({ name: 'augur_replay', arguments: { job: 'original', route: 'raw' } })).structuredContent).toEqual({ id: 'new', warnings: [] });
      const args = { route: 'raw', prompt: 'hello', activity: 'write_code', data_tier: 'internal', wait_s: 0 };
      await client.callTool({ name: 'augur_run', arguments: { ...args, persistPrompt: true } });
      expect(calls.at(-1)?.params).toMatchObject({ persistPrompt: true });
      const count = calls.length;
      expect((await client.callTool({ name: 'augur_run', arguments: { ...args, persistPrompt: 'true' } })).isError).toBe(true);
      expect(calls).toHaveLength(count);
    } finally { await client.close(); }
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
