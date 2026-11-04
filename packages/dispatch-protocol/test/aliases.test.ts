import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { PolicyFile } from '@augur/core';
import { lookup, nameMatches, resolveLabel } from '../src/balance.js';
import { matchNamedModels, rank } from '../src/pick.js';

const now = new Date('2026-10-01T00:00:00Z');

/** A policy whose Sonnet used to be `claude/claude-sonnet-5-5`, and whose Opus has an alias too. */
function policy(): PolicyFile {
  const stored = emptyPolicy();
  importPolicy(stored, { providers: { claude: {
    defaults: { askFirst: false, dataTier: 'internal', output: 'write_files' },
    models: {
      'claude/sonnet': { id: 'claude-sonnet-5-5', rule: { cost: 'moderate', activities: { write_code: 'normal' } } },
      'claude/opus': { id: 'claude-opus-5-5', rule: { cost: 'very_high', activities: { write_code: 'preferred' } } },
    },
  } } }, now);
  for (const label of ['claude/sonnet', 'claude/opus']) setField(stored, fieldPath('claude', label, 'status'), 'confirmed', 'test', now);
  stored.providers.claude!.models['claude/sonnet']!.aliases = ['claude/claude-sonnet-5-5'];
  stored.providers.claude!.models['claude/opus']!.aliases = ['claude/live'];
  return buildPolicyFile(stored, [{ id: 'claude', name: 'Claude', metered: true }], now);
}

describe('earlier labels', () => {
  const ref = { label: 'claude/sonnet', provider: 'claude', id: 'claude-sonnet-5-5', aliases: ['claude/claude-sonnet-5-5'] };

  it('still name a model in a rule', () => {
    expect(nameMatches('claude/claude-sonnet-5-5', ref)).toBe(true);
    expect(nameMatches('claude/*sonnet*', ref)).toBe(true);
    expect(nameMatches('claude/claude-sonnet-5-5', { ...ref, aliases: undefined })).toBe(true); // the standard name is the same here
    expect(nameMatches('claude/live', ref)).toBe(false);
    expect(lookup({ 'claude/claude-sonnet-5-5': 'light' }, { ...ref, id: 'sonnet' })).toBe('light');
    expect(lookup({ 'claude/sonnet': 'strong', 'claude/claude-sonnet-5-5': 'light' }, ref)).toBe('strong');
  });

  it('resolve to the current label', () => {
    const file = policy();
    expect(resolveLabel(file, 'claude/claude-sonnet-5-5')).toBe('claude/sonnet');
    expect(resolveLabel(file, 'claude/live')).toBe('claude/opus');
    expect(resolveLabel(file, 'claude/sonnet')).toBe('claude/sonnet');
    expect(resolveLabel(file, 'gemini/web')).toBeNull();
  });

  it('name a model typed in a message', () => {
    expect(matchNamedModels(policy(), 'use claude/live for this')).toContain('claude/opus');
  });

  it('are accepted when a pick names the model', () => {
    const file = policy();
    const result = rank(file, null, { activity: 'write_code', dataTier: 'internal', named: 'claude/live' });
    expect(result.ranking.some(r => r.model === 'claude/opus')).toBe(true);
  });
});
