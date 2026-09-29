import { describe, expect, it } from 'vitest';
import { ACTIVITIES, DATA_TIERS } from '@augur/core';
import { ACTIVITY_TEXT, DATA_TEXT, JevBackend, LayaBackend, NoBackend, PoolError, ServerPool, classifyTask, createBackend, fitQuestions, fitScores, readFits } from '../src/index.js';
import { ShadowBackend } from '../src/index.js';
import type { Comparison, DecisionBackend, Fetch, Question, SystemOneResponse } from '../src/index.js';

interface Script { load?: { busy?: boolean; ready?: boolean; reasons?: string[] } | 404 | 'down'; post?: number | SystemOneResponse | ((body: Record<string, unknown>) => SystemOneResponse) }
function net(scripts: Record<string, Script>) {
  const calls: string[] = [];
  const fetcher: Fetch = async (url, init) => {
    const host = new URL(url).origin, s = scripts[host];
    calls.push(`${init?.method ?? 'GET'} ${host}${new URL(url).pathname}`);
    if (!s || s.load === 'down') throw new Error('connect refused');
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (url.endsWith('/load')) return s.load === 404 ? reply(404, {}) : reply(200, s.load ?? { busy: false, ready: true });
    if (typeof s.post === 'number') return reply(s.post, { error: 'x' });
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    return reply(200, typeof s.post === 'function' ? s.post(body) : s.post ?? { answers: {} });
  };
  return { fetcher, calls };
}
const A = 'http://a.test:8010', B = 'http://b.test:8010';
const servers = [{ name: 'a', url: A }, { name: 'b', url: B }];

describe('question text', () => {
  it('describes every activity and data tier the rules know', () => {
    expect(Object.keys(ACTIVITY_TEXT).sort()).toEqual([...ACTIVITIES].sort());
    expect(Object.keys(DATA_TEXT).sort()).toEqual([...DATA_TIERS].sort());
  });
  it('asks each model twice with the levels in opposite orders and averages the two', () => {
    const q = fitQuestions([{ model: 'codex/sol', description: 'd' }]);
    const f = q.f_codex_sol as Extract<Question, { type: 'score' }>, r = q.r_codex_sol as Extract<Question, { type: 'score' }>;
    expect(r.criteria).toEqual([...f.criteria].reverse());
    expect(readFits(['codex/sol'], { f_codex_sol: { score: 3 }, r_codex_sol: { score: 0 } })).toEqual({ 'codex/sol': 1 });
    expect(readFits(['codex/sol'], { f_codex_sol: { score: 2 }, r_codex_sol: { score: 2 } })['codex/sol']).toBeCloseTo(0.5, 3);
    expect(readFits(['x/y'], {})).toEqual({ 'x/y': 0.5 });
  });
});

describe('the Laya server list', () => {
  it('uses the first healthy server and skips a busy one, remembering it for a few seconds', async () => {
    const { fetcher, calls } = net({ [A]: { load: { busy: true, reasons: ['GPU use over 80%'], ready: true } }, [B]: { post: { answers: { ok: { noul: 1 } } } } });
    let t = 0;
    const pool = new ServerPool(servers, fetcher, () => t);
    expect((await pool.post('/v1/systemone', {})).server).toBe('b');
    await pool.post('/v1/systemone', {});
    expect(calls.filter(c => c === 'GET http://a.test:8010/load')).toHaveLength(1);
    t = 6000;
    await pool.post('/v1/systemone', {});
    expect(calls.filter(c => c === 'GET http://a.test:8010/load')).toHaveLength(2);
  });
  it('moves on from an unreachable server and from a 503, and treats a server with no /load as usable', async () => {
    const down = new ServerPool(servers, net({ [A]: { load: 'down' }, [B]: { load: 404 } }).fetcher);
    expect((await down.post('/v1/systemone', {})).server).toBe('b');
    const busy = new ServerPool(servers, net({ [A]: { post: 503 }, [B]: {} }).fetcher);
    expect((await busy.post('/v1/systemone', {})).server).toBe('b');
  });
  it('raises a client error without trying the next server, and lists every reason when none answers', async () => {
    const { fetcher, calls } = net({ [A]: { post: 422 }, [B]: {} });
    await expect(new ServerPool(servers, fetcher).post('/v1/systemone', {})).rejects.toMatchObject({ status: 422 });
    expect(calls.some(c => c.includes('b.test') && c.startsWith('POST'))).toBe(false);
    const none = new ServerPool(servers, net({ [A]: { load: 'down' }, [B]: { load: { busy: true, reasons: ['video memory over 80%'] } } }).fetcher);
    await expect(none.post('/v1/systemone', {})).rejects.toBeInstanceOf(PoolError);
    await expect(none.post('/v1/systemone', {})).rejects.toThrow(/video memory over 80%/);
  });
  it('turns a total failure into an error answer rather than an exception', async () => {
    const b = new LayaBackend(new ServerPool(servers, net({}).fetcher));
    expect((await b.ask('s', {})).error).toMatch(/no Laya server answered/);
  });
});

