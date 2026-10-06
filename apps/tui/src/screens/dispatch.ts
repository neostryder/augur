// The dispatch page has three screens, switched with [ and ]: the jobs agents started, the routes that join a model to the program that runs it,
// and the service's own settings. It reads jobs and routes through the service's own calls, as the window app does, and edits routes.json and
// config.json in the folders the service reads them from.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ACTIVITIES, ACTIVITY_LABELS, DATA_TIER_LABELS } from '@augur/core';
import { augurHome, configLines, dataDir, setConfigValue, type ConfigLine, type ServiceError } from '@augur/augurd';
import { ADAPTER_INFO, adapterInfo, describeFigure, routeSecretName } from '@augur/dispatch-protocol';
import type { Accounted, JobRecord } from '@augur/dispatch-protocol';
import { inset, tabs, type Key, type Rect, type Screen } from '@augur/terminal';
import {
  APPROVAL_LEVELS, APPROVAL_TEXT, CLASSIFIER_TEXT, DISPATCH_TEXT, JOB_OUTPUT_LABELS, MODE_TEXT, STATE_LABELS, TOOL_LABELS, ago, checkDraft, draftOf, duration, emptyDraft, isBad, isLive,
  parseRoutesText, writeRoute, type RouteDraft, type RoutesFile,
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
  fallbackHelp: 'Route names separated by commas. When this route cannot take a job because of its budget, a pause, plan usage or a missing key, the next one is tried, and each is checked against every rule.',
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
type FormKey = 'jobs' | 'job' | 'routes' | 'route' | 'service';

/** The last lines of a job's output, so a long log does not push the rest of the job's page out of reach. */
export function tail(text: string, lines = 40): string[] {
  const all = text.replace(/\s+$/, '').split('\n');
  return all.length > lines ? ['...', ...all.slice(-lines)] : all;
}

export class DispatchPage implements Page {
  name = 'Dispatch';
  sub: Sub = 'jobs';
  readonly forms: Record<FormKey, Form> = { jobs: new Form(), job: new Form(), routes: new Form(), route: new Form(), service: new Form() };

  jobs: {
    list: JobRecord[] | null; accounted: Record<string, Accounted>; sel: string | null; error: string; off: boolean;
    detail: { job: JobRecord; result: string; stdout: string; stderr: string } | null;
  } = { list: null, accounted: {}, sel: null, error: '', off: false, detail: null };

  routes: {
    file: RoutesFile | null; error: string; health: Record<string, string | null> | null; sel: string | null; draft: RouteDraft | null; formError: string; note: string;
    confirmDelete: boolean; testing: boolean; testNote: string; keyStored: boolean | null; keyNote: string;
  } = { file: null, error: '', health: null, sel: null, draft: null, formError: '', note: '', confirmDelete: false, testing: false, testNote: '', keyStored: null, keyNote: '' };

  service: { pid: number | null; lines: ConfigLine[] | null; note: string; error: string; busy: boolean } = { pid: null, lines: null, note: '', error: '', busy: false };

  private loading = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: DispatchDeps = {}) {
    this.env = deps.env ?? process.env;
    this.wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get configDir(): string { return dataDir(this.env); }
  private get routesPath(): string { return this.env.AUGURD_ROUTES ?? join(augurHome(this.env), 'dispatch', 'routes.json'); }

  private get formKey(): FormKey {
    if (this.sub === 'jobs') return this.jobs.sel ? 'job' : 'jobs';
    if (this.sub === 'routes') return this.routes.sel ? 'route' : 'routes';
    return 'service';
  }

  get form(): Form { return this.forms[this.formKey]; }

  badge(): string {
    const n = (this.jobs.list ?? []).filter((j) => isLive(j.state)).length;
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
      if (this.sub === 'jobs' && this.jobs.sel) { this.jobs.sel = null; this.jobs.detail = null; return true; }
      if (this.sub === 'routes' && this.routes.sel) { this.closeRoute(); return true; }
    }
    return this.form.key(key, this.rows(ctx));
  }

  hints(ctx: Ctx): Hint[] {
    const form = this.form.hints(this.rows(ctx));
    if (this.form.typing()) return form;
    const back: Hint[] = this.formKey === 'job' || this.formKey === 'route' ? [['Esc', DISPATCH_TUI_TEXT.back]] : [];
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

  private async loadJobs(ctx: Ctx): Promise<void> {
    const j = this.jobs;
    try {
      j.list = await ctx.link.call('list', { limit: 50 });
      j.error = ''; j.off = false;
      const acc = await ctx.link.call('accounting', { limit: 50 }).catch(() => null);
      j.accounted = Object.fromEntries((acc?.jobs ?? []).map((x) => [x.id, x.accounted]));
      if (j.sel) await this.loadDetail(ctx, j.sel);
    } catch (e) {
      const err = e as ServiceError;
      if (err.code === 'jobs_off') { j.off = true; j.list = []; j.error = ''; } else { j.error = err.message || String(e); }
    }
  }

  private async loadDetail(ctx: Ctx, id: string): Promise<void> {
    const r = await ctx.link.call('result', { id });
    if (!r) return;
    const [out, err] = await Promise.all([ctx.link.call('logs', { id, stream: 'stdout' }), ctx.link.call('logs', { id, stream: 'stderr' })]);
    if (this.jobs.sel === id) this.jobs.detail = { job: r.job, result: r.answer ?? '', stdout: out.text, stderr: err.text };
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
    s.lines = configLines(this.configDir);
    s.pid = (await ctx.link.call('ping').catch(() => null))?.pid ?? null;
  }

  // ---------------------------------------------------------------- jobs

  private jobListRows(ctx: Ctx): Row[] {
    const { theme } = ctx, j = this.jobs;
    const rows: Row[] = [{ kind: 'note', text: DISPATCH_TUI_TEXT.sub }];
    if (j.off) { rows.push({ kind: 'note', text: DISPATCH_TUI_TEXT.jobsOff, style: 'warn' }); return rows; }
    if (j.error) rows.push({ kind: 'note', text: j.error, style: 'crit' });
    if (j.list === null) { rows.push({ kind: 'note', text: DISPATCH_TUI_TEXT.loading }); return rows; }
    if (!j.list.length) rows.push({ kind: 'note', text: DISPATCH_TEXT.jobsEmpty });
    for (const job of j.list) {
      const style = isLive(job.state) ? theme.accent : isBad(job.state) ? theme.crit : theme.muted;
      rows.push({
        kind: 'item', id: `j:${job.id}`, label: job.route, sub: `${ACTIVITY_LABELS[job.activity] ?? job.activity}, ${(DATA_TIER_LABELS[job.dataTier] ?? job.dataTier).toLowerCase()} data`,
        chips: [[STATE_LABELS[job.state], style]], right: job.startedAt ? duration(job, ctx.now) : ago(new Date(job.createdAt).toISOString(), ctx.now),
        enter: () => this.openJob(ctx, job.id), enterLabel: DISPATCH_TUI_TEXT.open,
      });
    }
    return rows;
  }

  private openJob(ctx: Ctx, id: string): void {
    this.jobs.sel = id; this.jobs.detail = null;
    this.forms.job = new Form();
    void this.refresh(ctx);
  }

  private jobRows(ctx: Ctx): Row[] {
    const d = this.jobs.detail;
    if (!d) return [{ kind: 'note', text: this.jobs.sel ? DISPATCH_TUI_TEXT.loading : DISPATCH_TEXT.jobsPick }];
    const j = d.job, acc = this.jobs.accounted[j.id];
    const usage = acc && (acc.inputTokens || acc.outputTokens) ? `${describeFigure(acc.inputTokens, 'tokens')} in, ${describeFigure(acc.outputTokens, 'tokens')} out` : '';
    const cost = acc?.costUsd ? describeFigure(acc.costUsd, 'usd') : '';
    const fact = (label: string, value: string): Row => ({ kind: 'note', text: `${label}: ${value}` });
    const rows: Row[] = [{ kind: 'heading', text: `${j.route}  ${STATE_LABELS[j.state]}` }];
    if (j.reason) rows.push({ kind: 'note', text: j.reason, style: isBad(j.state) ? 'crit' : 'muted' });
    rows.push({ kind: 'buttons', id: 'job-actions', label: '', buttons: [
      ...(isLive(j.state) ? [{ button: DISPATCH_TUI_TEXT.cancel, run: () => this.cancelJob(ctx, j.id) }] : []),
      { button: DISPATCH_TUI_TEXT.back, run: () => { this.jobs.sel = null; this.jobs.detail = null; } },
    ] });
    rows.push(fact('Activity', ACTIVITY_LABELS[j.activity] ?? j.activity), fact('Data', DATA_TIER_LABELS[j.dataTier] ?? j.dataTier), fact('Tools', TOOL_LABELS[j.tools] ?? j.tools),
      fact('Output', JOB_OUTPUT_LABELS[j.output] ?? j.output), fact('Adapter', j.adapter), fact('Started by', j.caller.label ?? j.caller.kind), fact('Folder', j.cwd));
    if (j.startedAt) rows.push(fact('Took', duration(j, ctx.now)));
    if (j.exitCode !== null) rows.push(fact('Exit code', String(j.exitCode)));
    if (usage) rows.push(fact('Tokens', usage));
    if (cost) rows.push(fact('Cost', cost));
    if (j.patch) rows.push(fact('Patch', `${j.patch.files} ${j.patch.files === 1 ? 'file' : 'files'}, apply with augur apply ${j.id}`));
    for (const [title, text] of [[DISPATCH_TUI_TEXT.result, d.result], [DISPATCH_TUI_TEXT.output, d.stdout], [DISPATCH_TUI_TEXT.errors, d.stderr]] as const) {
      if (!text.trim()) continue;
      rows.push({ kind: 'heading', text: title });
      for (const line of tail(text)) rows.push({ kind: 'note', text: line || ' ', indent: true });
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
    rows.push({ kind: 'action', id: 'route-new', label: '', button: DISPATCH_TUI_TEXT.add, run: () => this.openRoute(ctx, '+') });
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
      const text = writeRoute(page.file, name, draft);
      mkdirSync(dirname(this.routesPath), { recursive: true });
      const tmp = `${this.routesPath}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.routesPath);
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
