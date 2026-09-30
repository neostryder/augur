import { migrateConfig } from '@augur/core';
import { describe, expect, it } from 'vitest';
import { renderRules, type RulesModel } from '../src/views/rules';
import type { BulkPreview } from '../src/rules-bulk';

const model = (over: Partial<RulesModel> = {}): RulesModel => ({
  config: migrateConfig({}), providers: [], plugins: new Map(), snapshot: null, dark: false, policyError: null, sel: null, query: '', filter: 'all', open: new Set(),
  picked: new Set(['codex|codex/sol']), showHistory: false, addError: '', note: '', bulkTier: '', bulkField: 'cost', bulkValue: '', preview: null, pauseMode: 'off', pauseWeights: {},
  catalog: {}, listing: new Set(), canList: false, ...over });

describe('the bulk bar', () => {
  it('offers a field, its value and a preview, and applies nothing until the list is shown', () => {
    const html = renderRules(model());
    expect(html).toContain('data-bulk-field');
    expect(html).toContain('data-bulk="preview"');
    expect(html).not.toContain('data-bulk="apply-field"');
  });

  it('draws the value control that fits the chosen field', () => {
    expect(renderRules(model({ bulkField: 'askFirst' }))).toMatch(/data-bulk-value[^>]*>[\s\S]*value="yes"/);
    expect(renderRules(model({ bulkField: 'effort' }))).toContain('type="text" id="r-bulk-value"');
    expect(renderRules(model({ bulkField: 'cost' }))).toContain('Very high');
  });

  it('lists what would change, with an Apply button, and closes with nothing to change', () => {
    const preview: BulkPreview = { field: 'cost', value: 'cheap', unchanged: 1, changes: [{ provider: 'codex', label: 'codex/sol', path: 'codex|codex/sol|cost', from: 'high', to: 'cheap' }] };
    const html = renderRules(model({ preview }));
    expect(html).toContain('1 model changes to Cheap.');
    expect(html).toContain('codex/sol');
    expect(html).toContain('High to Cheap');
    expect(html).toContain('data-bulk="apply-field"');
    const none = renderRules(model({ preview: { ...preview, changes: [] } }));
    expect(none).toContain('Nothing to change.');
    expect(none).not.toContain('data-bulk="apply-field"');
  });
});