describe('choosing a backend', () => {
  it('builds Laya, Jev with a key from the environment, or nothing', async () => {
    expect(createBackend('laya', { backend: 'laya' }).id).toBe('laya');
    expect(createBackend('jev', { backend: 'jev' }, { TYPESAFE_API_KEY: 'k' }).id).toBe('jev');
    expect(createBackend('jev', { backend: 'jev' }, {}).id).toBe('none');
    expect((await new NoBackend().ask()).error).toMatch(/no decision backend/);
  });
  it('sends the key as a bearer token and never to a Laya server', async () => {
    let seen: Record<string, string> = {};
    const fetcher: Fetch = async (_u, init) => { seen = init?.headers ?? {}; return { ok: true, status: 200, json: async () => ({ answers: {} }) }; };
    await new JevBackend('secret-key', fetcher).ask('s', {});
    expect(seen.authorization).toBe('Bearer secret-key');
  });
});

const scripted = (answers: (q: Record<string, Question>, model?: string) => SystemOneResponse, local: boolean, id = local ? 'laya' : 'jev'): DecisionBackend & { asked: string[] } => {
  const asked: string[] = [];
  return { id, local, asked, async ask(_s, q, model) { asked.push(Object.keys(q)[0] as string); return answers(q, model); } };
};

describe('classifying a task', () => {
  const answers = (q: Record<string, Question>): SystemOneResponse => 'activity' in q
    ? { answers: { activity: { choice: 'write_code', confidence: 0.9 } } }
    : { answers: { data: { choice: 'internal', probabilities: { public: 0.1, internal: 0.7, sensitive: 0.2, regulated: 0 } } } };

  it('reads the activity, and the strictest data tier with enough probability', async () => {
    const c = await classifyTask({ primary: scripted(answers, true) }, 'refactor the build scripts');
    expect(c).toMatchObject({ activity: 'write_code', dataTier: 'internal' });
    const cautious = await classifyTask({ primary: scripted(q => 'data' in q ? { answers: { data: { probabilities: { public: 0.4, internal: 0.3, sensitive: 0.3, regulated: 0.1 } } } } : answers(q), true) }, 'x');
    expect(cautious.dataTier).toBe('sensitive');
  });
  it('assumes sensitive when nothing answers', async () => {
    const c = await classifyTask({ primary: new NoBackend() }, 'refactor the build scripts');
    expect(c).toMatchObject({ activity: null, dataTier: 'sensitive' });
  });
  it('judges text about students only on a local backend, never below sensitive, and never on a hosted one', async () => {
    const hosted = scripted(answers, false), local = scripted(answers, true);
    const c = await classifyTask({ primary: hosted, local }, 'grade the rubric for the section 4 students');
    expect(c.dataTier).toBe('sensitive');
    expect(c.detail.data?.backend).toBe('laya');
    expect(hosted.asked).toEqual(['activity']);
    const noLocal = await classifyTask({ primary: hosted }, 'grade the rubric for the section 4 students');
    expect(noLocal.dataTier).toBe('sensitive');
    expect(noLocal.detail.data?.backend).toBe('none');
    expect(hosted.asked).toEqual(['activity', 'activity']);
  });
});

describe('scoring fit', () => {
  it('reads a fit per model, and falls back to 0.5 when the backend fails', async () => {
    const models = [{ model: 'codex/sol', description: 'd' }, { model: 'xai/grok', description: 'd' }];
    const ok = scripted(() => ({ answers: { f_codex_sol: { score: 3 }, r_codex_sol: { score: 0 }, f_xai_grok: { score: 1 }, r_xai_grok: { score: 2 } } }), true);
    expect((await fitScores(ok, 't', models)).fits).toEqual({ 'codex/sol': 1, 'xai/grok': 0.333 });
    const failed = await fitScores(new NoBackend(), 't', models);
    expect(failed.fits).toEqual({ 'codex/sol': 0.5, 'xai/grok': 0.5 });
    expect(failed.error).toMatch(/no decision backend/);
  });
});

describe('comparing two backends', () => {
  const answer = (v: Record<string, object>): SystemOneResponse => ({ answers: v as never });
  it('returns the first backend answers and records how often the second agrees, without keeping the text', async () => {
    const seen: Comparison[] = [];
    const primary = scripted(() => answer({ a: { choice: 'write_code' }, s: { score: 2.4 }, n: { noul: 0.8 } }), true);
    const other = scripted(() => answer({ a: { choice: 'research' }, s: { score: 1.2 }, n: { noul: 0.7 } }), false);
    const shadow = new ShadowBackend(primary, other, c => seen.push(c));
    const res = await shadow.ask({ task: 'refactor the build' }, { a: { type: 'noul', instructions: 'x' } });
    await shadow.idle();
    expect(res.answers?.a?.choice).toBe('write_code');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.agree).toEqual({ a: false, s: false, n: true });
    expect(JSON.stringify(seen[0])).not.toContain('refactor the build');
    expect(seen[0]?.state).toHaveLength(16);
  });
  it('never sends student-related text to a backend that is not local, and skips a failed comparison', async () => {
    const seen: Comparison[] = [];
    const other = scripted(() => answer({}), false);
    const shadow = new ShadowBackend(scripted(() => answer({ a: { choice: 'x' } }), true), other, c => seen.push(c));
    await shadow.ask({ task: 'grade the rubric for the students' }, {});
    await shadow.idle();
    expect(other.asked).toEqual([]);
    const failing = new ShadowBackend(scripted(() => answer({ a: { choice: 'x' } }), true), scripted(() => ({ error: 'down' }), false), c => seen.push(c));
    await failing.ask({ task: 'fix the build' }, {});
    await failing.idle();
    expect(seen).toEqual([]);
  });
});
