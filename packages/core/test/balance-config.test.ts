import { describe, expect, it } from 'vitest';
import { buildPolicyFile, defaultConfig, migrateConfig } from '../src/index.js';

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

describe('the balance profile', () => {
  it('is neutral on a new install and survives loading it back', () => {
    expect(defaultConfig().policy?.balance).toEqual({ profile: 'neutral' });
    const config = migrateConfig(defaultConfig());
    expect(config.policy?.balance).toEqual({ profile: 'neutral' });
    expect(buildPolicyFile(config.policy!, []).balance).toEqual({ profile: 'neutral' });
  });

  it('is left unnamed on an install that already has a config', () => {
    expect(migrateConfig({}).policy?.balance).toBeUndefined();
    expect(migrateConfig({ schema: 1, policy: { schema: 1, providers: {} } }).policy?.balance).toBeUndefined();
  });
});
