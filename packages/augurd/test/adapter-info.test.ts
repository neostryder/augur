import { ADAPTER_INFO, adapterInfo } from '@augur/dispatch-protocol';
import type { RouteConfig } from '@augur/dispatch-protocol';
import { describe, expect, it } from 'vitest';
import { ALL_ADAPTERS } from '../src/adapters/index.js';

const route = (adapter: string, options: Record<string, string | number | boolean>): RouteConfig => ({ model: 'test/model', adapter, options });

describe('adapter info', () => {
  it('describes every adapter the service can run, and nothing else', () => {
    expect(ADAPTER_INFO.map(a => a.id).sort()).toEqual(ALL_ADAPTERS.map(a => a.id).sort());
    for (const a of ADAPTER_INFO) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(new Set(a.options.map(o => o.key)).size).toBe(a.options.length);
      for (const o of a.options.filter(x => x.kind === 'choice')) expect(o.choices?.length).toBeGreaterThan(1);
    }
  });

  it('marks as required exactly the options an adapter refuses to run without', () => {
    for (const adapter of ALL_ADAPTERS) {
      const info = adapterInfo(adapter.id)!;
      const required = info.options.filter(o => o.required);
      if (!required.length) expect(adapter.validate(route(adapter.id, {}))).toBeNull();
      else expect(adapter.validate(route(adapter.id, {}))).not.toBeNull();
    }
  });

  it('names the missing option when a required one is left out of an API or command route', () => {
    const sample: Record<string, string> = { baseUrl: 'https://api.example.com/v1', model: 'm', apiKeyEnv: 'KEY', command: 'cmd.exe' };
    for (const id of ['openai-api', 'anthropic-api', 'exec']) {
      const adapter = ALL_ADAPTERS.find(a => a.id === id)!;
      const required = adapterInfo(id)!.options.filter(o => o.required).map(o => o.key);
      const full = Object.fromEntries(required.map(k => [k, sample[k]!]));
      expect(adapter.validate(route(id, full))).toBeNull();
      for (const key of required) {
        const { [key]: _left, ...rest } = full;
        expect(adapter.validate(route(id, rest)), `${id} without ${key}`).toContain(key);
      }
    }
  });
});
