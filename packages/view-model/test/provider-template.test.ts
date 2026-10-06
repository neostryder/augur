import { describe, expect, it } from 'vitest';
import { planProvider } from '../src/provider-template.js';
import type { ProviderPlan } from '../src/provider-template.js';

const none = new Set<string>();
const plan = (input: Parameters<typeof planProvider>[0], existing = none): ProviderPlan => {
  const p = planProvider(input, existing);
  if ('problems' in p) throw new Error(p.problems.join(' | '));
  return p;
};
const problems = (input: Parameters<typeof planProvider>[0], existing = none): string => {
  const p = planProvider(input, existing);
  return 'problems' in p ? p.problems.join(' | ') : '';
};

describe('planProvider with an OpenAI preset', () => {
  it('takes the published base URL and makes a route that keeps its key in the store', () => {
    const p = plan({ kind: 'openai', route: 'gpt', model: 'gpt-5' });
    expect(p.route).toEqual({ name: 'gpt', entry: { model: 'openai/gpt-5', adapter: 'openai-api', options: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', keySource: 'store' }, notes: 'Added with augur provider add openai.' } });
    expect(p.model).toEqual({ label: 'gpt-5', id: 'gpt-5' });
    expect(p.custom).toBeNull();
    expect(p.keys.map(k => k.secret)).toEqual(['dispatch.gpt']);
  });
  it('lets a flag override the preset address and name the model in the rules', () => {
    const p = plan({ kind: 'openai', route: 'gpt', model: 'gpt-5', baseUrl: 'https://proxy.example.com/v1/', label: 'gpt5-main', maxTokens: '2000' });
    expect(p.route!.entry).toMatchObject({ model: 'openai/gpt5-main', options: { baseUrl: 'https://proxy.example.com/v1', maxTokens: 2000 } });
    expect(p.model).toEqual({ label: 'gpt5-main', id: 'gpt-5' });
  });
});

describe('planProvider with OpenRouter', () => {
  it('uses the built-in balance reading and asks for its key too', () => {
    const p = plan({ kind: 'openrouter', route: 'deepseek', model: 'deepseek/deepseek-v4' });
    expect(p.provider).toBe('openrouter');
    expect(p.custom).toBeNull();
    expect(p.enable).toEqual({ settings: {} });
    expect(p.keys.map(k => [k.secret, k.viaEngine])).toEqual([['dispatch.deepseek', false], ['openrouter.apiKey', true]]);
  });
  it('refuses a balance address for a service that already has one', () => {
    expect(problems({ kind: 'openrouter', route: 'd', model: 'm', balanceUrl: 'https://x.example.com/b', balancePath: '$.a' })).toContain('has its own balance reading built in');
  });
});

describe('planProvider with a shape', () => {
  it('adds a bearer balance reading when the API has a balance address', () => {
    const p = plan({ kind: 'openai-style', route: 'acme', provider: 'acme', model: 'acme-1', baseUrl: 'https://api.acme.example/v1', balanceUrl: 'https://api.acme.example/v1/balance', balancePath: '$.data.balance' });
    expect(p.custom).toMatchObject({ id: 'acme', name: 'acme', auth: { type: 'bearer' }, requests: { balance: { url: 'https://api.acme.example/v1/balance' } }, money: [{ id: 'balance', amount: 'balance:$.data.balance' }] });
    expect(p.keys.map(k => k.secret)).toEqual(['dispatch.acme', 'acme.apiKey']);
  });
  it('builds an Anthropic-style route', () => {
    const p = plan({ kind: 'anthropic', route: 'claude_api', model: 'some-model' });
    expect(p.route!.entry).toMatchObject({ adapter: 'anthropic-api', model: 'anthropic/some-model', options: { baseUrl: 'https://api.anthropic.com' } });
    expect(p.keys[0]!.secret).toBe('dispatch.claude_uapi');
  });
  it('names every missing or bad part in one pass', () => {
    const msg = problems({ kind: 'openai-style', route: 'Bad Name', model: 'two words', baseUrl: 'ftp://x', balanceUrl: 'https://x.example.com' }, new Set());
    expect(msg).toContain('A base URL starts with https://');
    expect(msg).toContain('Name the provider');
    expect(msg).toContain('A route name starts with a lowercase letter');
    expect(msg).toContain('A model id has no spaces');
    expect(msg).toContain('needs both --balance-url and --balance-path');
  });
  it('refuses a route name already taken, a bad path and an unknown template', () => {
    expect(problems({ kind: 'openai', route: 'gpt', model: 'm' }, new Set(['gpt']))).toContain('A route named gpt already exists');
    expect(problems({ kind: 'openai-style', route: 'a', provider: 'a', model: 'm', baseUrl: 'http://localhost:8080/v1', balanceUrl: 'https://x.example.com', balancePath: 'data.balance' })).toContain('--balance-path');
    expect(problems({ kind: 'nothing' })).toContain('"nothing" is not a template');
    expect(plan({ kind: 'openai-style', route: 'local', provider: 'local', model: 'm', baseUrl: 'http://localhost:8080/v1' }).route).not.toBeNull();
  });
});

describe('planProvider with a Jev-style service', () => {
  it('turns the Jev provider on, with a base URL only when it is not TypeSafe', () => {
    expect(plan({ kind: 'typesafe' })).toMatchObject({ provider: 'jev', route: null, model: null, enable: { settings: {} } });
    const own = plan({ kind: 'jev-style', baseUrl: 'https://jev.example.com' });
    expect(own.enable).toEqual({ settings: { baseUrl: 'https://jev.example.com' } });
    expect(own.keys).toEqual([{ secret: 'jev.apiKey', for: 'the Jev provider', viaEngine: true }]);
  });
  it('needs a base URL for a shape and takes no route or model', () => {
    expect(problems({ kind: 'jev-style' })).toContain('needs --base-url');
    expect(problems({ kind: 'typesafe', route: 'x', model: 'y' })).toContain('does not apply to a Jev-style service');
  });
});
