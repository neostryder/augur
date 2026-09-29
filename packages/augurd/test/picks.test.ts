import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTES, makeEnv, request, submitOk, terminal } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const envs: Env[] = [];
afterEach(() => { while (envs.length) envs.pop()!.dispose(); });
const setup = (...a: Parameters<typeof makeEnv>) => { const e = makeEnv(...a); envs.push(e); return e; };
const caller = (session: string) => ({ kind: 'other' as const, label: 'test', session });

describe('picks through the service', () => {
  it('ranks the models a task may use, leaves out the ones that fail a rule, and names the routes that reach each', async () => {
    const e = setup();
    const r = await e.sup.pick({ activity: 'write_code', dataTier: 'internal' });
    if ('error' in r) throw new Error(r.error);
    expect(r.ranking.map(x => x.model)).toEqual(expect.arrayContaining(['test/fake', 'test/patch', 'test/sandboxed']));
    expect(r.blocked.find(b => b.model === 'test/ask')?.why).toMatch(/ask first/);
    expect(r.blocked.find(b => b.model === 'test/public')?.why).toMatch(/cleared for public data/);
    expect(r.routes['test/fake']).toEqual(expect.arrayContaining(['fake', 'raw', 'boss']));
    expect(await e.sup.pick({ activity: 'write_code', dataTier: 'internal', named: 'test/ask' })).toMatchObject({ ranking: expect.arrayContaining([expect.objectContaining({ model: 'test/ask' })]) });
  });

  it('answers without a policy and for an unknown activity', async () => {
    const e = setup();
    expect(await e.sup.pick({ activity: 'nonsense' as never, dataTier: 'internal' })).toHaveProperty('error');
    const bare = setup(); (bare.sup as unknown as { d: { policy: () => null } }).d.policy = () => null;
    expect(await bare.sup.pick({ activity: 'write_code', dataTier: 'internal' })).toHaveProperty('error');
  });

  it('reports pressure only when both policy.json and usage.json exist', () => {
    const e = setup();
    expect(e.sup.pressure()).toBeNull();
    e.writeUsage(40);
    const p = e.sup.pressure();
    expect(p?.pressure.test?.headroom).toBeGreaterThan(0);
    expect(p?.factors['test/fake']).toBeGreaterThan(0);
  });

  it('refuses a job whose model nobody picked when picks are required, and accepts it after a pick, a name or an override', async () => {
    const e = setup({ requirePick: true });
    const asOne = (over: object = {}) => request({ text: 'SLEEP 0', ...over, caller: caller('s1') } as never, e.root);
    expect(e.sup.submit(asOne())).toMatchObject({ rejected: { code: 'not_picked' } });
    const picked = await e.sup.pick({ activity: 'write_code', dataTier: 'internal', session: 's1', fits: { 'test/fake': 1 } });
    if ('error' in picked) throw new Error(picked.error);
    expect(picked.pick).toBe('test/fake');
    const id = submitOk(e.sup, asOne());
    expect((await terminal(e.sup, e.store, id)).state).toBe('completed');
    // Another caller's pick does not count.
    expect(e.sup.submit({ ...asOne(), caller: caller('s2') })).toMatchObject({ rejected: { code: 'not_picked' } });
    // A model the pick cleared but ranked lower goes ahead with a note.
    await e.sup.pick({ activity: 'write_code', dataTier: 'public', session: 's1', fits: { 'test/fake': 1, 'test/public': 0 } });
    const cleared = e.sup.submit(asOne({ route: 'pub', dataTier: 'public' }));
    expect('warnings' in cleared && cleared.warnings.some(w => /cleared/.test(w))).toBe(true);
    // Named, and the override, both skip the check, and the override is recorded.
    const other = setup({ requirePick: true });
    const named = other.sup.submit({ ...request({ text: 'SLEEP 0' }, other.root), named: true, caller: caller('s9') });
    expect('id' in named).toBe(true);
    const forced = other.sup.submit({ ...request({ text: 'SLEEP 0' }, other.root), allow: ['unpicked'], caller: caller('s9') });
    expect('id' in forced).toBe(true);
    expect(other.store.events((forced as { id: string }).id).map(x => x.kind)).toContain('checks_overridden');
  });

  it('leaves picks unchecked when they are not required', () => {
    const e = setup();
    expect('id' in e.sup.submit(request({ text: 'SLEEP 0' }, e.root))).toBe(true);
  });

  it('denies a job for a provider that is over its limit and names the reason', () => {
    const e = setup(); e.writeUsage(99);
    expect(e.sup.submit(request({ text: 'SLEEP 0' }, e.root))).toMatchObject({ rejected: { code: 'quota_denied' } });
    expect(Object.keys(ROUTES).length).toBeGreaterThan(0);
  });
});

