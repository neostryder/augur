// The dispatch page has three screens, switched with [ and ]: the jobs agents started, the routes that join a model to the program that runs it,
// and the service's own settings. It reads jobs and routes through the service's own calls, as the window app does, and edits routes.json and
// config.json in the folders the service reads them from.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVITIES } from '@augur/core';
import { routeFile, augurHome, configLines, dataDir, setConfigValue, type ConfigLine } from '@augur/augurd';
import { ADAPTER_INFO, LEDGER_KINDS, LEDGER_STATES, ORIGIN_KINDS, ledgerTerminal, adapterInfo, routeSecretName } from '@augur/dispatch-protocol';
import type { LedgerQuery, LedgerDeliveryState } from '@augur/dispatch-protocol';
import { inset, tabs, type Key, type Rect, type Screen } from '@augur/terminal';
import {
  APPROVAL_LEVELS, APPROVAL_TEXT, CLASSIFIER_TEXT, DISPATCH_TEXT, MODE_TEXT, checkDraft, draftOf, emptyDraft,
  LedgerModel, LEDGER_STATE_LABELS, LEDGER_TEXT, ledgerDuration, ledgerFacts, ledgerTime, type LedgerTransport,
  parseRoutesText, writeRoute, type RouteDraft, type RoutesFile,
  PROVIDER_CHOICES, PROVIDER_FORM_TEXT, applyProvider, emptyProviderForm, planOfForm, planRows, providerFields, routeEntryText, type ProviderFormState,
} from '@augur/view-model';
import { Form, type Row } from '../form.js';
import type { Ctx, Hint, Page } from '../page.js';

export interface DispatchDeps {
  env?: NodeJS.ProcessEnv;
  /** Restarts the service and resolves to a message for the footer. Absent where this install has no way to restart it. */
  restart?: () => Promise<string>;
  /** Waits between checks of a route test. */
  wait?: (ms: number) => Promise<void>;
}

export const JOBS_ACTIVITY_TEXT = {
  running: 'Running',
  stalled: 'STALLED',
  lastActivity: 'Last activity',
  empty: 'No jobs are running. A job shows here while it is queued, waiting for approval, running, or being cancelled. Start one from an agent or with augur run.',
  age: (at: number, now = Date.now()): string => {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  },
};

export const DISPATCH_TUI_TEXT = {
  tabs: ['Jobs', 'Routes', 'Service'],
  open: 'Open',
  cancel: 'Cancel job',
  back: 'Back',
  save: 'Save route',
  test: 'Test route',
  close: 'Cancel',
  del: 'Delete',
  delSure: 'Delete it for good',
  add: 'Add route',
  restart: 'Restart',
  saveKey: 'Key',
  removeKey: 'Remove key',
  name: 'Name',
  nameHelp: 'What agents pass to augur run. Lowercase letters, digits, hyphens and underscores.',
  model: 'Model',
  modelHelp: 'The label the rules page uses, as provider/model.',
  adapter: 'Adapter',
  notes: 'Notes',
  notesHelp: 'For you. Agents do not see them.',
  budgetUsd: 'Budget in dollars',
  budgetJobs: 'Budget in jobs',
  budgetPer: 'Budget period',
  budgetHelp: 'Refuses new jobs on this route once it has used this much in the period. Leave a limit empty for none. Dollars count only jobs whose cost is known, which needs a rate for the model.',
  fallback: 'Fallback routes',
  fallbackHelp: 'Route names separated by commas. When this route cannot take a job because of its budget, a pause, plan usage or a missing key, the next one is tried, and each is checked against every rule. With Retry on failure on, a job that fails here on a limit, a spawn error or a read-only timeout runs again on the next one.',
  delegation: 'May start more jobs',
  delegationHelp: 'Lets a job on this route run augur itself, within the depth and count limits.',
  keyHelp: 'The key goes to this computer\'s key store when saved and is never shown again.',
  mode: 'What Augur does',
  approval: 'Agent edits',
  modeUsage: 'Usage only',
  modeJobs: 'Also run jobs',
  jobsOff: 'The service is set to usage only, so it does not run jobs. Choose Also run jobs on the Service screen to turn them on.',
  default: 'Default',
  cannotRun: 'Cannot run',
  ready: 'Ready',
  loading: 'Loading.',
  checking: 'Checking the service.',
  sub: 'Work agents started through Augur',
  routesSub: 'How agents reach each model',
  serviceSub: 'The dispatch service on this computer',
  noHealth: 'The service is not answering, so which routes can run is not known.',
  tabHint: 'Switch screen',
  result: 'Result',
  output: 'Output',
  errors: 'Errors',
};

const ROUTE_NAME = /^[a-z][a-z0-9_-]*$/;
const SETTLED = ['completed', 'failed', 'artifact_validation_failed', 'cancelled', 'killed', 'lost'];
type Sub = 'jobs' | 'routes' | 'service';
type FormKey = 'jobs' | 'job' | 'routes' | 'route' | 'provider' | 'service';

/** The last lines of a job's output, so a long log does not push the rest of the job's page out of reach. */
export function tail(text: string, lines = 40): string[] {
  const all = text.replace(/\s+$/, '').split('\n');
  return all.length > lines ? ['...', ...all.slice(-lines)] : all;
}

