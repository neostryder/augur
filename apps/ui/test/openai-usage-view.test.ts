import { describe, expect, it } from 'vitest';
import { defaultConfig, type ProviderSnapshot, type Snapshot } from '@augur/core';
import { renderDashboard } from '../src/views/dashboard';

const days = Array.from({ length: 7 }, (_, day) => ({ date: '2026-11-' + String(day + 2).padStart(2, '0'), spend: day, requests: day }));
const provider: ProviderSnapshot = { id: 'openai-api', name: 'OpenAI API', ok: true, stale: false, error: null, plan: null, fetchedAt: null,
  meters: [], money: [{ id: 'spend', label: 'Spent this month (organization)', amount: 50, currency: 'USD' },
    { id: 'project_spend', label: 'Project spend, last 7 days', amount: 21, currency: 'USD', detail: 'Personal <project>' }],
  notes: { openaiDays: days, openaiWeek: { requests: 21, tokens: 48200 } } };
const render = (p = provider) => {
  const config = defaultConfig();
  config.providers = [{ id: 'openai-api', enabled: true, settings: {} }];
  const snapshot: Snapshot = { schema: 1, generatedAt: '', providers: { 'openai-api': p } };
  return renderDashboard({ config, snapshot, history: [], plugins: new Map(), busy: false, twoColumns: false, expanded: null, dark: false, shellKind: 'desktop' });
};

describe('OpenAI daily spend card', () => {
  it('renders seven spend bars, the project detail and a weekly activity note alongside organization spend', () => {
    const html = render();
    expect(html).toContain('Spent this month (organization)');
    expect(html).toContain('$50.00');
    expect(html).toContain('Project spend, last 7 days');
    expect(html).toContain('$21.00');
    expect(html).toContain('Personal &lt;project&gt;');
    expect(html).toContain('role="img" aria-label="Project spend, last 7 days"');
    expect(html.match(/<rect /g)).toHaveLength(7);
    expect(html).toContain('<title>2026-11-02: $0.00</title>');
    expect(html).toContain('height="18.0"');
    expect(html).toContain('Last 7 days: 21 requests, 48,200 tokens');
  });

  it('omits the strip and activity note without project data', () => {
    const html = render({ ...provider, money: provider.money.slice(0, 1), notes: {} });
    expect(html).toContain('Spent this month (organization)');
    expect(html).not.toContain('<rect ');
    expect(html).not.toContain('Project spend, last 7 days');
    expect(html).not.toContain('Last 7 days:');
  });

  it('renders a zero-spend week without invalid bar dimensions', () => {
    const html = render({ ...provider, notes: { openaiDays: days.map(day => ({ ...day, spend: 0 })) } });
    expect(html.match(/<rect /g)).toHaveLength(7);
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