describe('confirming that a person named the model', () => {
  const ask = (e: Env, session: string, extra: object = {}) => ({ ...request({ route: 'ask', text: 'SLEEP 0', ...extra } as never, e.root), named: true, caller: { kind: 'other' as const, session, ...extra } });

  it('takes the claim and notes it when the service only records, which is the default', () => {
    const e = setup();
    const r = e.sup.submit(ask(e, 's1'));
    expect('warnings' in r && r.warnings.some(w => /only records/.test(w))).toBe(true);
  });

  it('refuses an ask-first model in enforce mode until a recent message from a person names it', async () => {
    const e = setup({ verifyNamed: 'enforce' });
    const first = e.sup.submit(ask(e, 's1'));
    expect(first).toMatchObject({ rejected: { code: 'ask_first', reason: expect.stringContaining('treated as not named') } });
    expect(e.sup.humanPrompt('s1', 'please use ask for this')).toEqual({ models: ['test/ask'] });
    const ok = e.sup.submit(ask(e, 's1'));
    expect('id' in ok).toBe(true);
    // Another session's message does not count, and neither does a person who named something else.
    expect(e.sup.submit(ask(e, 's2'))).toMatchObject({ rejected: { code: 'ask_first' } });
    e.sup.humanPrompt('s3', 'use fake instead');
    expect(e.sup.submit(ask(e, 's3'))).toMatchObject({ rejected: { code: 'ask_first' } });
    if ('id' in ok) expect((await terminal(e.sup, e.store, ok.id)).named).toBe(true);
  });

  it('lets a caller at the keyboard through, and forgets a message after three more', () => {
    const e = setup({ verifyNamed: 'enforce' });
    expect('id' in e.sup.submit(ask(e, 's1', { interactive: true }))).toBe(true);
    e.sup.humanPrompt('s5', 'use ask'); for (const t of ['one', 'two', 'three']) e.sup.humanPrompt('s5', t);
    expect(e.sup.submit(ask(e, 's5'))).toMatchObject({ rejected: { code: 'ask_first' } });
  });

  it('takes the claim without checking when the setting is off, and keeps only the model names of a message', () => {
    const e = setup({ verifyNamed: 'off' });
    expect('id' in e.sup.submit(ask(e, 's1'))).toBe(true);
    e.sup.humanPrompt('s1', 'a very private sentence about ask');
    expect(JSON.stringify(e.store.db.prepare('select * from prompts').all())).not.toContain('private');
  });
});

describe('picking by task description', () => {
  const backend = (calls: string[] = []) => ({
    id: 'laya', local: true,
    async ask(_s: unknown, q: Record<string, unknown>) {
      const names = Object.keys(q);
      calls.push(names[0] as string);
      if ('activity' in q) return { answers: { activity: { choice: 'write_code', confidence: 0.9 } } };
      if ('data' in q) return { answers: { data: { probabilities: { public: 0.05, internal: 0.9, sensitive: 0.05, regulated: 0 } } } };
      const answers: Record<string, { score: number }> = {};
      for (const n of names) answers[n] = { score: n === 'f_test_patch' ? 3 : n === 'r_test_patch' ? 0 : n.startsWith('f_') ? 0 : 3 };
      return { answers };
    },
  });
  const withBackend = (e: Env, b: unknown) => { (e.sup as unknown as { d: { decision: unknown } }).d.decision = { primary: b }; };

  it('classifies the task, scores each candidate model, and ranks on the result', async () => {
    const e = setup(), calls: string[] = [];
    withBackend(e, backend(calls));
    const r = await e.sup.pick({ task: 'refactor the build scripts' });
    if ('error' in r) throw new Error(r.error);
    expect(r).toMatchObject({ activity: 'write_code', dataTier: 'internal', decision: { backend: 'laya' } });
    expect(calls[0]).toBe('activity');
    expect(r.ranking[0]?.model).toBe('test/patch');
    expect(r.ranking.find(x => x.model === 'test/patch')?.fit).toBe(1);
  });

  it('takes the fits a caller gives and asks only for the rest, and uses a given activity without asking', async () => {
    const e = setup(), calls: string[] = [];
    withBackend(e, backend(calls));
    const r = await e.sup.pick({ task: 'refactor the build scripts', activity: 'write_code', dataTier: 'internal', fits: { 'test/patch': 0, 'test/fake': 1 } });
    if ('error' in r) throw new Error(r.error);
    expect(calls).not.toContain('activity');
    expect(r.ranking.find(x => x.model === 'test/patch')?.fit).toBe(0);
    expect(r.ranking.find(x => x.model === 'test/fake')?.fit).toBe(1);
  });

  it('falls back to 0.5 and says why when the backend fails, and refuses a task it cannot classify', async () => {
    const e = setup();
    withBackend(e, { id: 'laya', local: true, ask: async () => ({ error: 'down' }) });
    const r = await e.sup.pick({ task: 'refactor the build scripts', activity: 'write_code', dataTier: 'internal' });
    if ('error' in r) throw new Error(r.error);
    expect(r.ranking.every(x => x.fit === 0.5)).toBe(true);
    expect(r.decision?.fitError).toBeDefined();
    expect(await e.sup.pick({ task: 'refactor the build scripts' })).toHaveProperty('error');
    expect(await setup().sup.pick({ task: 'refactor the build scripts' })).toHaveProperty('error');
  });
});
