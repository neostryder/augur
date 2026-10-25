import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, readToken, ServiceError } from '../src/client.js';
import { startService } from '../src/main.js';
import { AGENT_METHODS, HTTP_DISPATCH_METHODS, attestAgentRequest } from '../src/ipc.js';
import { JOBHOST, makeEnv, request, sleep } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function boot() {
  const e: Env = makeEnv();
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augurd-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(e.root, 'test.sock');
  writeFileSync(join(e.dir, 'config.json'), JSON.stringify({ requirePick: false, verifyNamed: 'record', adapters: ['codex-exec', 'exec'], jobhostPath: existsSync(JOBHOST) ? JOBHOST : null }));
  const svc = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath, engine: false });
  cleanup.push(async () => { await svc.stop().catch(() => {}); e.dispose(); });
  const o = { dir: e.dir, pipe };
  return { e, svc, pipe, o, stopOnly: () => svc.stop() };
}

async function finished(o: { dir: string; pipe: string }, id: string) {
  for (let i = 0; i < 300; i++) {
    const j = await call('status', { id }, o);
    if (j && !['queued', 'running', 'cancel_requested'].includes(j.state)) return j;
    await sleep(150);
  }
  throw new Error('job did not finish');
}

describe('the dispatch calls the web server may pass on', () => {
  it('are agent calls that run and read jobs, and never edit routes or rules', () => {
    for (const m of HTTP_DISPATCH_METHODS) expect(AGENT_METHODS.has(m), m).toBe(true);
    for (const m of ['route_add', 'balance', 'pick_answer', 'human_prompt', 'engine_call']) expect(HTTP_DISPATCH_METHODS.has(m), m).toBe(false);
  });
});