export class DispatchPage implements Page {
  name = 'Dispatch';
  sub: Sub = 'jobs';
  readonly forms: Record<FormKey, Form> = { jobs: new Form(), job: new Form(), routes: new Form(), route: new Form(), provider: new Form(), service: new Form() };

  readonly jobs: LedgerModel;
  private moreFilters = false;
  private jobDelivery: LedgerDeliveryState[] = [];

  routes: {
    file: RoutesFile | null; error: string; health: Record<string, string | null> | null; sel: string | null; draft: RouteDraft | null; formError: string; note: string;
    confirmDelete: boolean; testing: boolean; testNote: string; keyStored: boolean | null; keyNote: string;
    /** The Add provider form while it is open. */
    add: ProviderFormState | null; addError: string; adding: boolean;
  } = { file: null, error: '', health: null, sel: null, draft: null, formError: '', note: '', confirmDelete: false, testing: false, testNote: '', keyStored: null, keyNote: '', add: null, addError: '', adding: false };

  service: { pid: number | null; lines: ConfigLine[] | null; note: string; error: string; busy: boolean } = { pid: null, lines: null, note: '', error: '', busy: false };

  private loading = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: DispatchDeps = {}) {
    this.env = deps.env ?? process.env;
    this.jobs = new LedgerModel(this.env.AUGUR_SESSION ?? '');
    this.wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get configDir(): string { return dataDir(this.env); }
  private get routesPath(): string { return this.env.AUGURD_ROUTES ?? join(augurHome(this.env), 'dispatch', 'routes.json'); }

  private get formKey(): FormKey {
    if (this.sub === 'jobs') return this.jobs.selected ? 'job' : 'jobs';
    if (this.sub === 'routes') return this.routes.add ? 'provider' : this.routes.sel ? 'route' : 'routes';
    return 'service';
  }

  get form(): Form { return this.forms[this.formKey]; }

  badge(): string {
    const n = this.jobs.counts.running + this.jobs.counts.queued + this.jobs.counts.stalled + this.jobs.counts['node-lost'];
    return n ? String(n) : '';
  }

  typing(): boolean { return this.form.typing(); }

  // ---------------------------------------------------------------- frame

  draw(screen: Screen, r: Rect, ctx: Ctx): void {
    tabs(screen, r.x + 1, r.y, r.w - 2, DISPATCH_TUI_TEXT.tabs, ['jobs', 'routes', 'service'].indexOf(this.sub), { activeStyle: { ...ctx.theme.accent, bold: true, underline: true } });
    this.form.draw(screen, inset({ x: r.x, y: r.y + 2, w: r.w, h: r.h - 2 }, 0, 1), this.rows(ctx), ctx.theme);
  }

  async key(key: Key, ctx: Ctx): Promise<boolean> {
    if (this.form.typing()) return this.form.key(key, this.rows(ctx));
    if (key.label === '[' || key.label === ']') { this.go(['jobs', 'routes', 'service'][(['jobs', 'routes', 'service'].indexOf(this.sub) + (key.label === ']' ? 1 : 2)) % 3] as Sub, ctx); return true; }
    if (key.label === 'escape') {
      if (this.sub === 'jobs' && this.jobs.selected) { this.jobs.selected = null; this.jobs.detail = null; return true; }
      if (this.sub === 'routes' && this.routes.add) { this.routes.add = null; return true; }
      if (this.sub === 'routes' && this.routes.sel) { this.closeRoute(); return true; }
    }
    return this.form.key(key, this.rows(ctx));
  }

  hints(ctx: Ctx): Hint[] {
    const form = this.form.hints(this.rows(ctx));
    if (this.form.typing()) return form;
    const back: Hint[] = this.formKey === 'job' || this.formKey === 'route' || this.formKey === 'provider' ? [['Esc', DISPATCH_TUI_TEXT.back]] : [];
    return [...form, ...back, ['[ ]', DISPATCH_TUI_TEXT.tabHint]];
  }

  private go(sub: Sub, ctx: Ctx): void {
    this.sub = sub;
    void this.refresh(ctx).then(() => ctx.redraw());
  }

  rows(ctx: Ctx): Row[] {
    switch (this.formKey) {
      case 'job': return this.jobRows(ctx);
      case 'routes': return this.routeListRows(ctx);
      case 'route': return this.routeRows(ctx);
      case 'provider': return this.providerRows(ctx);
      case 'service': return this.serviceRows(ctx);
      default: return this.jobListRows(ctx);
    }
  }

  // ---------------------------------------------------------------- reading from the service

  async refresh(ctx: Ctx): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      if (this.sub === 'jobs') await this.loadJobs(ctx);
      else if (this.sub === 'routes') await this.loadRoutes(ctx);
      else await this.loadService(ctx);
    } finally { this.loading = false; }
    ctx.redraw();
  }

  private transport(ctx: Ctx): LedgerTransport {
    return { call: (method, params) => ctx.link.call(method, params), watch: (since, change, closed) => ctx.link.watchLedger(since, change, closed) };
  }

  private async loadJobs(ctx: Ctx): Promise<void> {
    if (this.jobs.jobs === null) await this.jobs.start(this.transport(ctx));
    else await this.jobs.poll(this.transport(ctx));
  }

  private async loadRoutes(ctx: Ctx): Promise<void> {
    const page = this.routes;
    try {
      const parsed = parseRoutesText(existsSync(this.routesPath) ? readFileSync(this.routesPath, 'utf8') : null);
      if (parsed.ok) { page.file = parsed.file; page.error = ''; } else { page.file = null; page.error = parsed.error; }
    } catch (e) { page.file = null; page.error = (e as Error).message; }
    page.health = null;
    if (page.file) {
      try { page.health = Object.fromEntries((await ctx.link.call('routes')).map((x) => [x.name, x.problem])); } catch { /* the service does not answer */ }
    }
  }

  private async loadService(ctx: Ctx): Promise<void> {
    const s = this.service;
    this.jobDelivery = await ctx.link.call('ledger_delivery').catch(() => []) ?? [];
    s.lines = configLines(this.configDir);
    s.pid = (await ctx.link.call('ping').catch(() => null))?.pid ?? null;
  }

  // ---------------------------------------------------------------- jobs

  private jobListRows(ctx: Ctx): Row[] {
    const { theme } = ctx, jobs = this.jobs, T = LEDGER_TEXT;
    const reload = () => jobs.refresh(this.transport(ctx));
    const rows: Row[] = [
      { kind: 'choice', id: 'jobs-scope', label: T.scope, value: jobs.scope, options: [['session', T.session], ['all', T.all]], set: async value => { jobs.setScope(value === 'session' ? 'session' : 'all'); await reload(); } },
      { kind: 'text', id: 'jobs-session', label: T.sessionId, value: jobs.scope === 'session' ? jobs.session : jobs.filters.session ?? '', save: async value => { if (jobs.scope === 'session') { jobs.session = value.trim(); jobs.reset(); } else jobs.setFilter('session', value.trim()); await reload(); } },
      { kind: 'choice', id: 'jobs-state', label: T.state, value: jobs.filters.state?.[0] ?? '', options: [['', 'All'], ...LEDGER_STATES.map(state => [state, LEDGER_STATE_LABELS[state]] as const)], set: async value => { jobs.setFilter('state', value ? [value] : undefined); await reload(); } },
      { kind: 'text', id: 'jobs-text', label: T.text, value: jobs.filters.text ?? '', save: async value => { jobs.setFilter('text', value.trim()); await reload(); } },
      { kind: 'toggle', id: 'jobs-filters', label: 'More filters', on: this.moreFilters, set: on => { this.moreFilters = on; } },
    ];
    if (this.moreFilters) {
      for (const [key, label, options] of [['kind', T.kind, LEDGER_KINDS], ['origin', T.origin, ORIGIN_KINDS]] as const) rows.push({ kind: 'choice', id: 'jobs-' + key, label, value: key === 'kind' ? jobs.filters.kind?.[0] ?? '' : jobs.filters.origin ?? '', options: [['', 'All'], ...options.map(value => [value, value] as const)], set: async value => { jobs.setFilter(key, key === 'kind' && value ? [value] : value); await reload(); } });
      for (const [key, label] of [['node', T.node], ['route', T.route], ['from', T.from], ['to', T.to]] as const) rows.push({ kind: 'text', id: 'jobs-' + key, label, value: typeof jobs.filters[key] === 'number' ? new Date(jobs.filters[key] as number).toISOString() : String(jobs.filters[key] ?? ''), save: async value => {
        const parsed = key === 'from' || key === 'to' ? value ? Date.parse(value) : undefined : value.trim();
        if (typeof parsed === 'number' && !Number.isFinite(parsed)) { ctx.flash('Enter an ISO date and time.', true); return; }
        jobs.setFilter(key as keyof LedgerQuery, parsed); await reload();
      } });
    }
    rows.push({ kind: 'note', text: LEDGER_STATES.map(state => LEDGER_STATE_LABELS[state] + ': ' + jobs.counts[state]).join(' / ') });
    for (const node of jobs.nodes) {
      if (node.gap) rows.push({ kind: 'note', text: node.node + ': History gap since ' + ledgerTime(node.gap.at), style: 'warn' });
      rows.push({ kind: 'note', text: node.node + ': ' + (node.unreachableSince === null ? T.reachable : T.unreachable + ' since ' + ledgerTime(node.unreachableSince)) + ' / Last poll: ' + ledgerTime(node.lastPollAt ?? node.lastSeenAt), style: node.unreachableSince === null ? 'muted' : 'warn' });
    }
    if (jobs.error) rows.push({ kind: 'note', text: jobs.error, style: 'crit' });
    if (jobs.jobs === null) rows.push({ kind: 'note', text: T.loading });
    else if (!jobs.jobs.length) rows.push({ kind: 'note', text: T.empty });
    for (const job of jobs.jobs ?? []) rows.push({
      kind: 'item', id: 'j:' + job.id, label: job.summary || job.route || job.id,
      sub: [job.kind, job.node, job.stamp.sessionTitle || job.stamp.sessionId || 'Unknown session', job.stamp.originLabel || job.stamp.origin || 'Unknown origin', job.attribution.origin, job.stamp.pid ? 'PID ' + job.stamp.pid : '', job.compacted ? T.compacted : '', job.activityLine ?? '', job.lastActivityAt === null ? '' : JOBS_ACTIVITY_TEXT.age(job.lastActivityAt, ctx.now)].filter(Boolean).join(' / '),
      chips: [[LEDGER_STATE_LABELS[job.state], job.state === 'failed' || job.state === 'stalled' ? theme.crit : ledgerTerminal(job.state) ? theme.muted : theme.accent]],
      right: ledgerDuration(job, ctx.now), enter: () => this.openJob(ctx, job.id), enterLabel: DISPATCH_TUI_TEXT.open,
    });
    rows.push({ kind: 'buttons', id: 'jobs-pages', label: '', buttons: [
      { button: T.first, run: async () => { jobs.reset(); await reload(); } },
      ...(jobs.next ? [{ button: T.next, run: async () => { jobs.nextPage(); await reload(); } }] : []),
    ] });
    return rows;
  }

  private openJob(ctx: Ctx, id: string): void {
    this.jobs.detail = null;
    this.forms.job = new Form();
    void this.jobs.open(id, this.transport(ctx)).then(() => ctx.redraw());
  }

  private jobRows(ctx: Ctx): Row[] {
    const detail = this.jobs.detail;
    const rows: Row[] = [{ kind: 'action', id: 'job-back', label: '', button: DISPATCH_TUI_TEXT.back, run: () => this.jobs.closeDetail() }];
    if (this.jobs.detailError) rows.push({ kind: 'note', text: this.jobs.detailError, style: 'crit' });
    if (!detail) { rows.push({ kind: 'note', text: LEDGER_TEXT.loading }); return rows; }
    const job = detail.job;
    rows.push({ kind: 'heading', text: job.summary || job.id });
    if (job.kind === 'augur-job' && !ledgerTerminal(job.state)) rows.push({ kind: 'action', id: 'job-cancel', label: '', button: DISPATCH_TUI_TEXT.cancel, run: () => this.cancelJob(ctx, job.localId) });
    for (const [label, value] of ledgerFacts(job, ctx.now)) rows.push({ kind: 'note', text: label + ': ' + value });
    for (const [label, value] of Object.entries(job.usage ?? {})) rows.push({ kind: 'note', text: label + ': ' + value });
    for (const [label, links] of [['Parent', detail.parent ? [detail.parent] : []], ['Children', detail.children], ['Retries', detail.retries]] as const) {
      rows.push({ kind: 'heading', text: label });
      for (const linked of links) rows.push({ kind: 'action', id: label + linked.id, label: linked.id, button: DISPATCH_TUI_TEXT.open, run: () => this.openJob(ctx, linked.id) });
    }
    return rows;
  }

  private async cancelJob(ctx: Ctx, id: string): Promise<void> {
    try { await ctx.link.call('cancel', { id }); } catch (e) { ctx.flash((e as Error).message, true); }
    await this.refresh(ctx);
  }

  // ---------------------------------------------------------------- routes

  private closeRoute(): void {
    Object.assign(this.routes, { sel: null, draft: null, formError: '', confirmDelete: false, testNote: '', keyStored: null, keyNote: '' });
  }

  private routeListRows(ctx: Ctx): Row[] {
    const { theme } = ctx, page = this.routes;
    const rows: Row[] = [{ kind: 'note', text: DISPATCH_TUI_TEXT.routesSub }];
    if (page.error) { rows.push({ kind: 'note', text: `${DISPATCH_TEXT.fileBad} ${page.error}`, style: 'crit' }); return rows; }
    if (page.file?.skipped.length) rows.push({ kind: 'note', text: `${DISPATCH_TEXT.skipped(page.file.skipped.length)}: ${page.file.skipped.join(', ')}. ${DISPATCH_TEXT.skippedWhy}`, style: 'warn' });
    if (page.note) rows.push({ kind: 'note', text: page.note, style: 'good' });
    rows.push({ kind: 'buttons', id: 'route-new', label: '', buttons: [
      { button: PROVIDER_FORM_TEXT.add, run: () => this.openProvider() },
      { button: DISPATCH_TUI_TEXT.add, run: () => this.openRoute(ctx, '+') },
    ] });
    if (!page.file) { rows.push({ kind: 'note', text: DISPATCH_TUI_TEXT.loading }); return rows; }
    if (!page.file.routes.length) rows.push({ kind: 'note', text: DISPATCH_TEXT.routesEmpty });
    else if (page.health === null) rows.push({ kind: 'note', text: DISPATCH_TUI_TEXT.noHealth });
    for (const r of page.file.routes) {
      const problem = page.health ? page.health[r.name] ?? null : undefined;
      rows.push({
        kind: 'item', id: `r:${r.name}`, label: r.name, sub: `${r.model} through ${adapterInfo(r.adapter)?.label ?? r.adapter}${problem ? `. ${problem}` : ''}`,
        chips: problem === undefined ? [] : [problem ? [DISPATCH_TUI_TEXT.cannotRun, theme.crit] : [DISPATCH_TUI_TEXT.ready, theme.good]],
        enter: () => this.openRoute(ctx, r.name), enterLabel: DISPATCH_TUI_TEXT.open,
      });
    }
    return rows;
  }

  private openRoute(ctx: Ctx, name: string): void {
    const r = this.routes.file?.routes.find((x) => x.name === name);
    if (name !== '+' && !r) return;
    Object.assign(this.routes, { sel: name, draft: r ? draftOf(r) : emptyDraft(), formError: '', note: '', confirmDelete: false, testNote: '', keyStored: null, keyNote: '' });
    this.forms.route = new Form();
    void this.checkKey(ctx);
  }

  // ---------------------------------------------------------------- add provider

  private openProvider(): void {
    Object.assign(this.routes, { add: emptyProviderForm(), addError: '', note: '', adding: false });
    this.forms.provider = new Form();
  }

  private providerRows(ctx: Ctx): Row[] {
    const page = this.routes, f = page.add, T = PROVIDER_FORM_TEXT;
    if (!f) return [];
    const fields = providerFields(f.kind);
    const existing = new Set([...(page.file?.routes.map((r) => r.name) ?? []), ...(page.file?.skipped ?? [])]);
    const rows: Row[] = [{ kind: 'heading', text: T.title }, { kind: 'note', text: T.sub }];
    rows.push({ kind: 'choice', id: 'ap-kind', label: T.service, value: f.kind, options: PROVIDER_CHOICES.map((c) => [c.id, `${c.label} (${c.sub})`] as const),
      set: (v) => { page.add = emptyProviderForm(v); page.addError = ''; } });
    const text = (field: keyof typeof T.fields, key: keyof Omit<ProviderFormState, 'kind' | 'more'>): Extract<Row, { kind: 'text' }> => ({ kind: 'text', id: `ap-${field}`, label: T.fields[field].label, desc: T.fields[field].help,
      value: f[key], placeholder: T.fields[field].placeholder, save: (v) => { f[key] = v.trim(); page.addError = ''; } });
    if (fields.provider) rows.push(text('provider', 'provider'));
    if (fields.baseUrl) rows.push(text('baseUrl', 'baseUrl'));
    if (fields.route) rows.push(text('route', 'route'));
    if (fields.model) rows.push(text('model', 'model'));
    rows.push({ kind: 'text', id: 'ap-key', label: T.fields.key.label, desc: T.fields.key.help, value: '', mask: true, placeholder: T.fields.key.placeholder, ...(f.key ? { badge: 'Entered' } : {}),
      save: (v) => { f.key = v.trim(); page.addError = ''; } });
    rows.push({ kind: 'toggle', id: 'ap-more', label: T.more, on: f.more, set: (on) => { f.more = on; } });
    if (f.more) {
      if (!fields.provider && fields.route) rows.push({ ...text('provider', 'provider'), indent: true });
      if (!fields.baseUrl) rows.push({ ...text('baseUrl', 'baseUrl'), indent: true });
      if (fields.model) {
        rows.push({ ...text('label', 'label'), indent: true }, { ...text('maxTokens', 'maxTokens'), indent: true });
        if (!PROVIDER_CHOICES.find((c) => c.id === f.kind && c.group === 'preset' && c.sub.includes('balance built in'))) rows.push({ ...text('balanceUrl', 'balanceUrl'), indent: true }, { ...text('balancePath', 'balancePath'), indent: true });
      }
    }
    rows.push({ kind: 'heading', text: T.plan });
    const got = planOfForm(f, existing);
    if ('problems' in got) {
      if (got.fresh || (!fields.route && !got.problems.length)) rows.push({ kind: 'note', text: fields.route ? T.fresh : T.freshJev, style: 'muted' });
      else for (const p of got.problems) rows.push({ kind: 'note', text: p, style: 'crit' });
    } else {
      for (const r of planRows(got.plan)) {
        rows.push({ kind: 'note', text: `${r.label}: ${r.text}` });
        if (r.note) rows.push({ kind: 'note', text: r.note, style: 'muted', indent: true });
      }
      const entry = routeEntryText(got.plan);
      if (entry) for (const line of entry.split('\n')) rows.push({ kind: 'note', text: line, style: 'muted', indent: true });
    }
    if (page.addError) rows.push({ kind: 'note', text: page.addError, style: 'crit' });
    rows.push({ kind: 'buttons', id: 'ap-actions', label: '', buttons: [
      ...('plan' in got ? [{ button: page.adding ? T.adding : T.add, run: () => this.applyProvider(ctx, f, got.plan) }] : []),
      { button: T.cancel, run: () => { page.add = null; } },
    ] });
    return rows;
  }

  private async applyProvider(ctx: Ctx, f: ProviderFormState, plan: Parameters<typeof applyProvider>[0]): Promise<void> {
    const page = this.routes;
    if (page.adding) return;
    page.adding = true; page.addError = '';
    ctx.redraw();
    try {
      const done = await applyProvider(plan, f.key, {
        addProvider: (input) => ctx.link.run('addProvider', input),
        setSecret: async (name, value) => { await ctx.link.run('setSecret', name, value); },
        setProviderKey: async (provider, field, value) => { await ctx.link.run('setProviderKey', provider, field, value); },
        readRoutes: async () => (existsSync(this.routesPath) ? readFileSync(this.routesPath, 'utf8') : null),
        writeRoutes: async (text) => {
          routeFile(this.routesPath).update(() => text);
        },
      });
      f.key = '';
      page.add = null;
      page.note = PROVIDER_FORM_TEXT.done(done.done, done.next);
      await this.refresh(ctx);
    } catch (e) { page.addError = PROVIDER_FORM_TEXT.failed((e as Error).message); }
    page.adding = false;
    ctx.redraw();
  }

  /** Asks the key store whether the route being edited has a key. Only a yes or no comes back. */
  private async checkKey(ctx: Ctx): Promise<void> {
    const d = this.routes.draft;
    if (!d || d.options.keySource !== 'store' || !ROUTE_NAME.test(d.name)) { this.routes.keyStored = null; return; }
    this.routes.keyStored = (await ctx.run<boolean>('hasSecret', routeSecretName(d.name))) ?? null;
    ctx.redraw();
  }

  private routeRows(ctx: Ctx): Row[] {
    const page = this.routes, d = page.draft;
    if (!d) return [{ kind: 'note', text: DISPATCH_TEXT.routesPick }];
    const isNew = page.sel === '+', info = adapterInfo(d.adapter);
    const rows: Row[] = [{ kind: 'heading', text: isNew ? 'New route' : d.name }];
    rows.push({ kind: 'text', id: 'rt-name', label: DISPATCH_TUI_TEXT.name, desc: DISPATCH_TUI_TEXT.nameHelp, value: d.name, placeholder: 'luna', save: (v) => { if (isNew) d.name = v.trim(); } });
    rows.push({ kind: 'text', id: 'rt-model', label: DISPATCH_TUI_TEXT.model, desc: DISPATCH_TUI_TEXT.modelHelp, value: d.model, placeholder: 'codex/luna', save: (v) => { d.model = v.trim(); } });
    rows.push({ kind: 'choice', id: 'rt-adapter', label: DISPATCH_TUI_TEXT.adapter, desc: info?.summary, value: d.adapter, options: ADAPTER_INFO.map((a) => [a.id, a.label] as const),
      set: (v) => { d.adapter = v; d.options = {}; page.formError = ''; } });
    for (const spec of (info?.options ?? []).filter((s) => !(s.key === 'apiKeyEnv' && d.options.keySource === 'store'))) {
      const value = d.options[spec.key] ?? '', label = `${spec.label}${spec.required ? ' (required)' : ''}`;
      if (spec.kind === 'choice') {
        rows.push({ kind: 'choice', id: `rt-opt-${spec.key}`, label, desc: spec.help, value, options: [['', DISPATCH_TUI_TEXT.default], ...(spec.choices ?? []).map((c) => [c, c] as const)],
          set: (v) => { d.options[spec.key] = v; if (spec.key === 'keySource') { page.keyNote = ''; void this.checkKey(ctx); } } });
      } else {
        rows.push({ kind: 'text', id: `rt-opt-${spec.key}`, label, desc: spec.help, value, placeholder: spec.placeholder ?? '', save: (v) => { d.options[spec.key] = v; } });
      }
      if (spec.key === 'keySource' && d.options.keySource === 'store') rows.push(...this.keyRows(ctx, d));
    }
    rows.push({ kind: 'text', id: 'rt-notes', label: DISPATCH_TUI_TEXT.notes, desc: DISPATCH_TUI_TEXT.notesHelp, value: d.notes, save: (v) => { d.notes = v; } });
    rows.push({ kind: 'text', id: 'rt-usd', label: DISPATCH_TUI_TEXT.budgetUsd, desc: DISPATCH_TUI_TEXT.budgetHelp, value: d.budgetUsd, placeholder: 'None', save: (v) => { d.budgetUsd = v.trim(); } });
    rows.push({ kind: 'text', id: 'rt-jobs', label: DISPATCH_TUI_TEXT.budgetJobs, value: d.budgetJobs, placeholder: 'None', save: (v) => { d.budgetJobs = v.trim(); } });
    rows.push({ kind: 'choice', id: 'rt-per', label: DISPATCH_TUI_TEXT.budgetPer, value: d.budgetPer, options: [['day', 'Per day'], ['week', 'Per week'], ['month', 'Per month']], set: (v) => { d.budgetPer = v; } });
    rows.push({ kind: 'text', id: 'rt-fallback', label: DISPATCH_TUI_TEXT.fallback, desc: DISPATCH_TUI_TEXT.fallbackHelp, value: d.fallback, placeholder: 'luna, grok', save: (v) => { d.fallback = v; } });
    rows.push({ kind: 'toggle', id: 'rt-delegation', label: DISPATCH_TUI_TEXT.delegation, desc: DISPATCH_TUI_TEXT.delegationHelp, on: d.delegation, set: (on) => { d.delegation = on; } });
    if (page.formError) rows.push({ kind: 'note', text: page.formError, style: 'crit' });
    if (page.testNote) rows.push({ kind: 'note', text: page.testNote });
    rows.push({ kind: 'buttons', id: 'rt-actions', label: '', buttons: [
      { button: DISPATCH_TUI_TEXT.save, run: () => this.saveRoute(ctx) },
      ...(isNew ? [] : [{ button: page.testing ? DISPATCH_TEXT.testRunning : DISPATCH_TUI_TEXT.test, run: () => this.testRoute(ctx, d.name) }]),
      { button: DISPATCH_TUI_TEXT.close, run: () => this.closeRoute() },
      ...(isNew ? [] : [page.confirmDelete ? { button: DISPATCH_TUI_TEXT.delSure, run: () => this.writeRoutes(ctx, d.name, null, `Deleted ${d.name}.`) }
        : { button: DISPATCH_TUI_TEXT.del, run: () => { page.confirmDelete = true; } }]),
    ] });
    return rows;
  }

  /** Write-only: the key goes to the key store when saved and is never read back or shown. */
  private keyRows(ctx: Ctx, d: RouteDraft): Row[] {
    const page = this.routes;
    const state = page.keyStored === null ? DISPATCH_TUI_TEXT.checking : page.keyStored ? DISPATCH_TEXT.keyStored : DISPATCH_TEXT.keyNone;
    const rows: Row[] = [{ kind: 'text', id: 'rt-key', label: DISPATCH_TUI_TEXT.saveKey, desc: `${state} ${DISPATCH_TUI_TEXT.keyHelp}`, value: '', mask: true, placeholder: page.keyStored ? 'Enter a new key to replace it' : 'Paste the key', save: async (v) => {
      if (!ROUTE_NAME.test(d.name)) { page.keyNote = DISPATCH_TEXT.keyNameFirst; return; }
      if (!v.trim()) { page.keyNote = DISPATCH_TEXT.keyEmpty; return; }
      try { await ctx.link.run('setSecret', routeSecretName(d.name), v.trim()); page.keyStored = true; page.keyNote = DISPATCH_TEXT.keySaved; }
      catch (e) { page.keyNote = `The key was not saved. ${(e as Error).message}`; }
    } }];
    if (page.keyStored) {
      rows.push({ kind: 'action', id: 'rt-key-remove', label: '', button: DISPATCH_TUI_TEXT.removeKey, run: async () => {
        try { await ctx.link.run('deleteSecret', routeSecretName(d.name)); page.keyStored = false; page.keyNote = DISPATCH_TEXT.keyGone; }
        catch (e) { page.keyNote = `The key was not removed. ${(e as Error).message}`; }
      } });
    }
    if (page.keyNote) rows.push({ kind: 'note', text: page.keyNote });
    return rows;
  }

  private async saveRoute(ctx: Ctx): Promise<void> {
    const page = this.routes, d = page.draft;
    if (!d || !page.file) return;
    const problem = checkDraft(d, page.file.routes.map((r) => r.name), page.sel === '+');
    if (problem) { page.formError = problem; return; }
    await this.writeRoutes(ctx, d.name, d, page.sel === '+' ? `Added ${d.name}.` : `Saved ${d.name}.`);
  }

  private async writeRoutes(ctx: Ctx, name: string, draft: RouteDraft | null, done: string): Promise<void> {
    const page = this.routes;
    if (!page.file) return;
    page.formError = '';
    try {
      routeFile(this.routesPath).update(text => {
        const latest = parseRoutesText(text);
        if (!latest.ok) throw new Error(latest.error);
        if (page.sel === '+' && Object.hasOwn(latest.file.raw.routes as Record<string, unknown>, name)) throw new Error(`A route named ${name} already exists. Nothing was written.`);
        return writeRoute(latest.file, name, draft);
      });
      this.closeRoute();
      page.note = done;
      await this.refresh(ctx);
    } catch (e) { page.formError = `routes.json was not written. ${(e as Error).message}`; }
  }

  /** Sends the fixed test prompt through a saved route and waits for the job, reporting what came of it in a sentence. */
  private async testRoute(ctx: Ctx, name: string): Promise<void> {
    const page = this.routes;
    if (!name || page.testing) return;
    page.testing = true; page.testNote = '';
    ctx.redraw();
    const say = (text: string) => { page.testNote = text; page.testing = false; ctx.redraw(); };
    try {
      const base = {
        route: name, dataTier: 'public' as const, tools: 'read' as const, output: 'text_only' as const, cwd: mkdtempSync(join(tmpdir(), 'augur-route-test-')), timeoutS: 120,
        prompt: { text: 'Reply with the single word ok and nothing else.' }, caller: { kind: 'cli' as const, label: 'route test' }, allow: ['unpicked' as const],
      };
      // The rules decide what a model may do, so the test uses the first activity they allow it. A refusal costs nothing, since no job starts.
      let res: Awaited<ReturnType<typeof ctx.link.call<'submit'>>> | null = null;
      for (const activity of ACTIVITIES) {
        res = await ctx.link.call('submit', { ...base, activity });
        if (!('rejected' in res) || res.rejected.code !== 'activity_not_permitted') break;
      }
      if (!res) return say(DISPATCH_TEXT.testFailed(name, 'The service did not accept the test.'));
      if ('rejected' in res) return say(DISPATCH_TEXT.testFailed(name, res.rejected.reason));
      for (let i = 0; i < 75; i++) {
        await this.wait(2000);
        const r = await ctx.link.call('result', { id: res.id });
        if (!r || !SETTLED.includes(r.job.state)) continue;
        return say(r.job.state === 'completed' ? DISPATCH_TEXT.testWorks(name, r.answer) : DISPATCH_TEXT.testFailed(name, r.job.reason ?? `The job ended as ${r.job.state}.`));
      }
      say(DISPATCH_TEXT.testSlow(name));
    } catch (e) { say((e as Error).message); }
  }

  // ---------------------------------------------------------------- service

  private serviceRows(ctx: Ctx): Row[] {
    const s = this.service, runJobs = ctx.state.config.dispatch?.runJobs === true;
    const rows: Row[] = [{ kind: 'note', text: DISPATCH_TUI_TEXT.serviceSub }];
    rows.push({ kind: 'choice', id: 'mode', label: DISPATCH_TUI_TEXT.mode, value: runJobs ? 'jobs' : 'usage', options: [['usage', DISPATCH_TUI_TEXT.modeUsage], ['jobs', DISPATCH_TUI_TEXT.modeJobs]],
      set: async (v) => {
        const c = structuredClone(ctx.state.config);
        c.dispatch = { runJobs: v === 'jobs' };
        s.note = ''; s.error = '';
        await ctx.run('saveConfig', c);
        await this.loadService(ctx);
      } });
    rows.push({ kind: 'note', text: runJobs ? MODE_TEXT.jobs : MODE_TEXT.usage });
    const level = ctx.state.config.agentApproval ?? 'risky';
    rows.push({ kind: 'heading', text: APPROVAL_TEXT.heading });
    rows.push({ kind: 'choice', id: 'approval', label: DISPATCH_TUI_TEXT.approval, value: level, options: APPROVAL_LEVELS.map(([v, label]) => [v, label] as [string, string]),
      set: async (v) => {
        const c = structuredClone(ctx.state.config);
        c.agentApproval = v === 'all' || v === 'none' ? v : 'risky';
        await ctx.run('saveConfig', c);
      } });
    rows.push({ kind: 'note', text: `${APPROVAL_TEXT[level]} ${APPROVAL_TEXT.where}` });
    for (const sink of this.jobDelivery) rows.push({ kind: 'note', text: sink.sink + ': ' + sink.pending + ' pending / ' + sink.delivered + ' delivered / ' + sink.failed + ' failed' + (sink.error ? '. ' + sink.error : ''), style: sink.error ? 'warn' : 'muted' });
    if (!runJobs) return rows;
    rows.push({ kind: 'heading', text: 'Service' });
    rows.push({ kind: 'note', text: s.pid === null && s.lines === null ? DISPATCH_TUI_TEXT.checking : s.pid !== null ? DISPATCH_TEXT.serviceRunning(s.pid) : DISPATCH_TEXT.serviceStopped, style: s.pid !== null ? 'good' : 'warn' });
    if (this.deps.restart && s.pid !== null) rows.push({ kind: 'action', id: 'restart', label: '', button: DISPATCH_TUI_TEXT.restart, disabled: s.busy, run: () => this.restart(ctx) });
    if (s.note) rows.push({ kind: 'note', text: s.note, style: 'good' });
    if (s.error) rows.push({ kind: 'note', text: s.error, style: 'crit' });
    rows.push({ kind: 'heading', text: 'Settings' }, { kind: 'note', text: DISPATCH_TEXT.settingsNote });
    if (!s.lines) { rows.push({ kind: 'note', text: DISPATCH_TUI_TEXT.loading }); return rows; }
    for (const l of s.lines) rows.push(...this.settingRows(ctx, l));
    const decision = s.lines.find((l) => l.key === 'decision.backend')?.value ?? 'none';
    rows.push({ kind: 'note', text: CLASSIFIER_TEXT[decision] ?? '' });
    return rows;
  }

  private settingRows(ctx: Ctx, l: ConfigLine): Row[] {
    // Settings that weaken the service's checks stay read-only here, and so does an adapter list that includes exec, which runs any command a route names.
    const locked = l.weakens || (l.key === 'adapters' && l.value.split(',').includes('exec'));
    const label = `${l.label}${l.value !== l.default ? ' (changed)' : ''}`, id = `cfg:${l.key}`;
    if (locked) return [{ kind: 'note', text: `${label}: ${l.value}. ${l.help} ${DISPATCH_TEXT.changeByHand}` }];
    const save = async (value: string) => {
      const r = setConfigValue(this.configDir, l.key, value);
      if (r.ok) { this.service.error = ''; this.service.note = DISPATCH_TEXT.settingSaved; } else { this.service.error = r.error; this.service.note = ''; }
      await this.loadService(ctx);
    };
    switch (l.kind) {
      case 'bool': return [{ kind: 'toggle', id, label, desc: l.help, on: l.value === 'true', set: (on) => save(String(on)) }];
      case 'choice': return [{ kind: 'choice', id, label, desc: l.help, value: l.value, options: (l.choices ?? []).map((c) => [c, c] as const), set: save }];
      case 'list': {
        const on = new Set(l.value.split(',').filter(Boolean)), choices = (l.choices ?? []).filter((c) => c !== 'exec' || on.has('exec'));
        return [{ kind: 'checks', id, label, desc: l.help, cells: choices.map((c) => ({ label: c, on: on.has(c) })), cellW: Math.max(...choices.map((c) => c.length)) + 4,
          set: (i, tick) => { const c = choices[i]; if (c) return save(choices.filter((x) => (x === c ? tick : on.has(x))).join(',')); } }];
      }
      default: return [{ kind: 'text', id, label, desc: l.help, value: l.value, placeholder: l.default, save }];
    }
  }

  private async restart(ctx: Ctx): Promise<void> {
    const s = this.service;
    s.busy = true; s.note = ''; s.error = '';
    ctx.redraw();
    try { s.note = await this.deps.restart!(); } catch (e) { s.error = (e as Error).message; }
    s.busy = false;
    await this.loadService(ctx);
  }
}
