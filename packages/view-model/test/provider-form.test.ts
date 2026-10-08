import { describe, expect, it } from 'vitest';
import type { ProviderAddition } from '@augur/core';
import { PROVIDER_CHOICES, applyProvider, emptyProviderForm, inputOf, planOfForm, planRows, providerFields, routeEntryText } from '../src/index.js';
import type { ApplyIo, ProviderFormState } from '../src/index.js';

const form = (over: Partial<ProviderFormState>): ProviderFormState => ({ ...emptyProviderForm('openai'), ...over });
const none = new Set<string>();

function io(routes: string | null = null) {
  const calls: string[] = [];
  const state = { routes, added: null as ProviderAddition | null };
  const api: ApplyIo = {
    async addProvider(input) { calls.push('addProvider'); state.added = input; return { labels: Object.fromEntries((input.models ?? []).map(m => [m.id, m.label])), added: (input.models ?? []).map(m => m.id) }; },
    async setSecret(name) { calls.push(`secret:${name}`); },
    async setProviderKey(provider, field) { calls.push(`provider-key:${provider}.${field}`); },
    async readRoutes() { calls.push('read'); return state.routes; },
    async writeRoutes(text) { calls.push('write'); state.routes = text; },
  };
  return { api, calls, state };
}

describe('the Add provider form', () => {
  it('offers the presets, then a shape for any other service, and no Jev shape', () => {
    expect(PROVIDER_CHOICES.map(c => c.id)).toEqual(['openai', 'openrouter', 'anthropic', 'typesafe', 'openai-style', 'anthropic-style']);
    expect(PROVIDER_CHOICES.find(c => c.id === 'openrouter')!.sub).toBe('OpenAI-style API, balance built in');
    expect(PROVIDER_CHOICES.find(c => c.id === 'openai-style')!.label).toBe('Other OpenAI-style');
  });

  it('shows only the fields a choice needs', () => {
    expect(providerFields('openai')).toEqual({ route: true, model: true, provider: false, baseUrl: false });
    expect(providerFields('openai-style')).toEqual({ route: true, model: true, provider: true, baseUrl: true });
    expect(providerFields('typesafe')).toEqual({ route: false, model: false, provider: false, baseUrl: false });
  });

  it('leaves out empty fields so a preset keeps its own address, and drops fields the choice does not show', () => {
    expect(inputOf(form({ route: 'gpt', model: 'gpt-5', baseUrl: 'https://elsewhere.example', provider: 'zz' }))).toEqual({ kind: 'openai', route: 'gpt', model: 'gpt-5' });
    expect(inputOf(form({ route: 'gpt', model: 'gpt-5', more: true, baseUrl: 'https://proxy.example/v1', label: 'five' }))).toMatchObject({ baseUrl: 'https://proxy.example/v1', label: 'five' });
  });

  it('treats a form with nothing typed as fresh, and names a problem once something is typed', () => {
    const fresh = planOfForm(form({}), none);
    expect('problems' in fresh && fresh.fresh).toBe(true);
    const typed = planOfForm(form({ route: 'gpt' }), none);
    expect('problems' in typed && !typed.fresh && typed.problems.join(' ')).toContain('--model needs the model id');
  });

  it('plans an OpenAI route and reads the plan back as rows', () => {
    const got = planOfForm(form({ route: 'gpt', model: 'gpt-5' }), none);
    expect('plan' in got).toBe(true);
    if (!('plan' in got)) return;
    const rows = planRows(got.plan);
    expect(rows.map(r => r.label)).toEqual(['Route', 'Model', 'Key', 'Balance']);
    expect(rows[0]!.text).toBe('gpt, a chat route to https://api.openai.com/v1');
    expect(rows[1]).toMatchObject({ text: 'gpt-5 under OpenAI', tone: 'warn' });
    expect(rows[3]!.text).toContain('None.');
    expect(JSON.parse(`{${routeEntryText(got.plan).slice(1, -1)}}`).gpt.model).toBe('openai/gpt-5');
  });

  it('plans a Jev service with no route and says the provider turns on', () => {
    const got = planOfForm(form({ kind: 'typesafe' }), none);
    expect('plan' in got).toBe(true);
    if (!('plan' in got)) return;
    expect(planRows(got.plan).map(r => r.label)).toEqual(['Service', 'Key']);
    expect(routeEntryText(got.plan)).toBe('');
  });

  it('refuses a route name that is taken', () => {
    const got = planOfForm(form({ route: 'gpt', model: 'gpt-5' }), new Set(['gpt']));
    expect('problems' in got && got.problems[0]).toContain('already exists');
  });
});