describe('the control endpoint', () => {
  it('turns away JSON that is not an object without stopping the service', async () => {
    const { o, pipe } = await boot();
    const net = await import('node:net');
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(pipe);
      let got = '';
      sock.on('connect', () => sock.write('null\n'));
      sock.on('data', d => { got += d.toString(); sock.destroy(); resolve(got); });
      sock.on('error', reject);
    });
    expect(JSON.parse(reply.trim())).toMatchObject({ error: { code: 'bad_json' } });
    expect(await call('ping', undefined, o)).toMatchObject({ pid: process.pid });
  });

  it('answers a caller that holds the token, and turns away one that does not', async () => {
    const { o, e } = await boot();
    expect(await call('ping', undefined, o)).toMatchObject({ pid: process.pid, version: 1 });
    await expect(call('ping', undefined, { ...o, token: 'x'.repeat(64) })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(readToken(e.dir)).toHaveLength(64);
    await expect(call('ping', undefined, { ...o, dir: join(e.root, 'nowhere') })).rejects.toBeInstanceOf(ServiceError);
  });

  it('gives an agent its own token that runs work and reads results but speaks for no one', async () => {
    const { o, e } = await boot();
    const agent = { ...o, role: 'agent' as const };
    expect(readToken(e.dir, 'agent')).toHaveLength(64);
    expect(readToken(e.dir, 'agent')).not.toBe(readToken(e.dir));
    expect(await call('ping', undefined, agent)).toMatchObject({ pid: process.pid });
    expect(await call('routes', undefined, agent)).toBeTruthy();
    expect(await call('alias_refresh', {}, o)).toMatchObject({ offers: [], flags: [], noListing: [] });
    for (const [method, params] of [['human_prompt', { session: 's', text: 'use the big model' }], ['pick_answer', { id: 'x', model: 'm' }], ['grade_label', { id: 'x', label: 'agree' }], ['label', { id: 'x', result: 'met' }], ['engine_call', { method: 'getConfig', args: [] }], ['conversations', undefined], ['alias_refresh', {}]] as const)
      await expect(call(method as never, params as never, agent)).rejects.toMatchObject({ message: expect.stringContaining('may not use') });
    for (const [method, params] of [['prose_run', {}], ['prose_approve', { id: 'x' }]] as const)
      await expect(call(method as never, params as never, agent)).rejects.toMatchObject({ message: expect.stringContaining('may not use') });
    for (const method of ['alias_accept', 'alias_reject']) await expect(call(method as never, undefined as never, o)).rejects.toMatchObject({ message: expect.stringContaining('unknown method') });
    await expect(call('ping', undefined, { ...o, token: readToken(e.dir, 'agent'), role: undefined })).resolves.toBeTruthy();
    await expect(call('human_prompt', { session: 's', text: 'x' }, o)).resolves.toBeTruthy();
  });

  it('strips the claims that would stand in for the owner from an agent job request', () => {
    const base = request({ text: 'hi', cwd: '.' });
    const forged = attestAgentRequest({ ...base, named: true, allow: ['unpicked', 'exhausted'], caller: { kind: 'cli', interactive: true, session: 's1', label: 'x' } });
    expect(forged.named).toBeUndefined(); expect(forged.allow).toBeUndefined();
    expect(forged.caller).toEqual({ kind: 'cli', session: 's1', label: 'x' });
    for (const m of ['human_prompt', 'pick_answer', 'grade_label', 'label', 'engine_call', 'engine_state', 'grade', 'apply']) expect(AGENT_METHODS.has(m), m).toBe(false);
    expect(AGENT_METHODS.has('alias_refresh')).toBe(false);
    for (const m of ['alias_accept', 'alias_reject']) expect(AGENT_METHODS.has(m), m).toBe(false);
    for (const m of ['submit', 'pick', 'result', 'route_add', 'routes', 'cancel']) expect(AGENT_METHODS.has(m), m).toBe(true);
  });

  it('runs a job end to end through the pipe and shows its record, events, logs and result', async () => {
    const { o, e } = await boot();
    const sub = await call('submit', request({ text: 'WRITE out.txt\nENV CODEX_HOME', expectFile: 'out.txt', cwd: e.root }), o);
    expect('id' in sub).toBe(true);
    const id = (sub as { id: string }).id;
    const job = await finished(o, id);
    expect(job).toMatchObject({ state: 'completed', route: 'fake', usage: { inputTokens: 1200 } });
    const events = await call('events', { id }, o);
    expect(events.map(x => x.kind)).toContain('artifact_validated');
    expect((await call('logs', { id }, o))!.text).toContain('turn.completed');
    expect((await call('result', { id }, o))!.answer).toBe('final message');
    expect((await call('list', { limit: 5 }, o)).map(j => j.id)).toContain(id);
    expect(await call('status', { id: 'missing' }, o)).toBeNull();
  });

  it('records text lengths and labels each figure in the accounting answer, using the owner\'s rate card', async () => {
    const { o, e } = await boot();
    const text = 'WRITE out.txt\nENV CODEX_HOME';
    const id = (await call('submit', request({ text, expectFile: 'out.txt', cwd: e.root }), o) as { id: string }).id;
    const job = await finished(o, id);
    expect(job).toMatchObject({ promptChars: text.length, answerChars: 'final message'.length });
    const bare = await call('accounting', {}, o);
    expect(bare.jobs[0]).toMatchObject({ id, model: 'test/fake', accounted: { inputTokens: { value: 1200, provenance: 'reported' }, costUsd: null } });
    mkdirSync(join(e.home, 'dispatch'), { recursive: true });
    writeFileSync(join(e.home, 'dispatch', 'rates.json'), JSON.stringify({ 'test/fake': { inputPerM: 1_000_000, outputPerM: 0 }, broken: { inputPerM: 'x' } }));
    // The job's usage includes cached tokens, so a rate with no cached price gives no cost rather than a guess.
    const unpriced = await call('accounting', {}, o);
    expect(unpriced.ratedModels).toEqual(['test/fake']);
    expect(unpriced.jobs[0]!.accounted.costUsd).toBeNull();
    writeFileSync(join(e.home, 'dispatch', 'rates.json'), JSON.stringify({ 'test/fake': { inputPerM: 1_000_000, outputPerM: 0, cachedReadPerM: 0 } }));
    const rated = await call('accounting', {}, o);
    expect(rated.jobs[0]!.accounted.costUsd).toMatchObject({ value: 200, provenance: 'derived' });
    expect(rated.routes.fake!.totals).toMatchObject({ jobs: 1, costJobs: 1 });
  });

  it('reports a rejection to the caller and lists routes without their options', async () => {
    const { o, e } = await boot();
    const rej = await call('submit', request({ route: 'ask' }, e.root), o);
    expect(rej).toMatchObject({ rejected: { code: 'ask_first' } });
    const routes = await call('routes', undefined, o);
    expect(routes.find(r => r.name === 'fake')).toEqual({ name: 'fake', model: 'test/fake', adapter: 'codex-exec', problem: null, capabilities: { attachments: [], vision: false, embed: false, transcribe: false } });
    expect(JSON.stringify(routes)).not.toContain('prefixArgs');
  });

  it('keeps a running job going when the service stops, and a new service picks it up', async () => {
    const { o, e, stopOnly, pipe } = await boot();
    const sub = await call('submit', request({ text: 'WRITE kept.txt\nSLEEP 4', expectFile: 'kept.txt', cwd: e.root }), o) as { id: string };
    for (let i = 0; i < 100 && (await call('status', { id: sub.id }, o))?.state !== 'running'; i++) await sleep(100);
    await sleep(800);
    await stopOnly();
    await expect(call('ping', undefined, { ...o, timeoutMs: 2000 })).rejects.toBeInstanceOf(ServiceError);
    const again = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath, engine: false });
    cleanup.push(() => again.stop());
    const job = await finished(o, sub.id);
    expect(job.state).toBe('completed');
    expect((await call('events', { id: sub.id }, o)).map(x => x.kind)).toContain('reconciled');
  });

  it('refuses to start a second service on the same endpoint', async () => {
    const { e, pipe } = await boot();
    await expect(startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath, engine: false })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('the token file', () => {
  it('is created once and kept across restarts', async () => {
    const { e, stopOnly, pipe } = await boot();
    const first = readFileSync(join(e.dir, 'token'), 'utf8');
    await stopOnly();
    const again = await startService({ dir: e.dir, home: e.home, pipe, routesPath: e.routesPath, engine: false });
    cleanup.push(() => again.stop());
    expect(readFileSync(join(e.dir, 'token'), 'utf8')).toBe(first);
  });
});
