import { describe, expect, it } from 'vitest';
import { buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { RouteConfig } from '@augur/dispatch-protocol';
import { withCurrentLabels } from '../src/sources.js';

const now = new Date('2026-10-01T00:00:00Z');
function policy() {
  const stored = emptyPolicy();
  importPolicy(stored, { providers: { copilot: { defaults: { dataTier: 'internal' }, models: { 'copilot/opus': { id: 'claude-opus-5.5', rule: {} } } } } }, now);
  setField(stored, fieldPath('copilot', 'copilot/opus', 'status'), 'confirmed', 'test', now);
  stored.providers.copilot!.models['copilot/opus']!.aliases = ['copilot/claude-opus-5.5'];
  return buildPolicyFile(stored, [{ id: 'copilot', name: 'Copilot', metered: true }], now);
}
const route = (model: string): RouteConfig => ({ model, adapter: 'copilot-exec', options: { model: 'claude-opus-5.5' } });

describe('route labels', () => {
  it('follow a renamed model and leave the route name and options alone', () => {
    const routes = withCurrentLabels({ 'copilot-opus': route('copilot/claude-opus-5.5'), other: route('mystery/model') }, policy());
    expect(routes!['copilot-opus']).toEqual(route('copilot/opus'));
    expect(routes!.other!.model).toBe('mystery/model');
  });
  it('pass through when there is no policy yet', () => {
    const only = { a: route('copilot/claude-opus-5.5') };
    expect(withCurrentLabels(only, null)).toBe(only);
    expect(withCurrentLabels(null, policy())).toBeNull();
  });
});