describe('applying a plan', () => {
  const plan = (over: Partial<ProviderFormState> = {}) => {
    const got = planOfForm(form({ route: 'gpt', model: 'gpt-5', ...over }), none);
    if (!('plan' in got)) throw new Error('no plan');
    return got.plan;
  };

  it('adds the rules entry, writes the route and stores the key, in that order', async () => {
    const t = io();
    const r = await applyProvider(plan(), '  sk-test  ', t.api);
    expect(t.calls).toEqual(['read', 'addProvider', 'write', 'secret:dispatch.gpt']);
    expect(JSON.parse(t.state.routes!).routes.gpt).toMatchObject({ model: 'openai/gpt-5', adapter: 'openai-api' });
    expect(r.done).toEqual(['the route gpt', 'openai/gpt-5 in the rules', 'a key for the gpt route']);
    expect(r.next).toEqual(['Open Model rules and confirm openai/gpt-5. It cannot run until its rules are confirmed.', 'Test the route gpt on the Routes page.']);
  });

  it('keeps what routes.json already holds', async () => {
    const t = io('{"other":1,"routes":{"luna":{"model":"codex/luna","adapter":"codex-exec"}}}');
    await applyProvider(plan(), 'k', t.api);
    const written = JSON.parse(t.state.routes!);
    expect(written.other).toBe(1);
    expect(Object.keys(written.routes)).toEqual(['luna', 'gpt']);
  });

  it('with no key, still adds everything and says which key is missing', async () => {
    const t = io();
    const r = await applyProvider(plan(), '', t.api);
    expect(t.calls).toEqual(['read', 'addProvider', 'write']);
    expect(r.missing).toEqual(['dispatch.gpt']);
    expect(r.next.at(-1)).toBe('Save the key for the gpt route.');
  });

  it('changes nothing when routes.json cannot be used or the route name is taken', async () => {
    const bad = io('{nope');
    await expect(applyProvider(plan(), 'k', bad.api)).rejects.toThrow('not valid JSON');
    expect(bad.calls).toEqual(['read']);
    const taken = io('{"routes":{"gpt":{"model":"x/y","adapter":"codex-exec"}}}');
    await expect(applyProvider(plan(), 'k', taken.api)).rejects.toThrow('already exists');
    expect(taken.calls).toEqual(['read']);
  });

  it('stores the Jev key through the engine and writes no route', async () => {
    const t = io();
    const got = planOfForm(form({ kind: 'typesafe' }), none);
    if (!('plan' in got)) throw new Error('no plan');
    const r = await applyProvider(got.plan, 'jev-key', t.api);
    expect(t.calls).toEqual(['addProvider', 'provider-key:jev.apiKey']);
    expect(r.done).toEqual(['the Jev provider turned on', 'a key for the Jev provider']);
    expect(r.next).toEqual([]);
  });

  it('turns on the OpenRouter balance reading and stores both keys', async () => {
    const t = io();
    const r = await applyProvider(plan({ kind: 'openrouter' }), 'or-key', t.api);
    expect(t.calls).toEqual(['read', 'addProvider', 'write', 'secret:dispatch.gpt', 'provider-key:openrouter.apiKey']);
    expect(r.done).toContain('the OpenRouter balance reading turned on');
  });
});
