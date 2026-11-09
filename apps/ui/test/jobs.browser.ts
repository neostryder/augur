import { defaultConfig, type Shell } from '@augur/core';
import { LedgerModel } from '@augur/view-model';
import { LEDGER_STATES, type LedgerJob, type LedgerQuery } from '@augur/dispatch-protocol';
import { App } from '../src/app';
import '../src/styles.css';

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
let dispose = () => {};

export async function prepare(theme = 'light'): Promise<void> {
  dispose(); document.body.replaceChildren(); document.body.className = 'served'; document.documentElement.dataset.theme = theme;
  const root = document.createElement('main'), tip = document.createElement('div'); root.id = 'app'; document.body.append(root, tip);
  const now = Date.now();
  const base: LedgerJob = { id: 'eru:1', node: 'eru', localId: '1', kind: 'llm-request', state: 'running', stamp: { sessionId: 'review-42', sessionTitle: 'Review release notes', origin: 'cli', originLabel: 'Terminal', pid: 812 }, attribution: { session: 'stamped', origin: 'stamped', process: 'stamped', host: 'unknown' }, summary: 'Review release metadata', summarySource: 'caller', route: 'local', model: 'local', activity: 'research', createdAt: now - 8000, startedAt: now - 2000, endedAt: null, durationMs: null, updatedAt: now, lastActivityAt: now - 1000, activityLine: 'Output activity', parentId: null, retryOf: null, retriedAs: null, usage: null, exitReason: null, compacted: false };
  const jobs = [base, { ...base, id: 'eru:2', localId: '2', summary: 'Download reference data', kind: 'download' as const, state: 'stalled' as const, activityLine: 'Waiting for bytes' }, { ...base, id: 'bilbo:3', node: 'bilbo', localId: '3', summary: 'Index archive metadata', state: 'done' as const, stamp: { sessionId: 'archive', origin: 'service' as const }, startedAt: now - 60000, endedAt: now - 30000, durationMs: 30000, compacted: true }];
  const queries: LedgerQuery[] = [];
  const matches = (job: LedgerJob, q: LedgerQuery) => (!q.session || q.session === job.stamp.sessionId) && (!q.state || q.state.includes(job.state)) && (!q.kind || q.kind.includes(job.kind)) && (!q.node || q.node === job.node) && (!q.origin || q.origin === job.stamp.origin) && (!q.route || q.route === job.route) && (!q.text || job.summary.toLowerCase().includes(q.text.toLowerCase())) && (!q.from || job.createdAt >= q.from) && (!q.to || job.createdAt <= q.to);
  let offline = false;
  const shell = { kind: 'pwa', served: true, host: { platform: 'browser' }, ledgerCall: async (method: string, params: LedgerQuery & { id?: string }) => {
    if (offline) throw new Error('The ledger connection is offline.');
    if (method === 'ledger_list') { queries.push(params); return { jobs: jobs.filter(job => matches(job, params)), next: null }; }
    if (method === 'ledger_counts') return Object.fromEntries(LEDGER_STATES.map(state => [state, jobs.filter(job => job.state === state && matches(job, params)).length]));
    if (method === 'ledger_nodes') return [{ node: 'eru', cursor: '2', lastSeenAt: now, unreachableSince: null, gap: { at: now, from: '0', to: '1', retentionDays: 7 } }, { node: 'bilbo', cursor: '3', lastSeenAt: now - 30000, unreachableSince: now - 10000 }];
    if (method === 'ledger_changes') return { changes: [], cursor: '3', more: false };
    if (method === 'ledger_get') return { job: jobs.find(job => job.id === params.id), parent: null, children: [], retries: [] };
    return null;
  } } as unknown as Shell;
  const app = new App(shell, root, tip) as any;
  Object.assign(app, { config: defaultConfig(), view: 'jobs' });
  app.jobs.ledger = new LedgerModel('review-42', () => app.drawJobs());
  app.wireEvents(); await app.enterJobs(); await settle();
  dispose = () => { app.leaveJobs(); app.view = 'dashboard'; root.remove(); tip.remove(); };
  Object.assign(window, { ledgerFixture: { app, root, queries, offline: (value: boolean) => { offline = value; } } });
}

