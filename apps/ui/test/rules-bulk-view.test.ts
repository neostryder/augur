import { emptyPolicy, migrateConfig } from '@augur/core';
import { describe, expect, it } from 'vitest';
import { renderRules, type RulesModel } from '../src/views/rules';
import type { BulkPreview } from '@augur/view-model';

const model = (over: Partial<RulesModel> = {}): RulesModel => ({
  config: migrateConfig({}), held: [], providers: [], plugins: new Map(), snapshot: null, dark: false, policyError: null, sel: null, query: '', filter: 'all', open: new Set(),
  picked: new Set(['codex|codex/sol']), showHistory: false, addError: '', note: '', bulkTier: '', bulkField: 'cost', bulkValue: '', preview: null, dialOpen: false, dialEnd: '', dialCustom: '', dialPlan: null, dialError: '', pauseMode: 'off', pauseWeights: {},
  catalog: {}, listing: new Set(), canList: false, ...over });

describe('the bulk bar', () => {
  it('shows every selected unreviewed model destination before Confirm, including multiple routes', () => {
    const m = model({ picked: new Set(), destinations: {} });
    m.config.policy = emptyPolicy();
    const models = m.config.policy.providers.codex = { defaults: {}, models: {} };
    for (let i = 0; i < 12; i++) {
      const label = `codex/new-${i}`;
      models.models[label] = { id: `new-${i}`, source: 'manual', status: 'unreviewed', rule: {}, firstSeen: '' };
      m.picked.add(`codex|${label}`);
      m.destinations![label] = [`api${i}.example:8443`];
    }
    m.destinations!['codex/new-0']!.push('other.example');
    const html = renderRules(m), confirm = html.indexOf('data-bulk="confirmed"');
    for (let i = 0; i < 12; i++) {
      expect(html.indexOf(`codex/new-${i}</b>`)).toBeLessThan(confirm);
      expect(html.indexOf(`api${i}.example:8443`)).toBeGreaterThan(0);
      expect(html.indexOf(`api${i}.example:8443`)).toBeLessThan(confirm);
    }
    expect(html).toContain('Requests for this model go to api0.example:8443, other.example.');
  });

  it('disables confirmation when routes could not be read', () => {
    const html = renderRules(model({ destinations: null }));
    expect(html).toContain('Could not load the route list, so the Confirm buttons are off. Try again.');
    expect(html).toMatch(/data-bulk="confirmed"[^>]*disabled/);
  });

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

describe('the dial-back card', () => {
  it('opens from the header and offers a custom time when no reset can be trusted', () => {
    expect(renderRules(model())).toContain('data-action="rules-dial"');
    expect(renderRules(model())).not.toContain('Dial back usage');
    const open = renderRules(model({ dialOpen: true }));
    expect(open).toContain('Dial back usage');
    expect(open).toContain('data-dial-custom');
  });

  it('shows the plan with Apply only when something would change', () => {
    const plan = { until: '2026-10-04T17:00:00.000Z', skipped: 3, items: [{ provider: 'codex', label: 'codex/sol', path: 'codex|codex/sol|pause', action: 'stop' as const }] };
    const html = renderRules(model({ dialOpen: true, dialPlan: plan }));
    expect(html).toContain('1 model changes.');
    expect(html).toContain('codex/sol</b> stops');
    expect(html).toContain('3 left alone');
    expect(html).toContain('data-dial="apply"');
    expect(renderRules(model({ dialOpen: true, dialPlan: { ...plan, items: [] } }))).not.toContain('data-dial="apply"');
  });
});
