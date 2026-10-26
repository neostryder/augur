import { describe, expect, it } from 'vitest';
import { defaultConfig, emptyPolicy, migrateConfig } from '@augur/core';
import { balanceReport, surplusWindowStatus } from '@augur/dispatch-protocol';
import { renderBalance } from '../src/views/balance';
import { renderDashboard } from '../src/views/dashboard';
import { renderRules, type RulesModel } from '../src/views/rules';

describe('the balance page', () => {
  it('waits for the service before showing anything', () => {
    const html = renderBalance({ report: null, error: '' });
    expect(html).toContain('Reading the balance report.');
    expect(html).toContain('data-value="balance"');
  });

  it('shows the report in the same groups as the command', () => {
    const report = balanceReport(emptyPolicy() as never, null, new Date('2026-10-04T12:00:00Z'));
    const html = renderBalance({ report, error: '' });
    expect(html).toContain('Copilot');
    expect(html).toContain('Never picked');
    expect(html).toContain('What each kind of work goes to now');
    expect(html).toContain('Balance report, 2026-10-04 12:00 UTC');
  });

  it('shows the service error and escapes it', () => {
    const html = renderBalance({ report: null, error: '<b>no policy</b>' });
    expect(html).toContain('&lt;b&gt;no policy&lt;/b&gt;');
    expect(html).toContain('role="alert"');
  });
});

describe('the dashboard gate row', () => {
  it('shows the service surplus window wording', () => {
    const config = defaultConfig();
    config.providers = [{ id: 'claude', enabled: true, settings: {} }];
    const snapshot = { generatedAt: '2026-10-04T12:00:00Z', providers: { claude: { id: 'claude', name: 'Claude', ok: true, stale: false, error: null, plan: null, detail: '', meters: [], money: [], fetchedAt: '2026-10-04T12:00:00Z', links: {}, notes: {} } } } as never;
    const window = surplusWindowStatus({ open: false, spent: false, budgetLeft: 0, hoursLeft: 12, unused: 0 }, { hours: 12, open: 10 });
    const html = renderDashboard({ config, snapshot, history: [], plugins: new Map(), busy: false, twoColumns: false, expanded: null, dark: false, shellKind: 'desktop', gates: [{ provider: 'claude', state: 'closed', gap: null, close: 10, window, labels: ['claude/opus'] }] });
    expect(html).toContain(window);
  });
  it('lists premium tasks that wait for approval with an Approve button each, and the last failure', () => {
    const config = defaultConfig();
    config.providers = [{ id: 'claude', enabled: true, settings: {} }];
    const snapshot = { generatedAt: '2026-10-04T12:00:00Z', providers: {} } as never;
    const awaiting = [{ id: 'bk1', task: 'refactor the parser', route: 'claude/opus', estimate: 3, requester: 'agent-7', deadline: null }];
    const html = renderDashboard({ config, snapshot, history: [], plugins: new Map(), busy: false, twoColumns: false, expanded: null, dark: false, shellKind: 'desktop', awaiting, awaitingNote: 'Item bk1 expired.' });
    expect(html).toContain('refactor the parser (agent-7 wants claude/opus, about 3 points)');
    expect(html).toContain('data-action="backlog-approve" data-backlog="bk1"');
    expect(html).toContain('Item bk1 expired.');
    expect(renderDashboard({ config, snapshot, history: [], plugins: new Map(), busy: false, twoColumns: false, expanded: null, dark: false, shellKind: 'desktop' })).not.toContain('backlog-approve');
  });
});

describe('stance chips on the rules page', () => {
  const base = (stances?: Record<string, string>): RulesModel => ({
    config: migrateConfig({}), held: [], providers: [{ id: 'codex', name: 'Codex', metered: true }], plugins: new Map(), snapshot: null, dark: false, policyError: null, sel: null, query: '', filter: 'all', open: new Set(),
    picked: new Set(), showHistory: false, addError: '', note: '', bulkTier: '', bulkField: 'cost', bulkValue: '', preview: null, dialOpen: false, dialEnd: '', dialCustom: '', dialPlan: null, dialError: '', pauseMode: 'off', pauseWeights: {},
    catalog: {}, listing: new Set(), canList: false, ...(stances ? { stances } : {}) });

  it('names the balance stance of a provider once it is known', () => {
    expect(renderRules(base({ codex: 'backup' }))).toContain('Backup, used last');
    expect(renderRules(base())).not.toContain('Backup, used last');
  });
});
