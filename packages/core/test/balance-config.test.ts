import { describe, expect, it } from 'vitest';
import { buildPolicyFile, migrateConfig } from '../src/index.js';

// docs/configuring.md says the balance overrides live in config.json under policy.balance and reach policy.json from there.
describe('balance overrides', () => {
  it('stay in the stored config and are written into policy.json', () => {
    const config = migrateConfig({ schema: 1, policy: { schema: 1, providers: {}, balance: { fallback: { aim: 90 }, exclude: ['astra'] } } });
    expect(config.policy?.balance).toEqual({ fallback: { aim: 90 }, exclude: ['astra'] });
    const file = buildPolicyFile(config.policy!, []);
    expect(file.balance).toEqual({ fallback: { aim: 90 }, exclude: ['astra'] });
  });

  it('are left out of policy.json when none are set', () => {
    const file = buildPolicyFile(migrateConfig({}).policy!, []);
    expect('balance' in file).toBe(false);
  });
});
