import { describe, expect, it } from 'vitest';
import { BALANCE_FIELDS, checkBalanceSetting } from '../src/index.js';

describe('checking a balance setting edit', () => {
  it('accepts a documented setting with a value of its kind', () => {
    for (const [path, value] of [[['profile'], 'neutral'], [['enabled'], false], [['tilt', 'deep', 'strong'], 1.3], [['tiers', 'codex/gpt-6.1-sol'], 'strong'], [['exclude'], ['preview']],
      [['claude', 'reserve'], 85], [['prefer', 'codex/sol', 'review_code'], 1.2], [['seats', 'second', 'skip'], ['bulk_tagging']], [['fallback', 'cap'], 0], [['seats', 'shadow'], 'laya/laya']] as const)
      expect(checkBalanceSetting(path, value), path.join('.')).toBeNull();
  });
  it('takes inherit anywhere and null only for one entry of a map', () => {
    expect(checkBalanceSetting(['tilt', 'deep', 'strong'], 'inherit')).toBeNull();
    expect(checkBalanceSetting(['tiers', 'a/b'], null)).toBeNull();
    expect(checkBalanceSetting(['prefer', 'a/b'], null)).toBeNull();
    expect(checkBalanceSetting(['claude', 'band'], null)).toMatch(/cannot be removed/);
  });
  it('refuses an unknown path, an unknown activity and a value of the wrong kind', () => {
    expect(checkBalanceSetting(['tilt', 'deep'], 1)).toMatch(/not a balance setting/);
    expect(checkBalanceSetting(['depth', 'cooking'], 'deep')).toMatch(/not a balance setting/);
    expect(checkBalanceSetting(['profile'], 'wild')).toMatch(/classic, neutral/);
    expect(checkBalanceSetting(['enabled'], 'false')).toMatch(/true, false|one of/);
    expect(checkBalanceSetting(['tilt', 'deep', 'light'], 0)).toMatch(/above 0/);
    expect(checkBalanceSetting(['claude', 'reserve'], 120)).toMatch(/percent/);
    expect(checkBalanceSetting(['seats', 'second', 'skip'], ['cooking'])).toMatch(/activities/);
    expect(checkBalanceSetting(['exclude'], 'preview')).toMatch(/list/);
  });
  it('knows every documented setting', () => {
    const sample = (p: string) => p.split('.').map(s => s === '<route>' ? 'a/b' : s === '<activity>' ? 'review_code' : s);
    for (const f of BALANCE_FIELDS) expect(checkBalanceSetting(sample(f.path), 'inherit'), f.path).toBeNull();
  });
});
