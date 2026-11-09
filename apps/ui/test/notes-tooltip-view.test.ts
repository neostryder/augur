import { describe, expect, it } from 'vitest';
import { defaultConfig, type ProviderSnapshot, type Snapshot } from '@augur/core';
import { renderDashboard } from '../src/views/dashboard';

const base = { ok: true, stale: false, error: null, plan: null, fetchedAt: null, meters: [], money: [] };
const render = (p: ProviderSnapshot, gates?: Parameters<typeof renderDashboard>[0]['gates']) => {
  const config = defaultConfig();
  config.providers = [{ id: p.id, enabled: true, settings: {} }];
  const snapshot: Snapshot = { schema: 1, generatedAt: '', providers: { [p.id]: p } };
  return renderDashboard({ config, snapshot, history: [], plugins: new Map(), busy: false, twoColumns: false, expanded: null, dark: false, shellKind: 'desktop', gates });
};

describe('card notes and tooltips', () => {
  it('keeps resets and sign-in prompts visible and puts background notes behind an info mark', () => {
    const html = render({ ...base, id: 'claude', name: 'Claude', notes: { resetsAvailable: 1, resetsSignIn: true, latencyMs: 200 } });
    expect(html).toContain('1 limit reset available');
    expect(html).toContain('Sign in to claude.ai in settings');
    expect(html).toContain('<span class="info" role="img" tabindex="0" title="Answered in 200 ms"');
    expect(html).not.toContain('Answered in 200 ms</div>');
  });

  it('shows only the info mark when every note is background', () => {
    const html = render({ ...base, id: 'openai-api', name: 'OpenAI API', notes: { openaiBillingForbidden: true } });
    expect(html).toMatch(/<div class="notes"><span class="info"[^>]*title="This account cannot read organization billing/);
  });

  it('moves the list of gated models into the gate line tooltip', () => {
    const html = render({ ...base, id: 'claude', name: 'Claude', notes: null }, [{ provider: 'claude', state: 'closed', gap: -21, window: 'window opens in 127h', close: 0, labels: ['claude/opus'] }]);
    expect(html).toContain('title="Gated: claude/opus"');
    expect(html).toContain('Closed, -21 points behind pace; window opens in 127h</span>');
    expect(html).not.toContain('gated claude/opus');
  });
});
