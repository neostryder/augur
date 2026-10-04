import { describe, expect, it } from 'vitest';
import { defaultConfig } from '@augur/core';
import { CUSTOM_TEXT, parseCustom, parsePercents, refreshDefault } from '../src/settings.js';

describe('settings checks', () => {
  it('reads percentages in order, dropping anything outside 1 to 100', () => {
    expect(parsePercents('95, 50 x 120 0')).toEqual([50, 95]);
    expect(parsePercents('')).toEqual([]);
  });

  it('accepts custom definitions only as a complete list with unused ids', () => {
    const config = defaultConfig();
    const def = { id: 'mine', name: 'Mine', auth: { type: 'none' }, requests: { main: { url: 'https://x' } } };
    expect(parseCustom('{', config)).toEqual({ error: CUSTOM_TEXT.notList });
    expect(parseCustom('{}', config)).toEqual({ error: CUSTOM_TEXT.notList });
    expect(parseCustom('[{"id":"mine"}]', config)).toEqual({ error: CUSTOM_TEXT.incomplete });
    expect(parseCustom(JSON.stringify([{ ...def, id: 'claude' }]), config)).toEqual({ error: CUSTOM_TEXT.clash('claude') });
    expect(parseCustom(JSON.stringify([def]), config)).toEqual({ custom: [def] });
  });

  it("names the default refresh after the provider's own interval", () => {
    expect(refreshDefault(3600)).toBe('Default (1 hour)');
    expect(refreshDefault(120)).toBe('Default (2 min)');
  });
});
