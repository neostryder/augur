import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTES, makeEnv, request, submitOk, terminal } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const envs: Env[] = [];
afterEach(() => { while (envs.length) envs.pop()!.dispose(); });
const setup = (...a: Parameters<typeof makeEnv>) => { const e = makeEnv(...a); envs.push(e); return e; };
const caller = (session: string) => ({ kind: 'other' as const, label: 'test', session });

describe('picks through the service', () => {
  it('ranks the models a task may use, leaves out the ones that fail a rule, and names the routes that reach each', () => {
    const e = setup();
    const r = e.sup.pick({ activity: 'write_code', dataTier: 'internal' });
    if ('error' in r) throw new Error(r.error);
    expect(r.ranking.map(x => x.model)).toEqual(expect.arrayContaining(['test/fake', 'test/patch', 'test/sandboxed']));
    expect(r.blocked.find(b => b.model === 'test/ask')?.why).toMatch(/ask first/);
    expect(r.blocked.find(b => b.model === 'test/public')?.why).toMatch(/cleared for public data/);
    expect(r.routes['test/fake']).toEqual(expect.arrayContaining(['fake', 'raw', 'boss']));
    expect(e.sup.pick({ activity: 'write_code', dataTier: 'internal', named: 'test/ask' })).toMatchObject({ ranking: expect.arrayContaining([expect.objectContaining({ model: 'test/ask' })]) });
  });

  it('answers without a policy and for an unknown activity', () => {
    const e = setup();
    expect(e.sup.pick({ activity: 'nonsense' as never, dataTier: 'internal' })).toHaveProperty('error');
    const bare = setup(); (bare.sup as unknown as { d: { policy: () => null } }).d.policy = () => null;
    expect(bare.sup.pick({ activity: 'write_code', dataTier: 'internal' })).toHaveProperty('error');
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
    const picked = e.sup.pick({ activity: 'write_code', dataTier: 'internal', session: 's1', fits: { 'test/fake': 1 } });
    if ('error' in picked) throw new Error(picked.error);
    expect(picked.pick).toBe('test/fake');
    const id = submitOk(e.sup, asOne());
    expect((await terminal(e.sup, e.store, id)).state).toBe('completed');
    // Another caller's pick does not count.
    expect(e.sup.submit({ ...asOne(), caller: caller('s2') })).toMatchObject({ rejected: { code: 'not_picked' } });
    // A model the pick cleared but ranked lower goes ahead with a note.
    e.sup.pick({ activity: 'write_code', dataTier: 'public', session: 's1', fits: { 'test/fake': 1, 'test/public': 0 } });
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