export async function exercise(): Promise<string> {
  await prepare();
  const { app, root, queries, offline } = (window as any).ledgerFixture;
  const q = (selector: string): HTMLElement => { const element = root.querySelector(selector); if (!element) throw new Error('Missing ' + selector); return element; };
  check(q('.ledger-nodes').textContent!.includes('History gap since '), 'The node history gap was missing.');
  check(root.querySelectorAll('.ledger-row').length === 2, 'The session list included another session.');
  q('[data-action="jobs-scope"][data-value="all"]').click(); await settle();
  check(q('[data-action="jobs-closed"]').getAttribute('aria-expanded') === 'false', 'The closed section started expanded.');
  q('[data-action="jobs-closed"]').click(); await settle();
  check(q('[data-action="jobs-closed"]').getAttribute('aria-expanded') === 'true', 'The closed section did not open.');
  check(root.querySelectorAll('.ledger-row').length === 3, 'All jobs did not include the archive.');
  const filter = async (key: string, value: string) => { const input = q('[data-ledger-filter="' + key + '"]') as HTMLInputElement; input.focus(); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); await settle(); };
  await filter('state', 'stalled'); check(root.querySelectorAll('.ledger-row').length === 1, 'The state filter did not apply.');
  check((document.activeElement as HTMLElement)?.id === 'ledger-state', 'The filter lost keyboard focus.');
  await filter('state', ''); await filter('kind', 'download'); check(root.querySelectorAll('.ledger-row').length === 1, 'The kind filter did not apply.');
  await filter('kind', ''); await filter('node', 'bilbo'); check(root.querySelectorAll('.ledger-row').length === 1, 'The node filter did not apply.');
  await filter('node', ''); await filter('origin', 'service'); check(root.querySelectorAll('.ledger-row').length === 1, 'The origin filter did not apply.');
  await filter('origin', ''); await filter('route', 'missing'); check(root.textContent.includes('No jobs are running.'), 'The empty state was missing.');
  await filter('route', ''); await filter('session', 'archive'); check(root.querySelectorAll('.ledger-row').length === 1, 'The session filter did not apply.');
  await filter('session', ''); await filter('text', 'download'); check(root.querySelectorAll('.ledger-row').length === 1, 'The text filter did not apply.');
  await filter('text', ''); await filter('from', '2000-01-01T00:00'); await filter('to', '2099-01-01T00:00');
  check(queries.at(-1).from > 0 && queries.at(-1).to > queries.at(-1).from, 'The time filters were not forwarded.');
  const before = q('[data-job-timing="eru:1"]').textContent;
  await new Promise(resolve => setTimeout(resolve, 1100));
  check(q('[data-job-timing="eru:1"]').textContent !== before, 'The elapsed time did not update.');
  q('[data-job="eru:1"]').click(); await settle(); check(root.textContent.includes('Session attribution'), 'The detail did not open.');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); check(app.jobs.ledger.selected === null, 'Escape did not close the detail.');
  offline(true); await app.loadJobs(); await settle(); check(root.textContent.includes('offline'), 'The disconnected state was missing.');
  offline(false); await app.loadJobs(); await settle(); check(!root.textContent.includes('connection is offline'), 'The page did not reconnect.');
  check(!queries.some((query: LedgerQuery) => Object.hasOwn(query, 'prompt')), 'The query included task text.');
  app.shell.kind = 'desktop'; app.shell.served = false;
  await app.openJobNotification('eru:1'); app.onPopupShown(); await settle();
  check(app.view === 'jobs' && app.jobs.ledger.selected === 'eru:1', 'Popup activation replaced the notification job.');
  app.leaveJobs(); return 'ledger browser flows';
}
