import { emptyPolicy, migrateConfig } from '@augur/core';
import { describe, expect, it } from 'vitest';
import { renderRules, type RulesModel } from '../src/views/rules';

const model = (sel: RulesModel['sel']): RulesModel => ({
  config: migrateConfig({}), held: [], providers: [{ id: 'codex', name: 'Codex', metered: true }], plugins: new Map(), snapshot: null, dark: false, policyError: null, sel, query: '', filter: 'all', open: new Set(),
  picked: new Set(), showHistory: false, addError: '', note: '', bulkTier: '', bulkField: 'cost', bulkValue: '', preview: null, dialOpen: false, dialEnd: '', dialCustom: '', dialPlan: null, dialError: '', pauseMode: 'off', pauseWeights: {},
  catalog: {}, listing: new Set(), canList: false });

const options = (html: string, id: string) => {
  const start = html.indexOf(`<select id="${id}"`);
  const block = html.slice(start, html.indexOf('</select>', start));
  return [...block.matchAll(/<option[^>]*>([^<]*)</g)].map((m) => m[1]);
};

describe('a provider\'s default selects', () => {
  it('list each value once and select the fallback when nothing is set', () => {
    const html = renderRules(model({ provider: 'codex', model: null }));
    expect(options(html, 'r-dataTier')).toEqual(['Public', 'Internal', 'Sensitive', 'Regulated']);
    expect(html).toMatch(/<option value="public" selected/);
    expect(options(html, 'r-askFirst')).toEqual(['Yes', 'No']);
  });
});

describe('model confirmation', () => {
  it('shows every request host before Confirm and omits destinations for models without one', () => {
    const m = model({ provider: 'codex', model: 'codex/new' });
    m.config.policy = emptyPolicy();
    m.config.policy.providers.codex = { defaults: {}, models: { 'codex/new': { id: 'new', source: 'manual', status: 'unreviewed', rule: {}, firstSeen: '' } } };
    m.destinations = { 'codex/new': ['api.example:8443', 'other.example'] };
    const html = renderRules(m);
    expect(html).toContain('Requests for this model go to api.example:8443, other.example.');
    expect(html.indexOf('Requests for this model go to')).toBeLessThan(html.indexOf('data-value="confirmed"'));
    m.destinations = {};
    expect(renderRules(m)).not.toContain('Requests for this model go to');
    m.destinations = null;
    expect(renderRules(m)).toMatch(/data-value="confirmed"[^>]*disabled/);
  });
});
