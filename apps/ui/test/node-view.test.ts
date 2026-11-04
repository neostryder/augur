import { describe, expect, it } from 'vitest';
import { emptyPolicy, migrateConfig, type ModelEntry } from '@augur/core';
import { initialNodeState } from '@augur/view-model';
import { renderNodeView, type NodeModel } from '../src/views/node-view';
import { renderRules } from '../src/views/rules';

function model(): NodeModel {
  const config = migrateConfig({}); config.policy = emptyPolicy(); config.policy.balance = { profile: 'neutral' };
  config.policy.providers.openrouter = { defaults: { dataTier: 'regulated', activities: { write_code: 'normal' }, askFirst: false }, models: { 'openrouter/terra': { id: 'gpt-6.1-terra', source: 'manual', status: 'confirmed', firstSeen: '', rule: {} } as ModelEntry } };
  return { config, held: [], providers: [{ id: 'openrouter', name: 'OpenRouter', metered: true }], plugins: new Map(), snapshot: null, dark: true, policyError: null, sel: { provider: 'openrouter', model: 'openrouter/terra' }, query: '', filter: 'all', open: new Set(), picked: new Set(), showHistory: false, addError: '', note: '', bulkTier: '', bulkField: 'cost', bulkValue: '', preview: null, dialOpen: false, dialEnd: '', dialCustom: '', dialPlan: null, dialError: '', pauseMode: 'off', pauseWeights: {}, catalog: {}, listing: new Set(), canList: false, mode: 'node', node: initialNodeState() };
}

describe('node view rendering', () => {
  it('searches full names, provider names and descriptions even for blocked models', () => {
    const m = model(), entry = m.config.policy!.providers.openrouter!.models['openrouter/terra']!;
    entry.name = 'Terra-6.1'; entry.rule.notes = 'Fast code review'; entry.rule.dataTier = 'public';
    for (const query of ['TERRA 6.1', 'OPENROUTER', 'code REVIEW']) {
      m.node.query = query;
      expect(renderNodeView(m)).toContain('data-node-add="openrouter/terra"');
    }
    m.node.query = 'missing';
    expect(renderNodeView(m)).not.toContain('data-node-add="openrouter/terra"');
    expect(renderNodeView(m)).toContain('No models match your search.');
  });
  it('keeps list and history available around the native component', () => {
    const m = model();
    expect(renderRules(m)).toContain('<augur-node-view>');
    expect(renderRules(m)).toContain('data-action="rules-history"');
    m.showHistory = true;
    expect(renderRules(m)).not.toContain('<augur-node-view>');
  });

  it('draws four rings, Regulated inside and Public outside, with a model only in the rings it is cleared for', () => {
    const m = model(), models = m.config.policy!.providers.openrouter!.models;
    models['openrouter/terra']!.rule.dataTier = 'regulated';
    models['openrouter/luna'] = { id: 'gpt-6-luna', source: 'manual', status: 'confirmed', firstSeen: '', rule: { dataTier: 'public', activities: { write_code: 'normal' } } } as ModelEntry;
    const html = renderNodeView(m);
    const order = ['regulated', 'sensitive', 'internal', 'public'].map(tier => html.indexOf(`class="nv-layer nv-layer-${tier}"`));
    expect(order.every(at => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]!)).toBe(true);
    const layer = (tier: string): string => html.slice(html.indexOf(`class="nv-layer nv-layer-${tier}"`)).split('</g></g>')[0]!;
    expect(layer('regulated')).toContain('data-node-select="openrouter/terra"');
    expect(layer('regulated')).not.toContain('openrouter/luna');
    expect(layer('public')).toContain('openrouter/luna');
    expect(html.match(/role="slider"/g)).toHaveLength(2);
    expect(html).toContain('Rings: Regulated (inner) 1 / Sensitive 1 / Internal 1 / Public (outer) 2');
  });

  it('has no data tier selector and calls the view Visual', () => {
    const html = renderNodeView(model());
    expect(html).not.toContain('data-node-gate');
    expect(renderRules(model())).toContain('>Visual<');
    expect(renderRules(model())).not.toContain('Node view');
  });

  it('renders the ring, accessible text equivalent, and five preview stops', () => {
    const html = renderNodeView(model());
    expect(html).toContain('<svg class="nv-ring"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('data-node-level="openrouter|openrouter/terra|activities.write_code"');
    expect(html).toContain('aria-label="In the mix"');
    expect(html).toContain('aria-controls="nv-tab-panel"');
    expect(html.match(/<small>100%<\/small>/g)).toHaveLength(5);
  });

  it('uses the list field paths for clearance and behavior without losing advanced fields', () => {
    const m = model(); m.node.tab = 'data';
    let html = renderNodeView(m);
    expect(html).toContain('data-node-edit="openrouter|openrouter/terra|dataTier"');
    expect(html).toContain('data-rule="openrouter|openrouter/terra|dataHandling.hostCountry"');
    m.config.policy!.providers.openrouter!.models['openrouter/other'] = { id: 'other', source: 'manual', status: 'confirmed', firstSeen: '', rule: {} }; m.node.tab = 'behavior'; html = renderNodeView(m);
    for (const field of ['askFirst', 'output', 'sandbox', 'effort', 'notes']) expect(html).toContain(`data-rule="openrouter|openrouter/terra|${field}"`);
    expect(html).toContain('data-wait="openrouter|openrouter/terra|useAfter"');
    expect(html).toContain('data-node-series');
    expect(html).toContain('data-status="openrouter|openrouter/terra|status"');
  });

  it('offers review for a new entry and the catalog for an empty activity', () => {
    const m = model(); m.config.policy!.providers.openrouter!.models['openrouter/terra']!.status = 'unreviewed';
    const html = renderNodeView(m);
    expect(html).toContain('Confirm rules');
    expect(html).toContain('No models in this mix');
    expect(html).toContain('data-node-copy');
    expect(html).toContain('data-node-add="openrouter/terra"');
  });
});
