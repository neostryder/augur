import { emptyPolicy, setField, fieldPath } from '@augur/core';
import type { PolicyConfig } from '@augur/core';
import { describe, expect, it } from 'vitest';
import { BULK_FIELDS, parseBulkValue, previewBulk } from '../src/rules-bulk';
import type { BulkPreview } from '../src/rules-bulk';

const policy = (): PolicyConfig => {
  const p = emptyPolicy();
  p.providers.codex = { defaults: {}, models: {
    'codex/sol': { id: 'sol', source: 'manual', status: 'confirmed', rule: { cost: 'high', askFirst: true }, firstSeen: '2026-09-29T00:00:00.000Z' },
    'codex/luna': { id: 'luna', source: 'manual', status: 'confirmed', rule: {}, firstSeen: '2026-09-29T00:00:00.000Z' } } };
  p.providers.grok = { defaults: {}, models: { 'xai/grok': { id: 'grok', source: 'manual', status: 'confirmed', rule: { cost: 'moderate' }, firstSeen: '2026-09-29T00:00:00.000Z' } } };
  return p;
};
const field = (name: string) => BULK_FIELDS.find((f) => f.field === name)!;

describe('previewing a bulk edit', () => {
  it('lists the models whose own value would change and counts the ones already there', () => {
    const r = previewBulk(policy(), ['codex|codex/sol', 'codex|codex/luna', 'grok|xai/grok'], 'cost', 'moderate') as BulkPreview;
    expect(r.changes.map((c) => c.label)).toEqual(['codex/sol', 'codex/luna']);
    expect(r.unchanged).toBe(1);
    expect(r.changes[0]).toMatchObject({ from: 'high', to: 'moderate', path: fieldPath('codex', 'codex/sol', 'cost') });
    expect(r.changes[1]!.from).toBeUndefined();
  });

  it('treats an empty value as clearing the field, so models follow their provider again', () => {
    const r = previewBulk(policy(), ['codex|codex/sol', 'codex|codex/luna'], 'cost', '') as BulkPreview;
    expect(r.value).toBeUndefined();
    expect(r.changes.map((c) => c.label)).toEqual(['codex/sol']);
    expect(r.unchanged).toBe(1);
  });

  it('turns yes and no into booleans and refuses a value the menu could not offer', () => {
    expect(parseBulkValue(field('askFirst'), 'yes')).toEqual({ ok: true, value: true });
    expect(parseBulkValue(field('sandbox'), 'no')).toEqual({ ok: true, value: false });
    expect(parseBulkValue(field('askFirst'), 'maybe')).toMatchObject({ ok: false });
    expect(previewBulk(policy(), ['codex|codex/sol'], 'dataTier', 'top secret')).toHaveProperty('error');
    expect(previewBulk(policy(), ['codex|codex/sol'], 'output', 'patch_only')).toMatchObject({ changes: [{ to: 'patch_only' }] });
  });

  it('skips a picked model that no longer exists and changes nothing until applied', () => {
    const p = policy();
    const r = previewBulk(p, ['codex|codex/gone', 'codex|codex/luna'], 'effort', ' high ') as BulkPreview;
    expect(r.changes.map((c) => c.label)).toEqual(['codex/luna']);
    expect(r.value).toBe('high');
    expect(p.providers.codex!.models['codex/luna']!.rule.effort).toBeUndefined();
    for (const c of r.changes) setField(p, c.path, r.value, 'desktop');
    expect(p.providers.codex!.models['codex/luna']!.rule.effort).toBe('high');
  });
});
