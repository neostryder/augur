// The rules page lists each provider's models with a line on what each may do, and opens a model's rules, or a provider's defaults, as a form.
// It carries the rest of the window app's rules page as well: the changes agents asked for, search and filters, picking models to change
// together, the dial-back preset and the history with undo. Edits go through the same setters as the window app's, so each one is stamped
// and kept in the history, and the whole config is saved through the service, which writes policy.json and syncs the phone.
import {
  ACTIVITIES, ACTIVITY_LABELS, COST_TIERS, DATA_TIERS, DATA_TIER_LABELS, OUTPUT_MODES, WEIGHT_LABELS, WEIGHT_LEVELS,
  addModels, allPlugins, emptyPolicy, fieldPath, latestOnly, pauseActive, pendingCount, policyProviders, resolveThresholds, setField, setFieldMany, setModelStatus, undoChange,
  type ActivityId, type EngineState, type ModelEntry, type PolicyConfig, type Rule,
} from '@augur/core';
import { inset, type Key, type Rect, type Screen } from '@augur/terminal';
import {
  BULK_FIELDS, COST_LABELS, LIST_MODE_LABELS, OUTPUT_LABELS, RULES_TEXT, RULE_FILTERS, STATUS_LABELS, VALUE_LABELS,
  ago, describeChange, dialEndChoices, heldRows, models, pauseResets, pauseText, pauseValue, planDialBack, previewBulk, previewValue,
  providerCounts, ruleMatches, ruleSummary, statusText, validModelId,
  type BulkPreview, type DialBackPlan, type RulesFilter,
} from '@augur/view-model';
import { Form, type Row } from '../form.js';
import type { Ctx, Hint, Page } from '../page.js';

/** The terminal app runs on the computer beside the service, so its edits carry the same device name as the window app's there. */
const DEVICE = 'desktop';

export const RULES_TUI_TEXT = {
  search: 'Search',
  searchHint: 'Name or id',
  filter: 'Show',
  open: 'Open rules',
  showModels: 'Show models',
  hideModels: 'Hide models',
  selected: (n: number) => `${n} selected`,
  confirm: 'Confirm',
  hide: 'Hide',
  clear: 'Clear',
  apply: 'Apply',
  preview: 'Preview',
  cancel: 'Cancel',
  close: 'Close',
  activity: 'Activity',
  weight: 'Weight',
  field: 'Field',
  value: 'Value',
  history: 'History',
  dial: 'Dial back',
  back: 'Back',
  undo: 'Undo',
  accept: 'Accept',
  dismiss: 'Dismiss',
  retry: 'Try again',
  showThem: 'Show them',
  waitButton: (n: number) => (n ? `${n} chosen` : 'Choose'),
  tick: 'Tick or untick',
  choose: 'Choose',
  whenHelp: 'A date and time such as 2026-10-11 17:00, or a length such as 12h, 3d or 1w.',
  whenBad: 'That is not a time Augur can read. Try 2026-10-11 17:00 or 3d.',
  pauseNow: 'Pause',
  pauseNeed: 'Type a time or choose a reset first.',
  addFrom: 'From the list',
  addId: 'Model id',
  add: 'Add',
  numberBad: 'That is not a number.',
};

/**
 * Reads a time typed in the terminal: a length from now (90m, 12h, 3d, 1w) or a local date with an optional time (2026-10-11 17:00).
 * Returns the ISO time, or null when the text is neither.
 */
export function parseWhen(text: string, now = Date.now()): string | null {
  const t = text.trim();
  const len = /^(\d+)\s*([mhdw])$/i.exec(t);
  if (len) return new Date(now + Number(len[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[len[2]!.toLowerCase() as 'm']).toISOString();
  const at = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  if (!at) return null;
  const d = new Date(Number(at[1]), Number(at[2]) - 1, Number(at[3]), Number(at[4] ?? 0), Number(at[5] ?? 0));
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(at[2]) - 1 ? null : d.toISOString();
}

type View = 'list' | 'detail' | 'wait' | 'history' | 'dial';

const levels = (): Array<[string, string]> => WEIGHT_LEVELS.map((w) => [w, WEIGHT_LABELS[w]]);
const policyOf = (s: EngineState): PolicyConfig => s.config.policy ?? emptyPolicy();

export class RulesPage implements Page {
  name = 'Rules';
  view: View = 'list';
  /** The provider defaults (model null) or the model whose rules are open. */
  sel: { provider: string; model: string | null } | null = null;
  query = '';
  filter: RulesFilter = 'all';
  open = new Set<string>();
  /** Models picked for a change together, as `<provider>|<model label>`. */
  picked = new Set<string>();
  /** What the last change to the picked models did. */
  note = '';
  /** How the balance treats each provider, by provider id, read from the service. */
  stances: Record<string, string> = {};
  private reading = false;

  async refresh(ctx: Ctx): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const got = await ctx.link.call('balance', { days: 1 });
      if (!('error' in got)) this.stances = Object.fromEntries(got.providers.map((p) => [p.id, p.stance]));
    } catch { /* the service does not answer, and the page works without the chips */ } finally { this.reading = false; ctx.redraw(); }
  }
  readonly forms: Record<View, Form> = { list: new Form(), detail: new Form(), wait: new Form(), history: new Form(), dial: new Form() };
  private bulk: { act: ActivityId; level: string; field: BulkPreview['field']; value: string; preview: BulkPreview | null } = { act: ACTIVITIES[0], level: '', field: BULK_FIELDS[0]!.field, value: '', preview: null };
  private dial: { end: string; custom: string; plan: DialBackPlan | null; error: string } = { end: '', custom: '', plan: null, error: '' };
  private pause: { mode: 'off' | 'weights'; weights: Record<string, string>; until: string; meter: string } = { mode: 'off', weights: {}, until: '', meter: '' };
  private add = { pick: '', error: '' };

  get form(): Form { return this.forms[this.view]; }

  badge(ctx: Ctx): string {
    const n = pendingCount(ctx.state.config) + ctx.state.editState.held.length;
    return n ? String(n) : '';
  }

  typing(): boolean { return this.form.typing(); }

  draw(screen: Screen, r: Rect, ctx: Ctx): void {
    this.form.draw(screen, inset(r, 0, 1), this.rows(ctx), ctx.theme);
  }

  async key(key: Key, ctx: Ctx): Promise<boolean> {
    if (this.form.typing()) return this.form.key(key, this.rows(ctx));
    if (key.label === 'escape' && this.view !== 'list') { this.view = this.view === 'wait' ? 'detail' : 'list'; return true; }
    if (this.view === 'list' || this.view === 'detail') {
      if (key.label === 'c') { this.view = 'history'; this.forms.history = new Form(); return true; }
      if (key.label === 'd') { this.openDial(ctx); return true; }
    }
    if (this.view === 'list') {
      if (key.label === '/') { this.forms.list.edit('query', this.query); return true; }
      if (key.label === 'f') { const i = RULE_FILTERS.findIndex(([v]) => v === this.filter); this.filter = RULE_FILTERS[(i + 1) % RULE_FILTERS.length]![0]; return true; }
    }
    return this.form.key(key, this.rows(ctx));
  }

  hints(ctx: Ctx): Hint[] {
    const form = this.form.hints(this.rows(ctx));
    if (this.form.typing()) return form;
    const back: Hint[] = this.view === 'list' ? [] : [['Esc', RULES_TUI_TEXT.back]];
    const tools: Hint[] = this.view === 'list' ? [['/', RULES_TUI_TEXT.search], ['f', RULES_TUI_TEXT.filter], ['c', RULES_TUI_TEXT.history], ['d', RULES_TUI_TEXT.dial]]
      : this.view === 'detail' ? [['c', RULES_TUI_TEXT.history], ['d', RULES_TUI_TEXT.dial]] : [];
    return [...form, ...back, ...tools];
  }

  /** Saves the config with one change made to its rules. */
  private async edit(ctx: Ctx, change: (policy: PolicyConfig) => void, note = ''): Promise<void> {
    const c = structuredClone(ctx.state.config);
    c.policy ??= emptyPolicy();
    change(c.policy);
    await this.act(ctx, 'saveConfig', [c], note);
  }

  /** Runs an engine command and shows `note` once it succeeds, or the error when it fails. */
  private async act(ctx: Ctx, method: string, args: unknown[], note = ''): Promise<void> {
    try {
      await ctx.link.run(method, ...args);
      if (note) ctx.flash(note);
    } catch (e) { ctx.flash((e as Error).message || 'That did not work.', true); }
  }

  openDetail(provider: string, model: string | null): void {
    this.sel = { provider, model };
    this.view = 'detail';
    this.forms.detail = new Form();
    this.pause = { mode: 'off', weights: {}, until: '', meter: '' };
    this.add = { pick: '', error: '' };
  }

  private openDial(ctx: Ctx): void {
    const choices = dialEndChoices(ctx.state.snapshot, policyProviders(ctx.state.config), ctx.now);
    this.dial = { end: choices[0]?.value ?? 'custom', custom: '', plan: null, error: '' };
    this.forms.dial = new Form();
    this.view = 'dial';
  }

  rows(ctx: Ctx): Row[] {
    switch (this.view) {
      case 'detail': return this.detailRows(ctx);
      case 'wait': return this.waitRows(ctx);
      case 'history': return this.historyRows(ctx);
      case 'dial': return this.dialRows(ctx);
      default: return this.listRows(ctx);
    }
  }

  // ---------------------------------------------------------------- list

  private listRows(ctx: Ctx): Row[] {
    const { state, theme } = ctx, policy = policyOf(state);
    const rows: Row[] = [{ kind: 'note', text: RULES_TEXT.sub }];
    if (state.policyError) {
      rows.push({ kind: 'note', text: `${RULES_TEXT.policyFailed} ${RULES_TEXT.policyOlder} ${state.policyError}`, style: 'crit' });
      rows.push({ kind: 'action', id: 'retry', label: '', button: RULES_TUI_TEXT.retry, run: () => this.act(ctx, 'retryPolicy', []) });
    }
    for (const h of heldRows(state.editState)) {
      rows.push({ kind: 'note', text: RULES_TEXT.held(h), style: 'bold' });
      if (h.reason) rows.push({ kind: 'note', text: h.reason });
      rows.push({ kind: 'buttons', id: `held:${h.id}`, label: '', buttons: [
        { button: RULES_TUI_TEXT.accept, run: () => this.act(ctx, 'answerEdit', [h.id, true]) },
        { button: RULES_TUI_TEXT.dismiss, run: () => this.act(ctx, 'answerEdit', [h.id, false]) },
      ] });
    }
    const pending = pendingCount(state.config);
    if (pending) {
      rows.push({ kind: 'note', text: RULES_TEXT.pending(pending), style: 'warn' });
      if (this.filter !== 'needs') rows.push({ kind: 'action', id: 'show-pending', label: '', button: RULES_TUI_TEXT.showThem, run: () => { this.filter = 'needs'; } });
    }
    rows.push({ kind: 'text', id: 'query', label: RULES_TUI_TEXT.search, value: this.query, placeholder: RULES_TUI_TEXT.searchHint, save: (v) => { this.query = v; } });
    rows.push({ kind: 'choice', id: 'filter', label: RULES_TUI_TEXT.filter, value: this.filter, options: RULE_FILTERS, set: (v) => { this.filter = v as RulesFilter; } });

    const searching = this.query.trim() !== '' || this.filter !== 'all';
    let shown = 0;
    for (const meta of policyProviders(state.config)) {
      const p = policy.providers[meta.id] ?? { defaults: {}, models: {} };
      const list = Object.entries(p.models).filter(([label, m]) => ruleMatches(this.filter, this.query, label, m)).sort(([a], [b]) => a.localeCompare(b));
      if (searching && !list.length) continue;
      shown++;
      const { total, pending: waiting, drained } = providerCounts(policy, meta.id);
      const open = this.open.has(meta.id) || searching;
      const keys = list.map(([label]) => `${meta.id}|${label}`), all = keys.length > 0 && keys.every((k) => this.picked.has(k));
      rows.push({
        kind: 'item', id: `prov:${meta.id}`, label: meta.name, dot: theme.provider(meta.id), open, right: models(total),
        chips: [...(meta.metered ? [] : [[RULES_TEXT.noUsage, theme.muted] as const]), ...(drained ? [[RULES_TEXT.usedUpFirst, theme.muted] as const] : []), ...(this.stances[meta.id] && RULES_TEXT.stance[this.stances[meta.id]!] ? [[RULES_TEXT.stance[this.stances[meta.id]!]!, theme.muted] as const] : []), ...(waiting ? [[RULES_TEXT.review(waiting), theme.warn] as const] : [])],
        enter: () => { if (this.open.has(meta.id)) this.open.delete(meta.id); else this.open.add(meta.id); },
        enterLabel: open ? RULES_TUI_TEXT.hideModels : RULES_TUI_TEXT.showModels,
        ...(open && keys.length ? { pick: all, setPick: (on: boolean) => this.pickMany(keys, on) } : {}),
      });
      if (!open) continue;
      rows.push({ kind: 'item', id: `def:${meta.id}`, indent: true, label: RULES_TEXT.defaults, sub: RULES_TEXT.defaultsSum, enter: () => this.openDetail(meta.id, null), enterLabel: RULES_TUI_TEXT.open });
      for (const [label, m] of list) {
        const key = `${meta.id}|${label}`, pause = m.rule.pause ?? p.defaults.pause;
        rows.push({
          kind: 'item', id: `m:${key}`, indent: true, label: m.name ?? m.id, sub: `${label}, ${ruleSummary(meta.id, p.defaults, m)}`,
          pick: this.picked.has(key), setPick: (on: boolean) => this.pickMany([key], on),
          chips: [...(m.status === 'confirmed' ? [] : [[STATUS_LABELS[m.status], m.status === 'unreviewed' ? theme.warn : theme.muted] as const]),
            ...(pauseActive(pause, new Date(ctx.now)) ? [[RULES_TEXT.pausedChip(!!pause?.weights), theme.muted] as const] : [])],
          enter: () => this.openDetail(meta.id, label), enterLabel: RULES_TUI_TEXT.open,
        });
      }
      if (!list.length) rows.push({ kind: 'note', text: RULES_TEXT.noModels, indent: true });
    }
    if (!shown) rows.push({ kind: 'note', text: RULES_TEXT.noMatch });
    if (this.picked.size) rows.push(...this.bulkRows(ctx));
    return rows;
  }

  private pickMany(keys: string[], on: boolean): void {
    for (const k of keys) if (on) this.picked.add(k); else this.picked.delete(k);
    this.note = '';
    this.bulk.preview = null;
  }

  private bulkRows(ctx: Ctx): Row[] {
    const picked = [...this.picked].map((k) => k.split('|') as [string, string]), n = picked.length, b = this.bulk;
    const status = (s: 'confirmed' | 'hidden') => this.edit(ctx, (pol) => { for (const [pid, label] of picked) setModelStatus(pol, pid, label, s, DEVICE); }).then(() => { this.note = RULES_TEXT.bulkStatus(s, n); });
    const def = BULK_FIELDS.find((f) => f.field === b.field) ?? BULK_FIELDS[0]!;
    const rows: Row[] = [
      { kind: 'heading', text: RULES_TUI_TEXT.selected(n) },
      { kind: 'buttons', id: 'bulk', label: '', buttons: [
        { button: RULES_TUI_TEXT.confirm, run: () => status('confirmed') },
        { button: RULES_TUI_TEXT.hide, run: () => status('hidden') },
        { button: RULES_TUI_TEXT.clear, run: () => { this.picked.clear(); this.note = ''; b.preview = null; } },
      ] },
      { kind: 'choice', id: 'bulk-act', label: RULES_TUI_TEXT.activity, value: b.act, options: ACTIVITIES.map((a) => [a, ACTIVITY_LABELS[a]] as const), set: (v) => { b.act = v as ActivityId; } },
      { kind: 'choice', id: 'bulk-level', label: RULES_TUI_TEXT.weight, value: b.level, options: [['', RULES_TEXT.providerDefault], ['none', RULES_TEXT.notAllowed], ...levels()], set: (v) => { b.level = v; } },
      { kind: 'action', id: 'bulk-act-apply', label: '', button: RULES_TUI_TEXT.apply, run: async () => {
        const value = b.level === '' ? undefined : b.level === 'none' ? null : b.level;
        await this.edit(ctx, (pol) => { for (const [pid, label] of picked) setFieldMany(pol, pid, [label], `activities.${b.act}`, value, DEVICE); });
        this.note = RULES_TEXT.bulkSet(ACTIVITY_LABELS[b.act], RULES_TEXT.weightName(b.level), n);
      } },
      { kind: 'choice', id: 'bulk-field', label: RULES_TUI_TEXT.field, value: b.field, options: BULK_FIELDS.map((f) => [f.field, f.label] as const), set: (v) => { b.field = v as BulkPreview['field']; b.value = ''; b.preview = null; } },
      def.kind === 'text'
        ? { kind: 'text', id: 'bulk-value', label: RULES_TUI_TEXT.value, value: b.value, placeholder: RULES_TEXT.followsProvider, save: (v) => { b.value = v; b.preview = null; } }
        : { kind: 'choice', id: 'bulk-value', label: RULES_TUI_TEXT.value, value: b.value, set: (v) => { b.value = v; b.preview = null; },
          options: [['', RULES_TEXT.providerDefault], ...(def.kind === 'bool' ? [['yes', 'Yes'], ['no', 'No']] as const : (def.choices ?? []).map((c) => [c, VALUE_LABELS[def.field]?.[c] ?? c] as const))] },
    ];
    const pv = b.preview;
    if (!pv) {
      rows.push({ kind: 'action', id: 'bulk-preview', label: '', button: RULES_TUI_TEXT.preview, run: () => {
        const r = previewBulk(policyOf(ctx.state), this.picked, b.field, b.value);
        if ('error' in r) { this.note = r.error; b.preview = null; } else { b.preview = r; this.note = ''; }
      } });
    } else {
      const label = BULK_FIELDS.find((f) => f.field === pv.field)?.label ?? pv.field, k = pv.changes.length;
      rows.push({ kind: 'note', text: `${label}: ${RULES_TEXT.bulkCount(k, previewValue(pv.field, pv.value))}${RULES_TEXT.bulkAlready(k, pv.unchanged)}`, style: 'bold' });
      for (const c of pv.changes.slice(0, 8)) rows.push({ kind: 'note', text: `${c.label} ${previewValue(pv.field, c.from)} to ${previewValue(pv.field, c.to)}`, indent: true });
      if (k > 8) rows.push({ kind: 'note', text: RULES_TEXT.more(k - 8), indent: true });
      rows.push({ kind: 'buttons', id: 'bulk-apply', label: '', buttons: [
        ...(k ? [{ button: RULES_TUI_TEXT.apply, run: async () => {
          await this.edit(ctx, (pol) => { for (const c of pv.changes) setField(pol, c.path, pv.value, DEVICE); });
          this.note = RULES_TEXT.bulkChanged(label, k);
          b.preview = null;
        } }] : []),
        { button: k ? RULES_TUI_TEXT.cancel : RULES_TUI_TEXT.close, run: () => { b.preview = null; } },
      ] });
    }
    if (this.note) rows.push({ kind: 'note', text: this.note, style: 'good' });
    return rows;
  }

  // ---------------------------------------------------------------- one model's rules

  private detailRows(ctx: Ctx): Row[] {
    const { state } = ctx, policy = policyOf(state);
    if (!this.sel) return [{ kind: 'note', text: RULES_TEXT.choose }];
    const { provider: pid, model } = this.sel, meta = policyProviders(state.config).find((p) => p.id === pid);
    const p = policy.providers[pid] ?? { defaults: {}, models: {} }, entry = model ? p.models[model] : undefined;
    if (!meta || (model && !entry)) return [{ kind: 'note', text: RULES_TEXT.gone }];
    const rule: Rule = entry ? entry.rule : p.defaults, d: Rule = p.defaults, isModel = model !== null;
    const path = (field: string) => fieldPath(pid, model, field);
    const set = (field: string, value: unknown) => this.edit(ctx, (pol) => setField(pol, path(field), value, DEVICE));

    const enumChoice = (field: 'dataTier' | 'output' | 'cost', label: string, values: readonly string[], names: Record<string, string>, unset: string, desc?: string): Row => {
      const own = rule[field], inherited = d[field];
      const fallback = values.find((v) => (names[v] ?? v) === unset) ?? '';
      const options: Array<readonly [string, string]> = values.map((v) => [v, names[v] ?? v]);
      if (isModel) options.unshift(['', `Default (${inherited === undefined ? unset : names[String(inherited)] ?? String(inherited)})`]);
      return { kind: 'choice', id: field, label, desc, value: own === undefined ? (isModel ? '' : fallback) : String(own), options, set: (v) => set(field, v === '' ? undefined : v) };
    };
    const boolChoice = (field: 'askFirst' | 'sandbox', label: string, desc?: string): Row => {
      const own = rule[field], yn = (b: boolean | undefined) => (b ? 'Yes' : 'No');
      const options: Array<readonly [string, string]> = [['yes', 'Yes'], ['no', 'No']];
      if (isModel) options.unshift(['', `Default (${yn(d[field])})`]);
      return { kind: 'choice', id: field, label, desc, value: own === undefined ? (isModel ? '' : 'no') : own ? 'yes' : 'no', options, set: (v) => set(field, v === '' ? undefined : v === 'yes') };
    };
    const handlingText = (key: 'hostCountry' | 'pinnedHost', label: string, placeholder: string): Row => {
      const theirs = isModel ? d.dataHandling?.[key] : undefined;
      return { kind: 'text', id: `dh-${key}`, label, value: rule.dataHandling?.[key] ?? '', placeholder: theirs ? `Default (${theirs})` : placeholder, save: (v) => set(`dataHandling.${key}`, v || undefined) };
    };
    const tri = (key: 'retainsPrompts' | 'trainsOnPrompts', label: string): Row => {
      const mine = rule.dataHandling?.[key], word = (v: boolean | null | undefined) => (v === true ? 'Yes' : v === false ? 'No' : RULES_TEXT.unknown);
      const options: Array<readonly [string, string]> = isModel ? [['', `Default (${word(d.dataHandling?.[key])})`], ['unknown', RULES_TEXT.unknown]] : [['', RULES_TEXT.unknown]];
      return {
        kind: 'choice', id: `dh-${key}`, label, value: mine === undefined ? '' : mine === true ? 'yes' : mine === false ? 'no' : 'unknown', options: [...options, ['yes', 'Yes'], ['no', 'No']],
        set: (v) => set(`dataHandling.${key}`, v === '' ? undefined : v === 'yes' ? true : v === 'no' ? false : null),
      };
    };

    const rows: Row[] = [
      { kind: 'heading', text: entry ? entry.name ?? entry.id : RULES_TEXT.defaultsTitle(meta.name) },
      { kind: 'note', text: isModel ? `${model}, ${entry!.id}` : RULES_TEXT.defaultsSub(meta.name) },
    ];
    if (entry) {
      rows.push({ kind: 'note', text: statusText(policy, pid, entry), style: entry.status === 'confirmed' ? 'good' : entry.status === 'hidden' ? 'muted' : 'warn' });
      const status = (s: ModelEntry['status']) => () => this.edit(ctx, (pol) => setModelStatus(pol, pid, model!, s, DEVICE));
      rows.push({ kind: 'buttons', id: 'status', label: '', buttons: [
        ...(entry.status === 'confirmed' || entry.status === 'hidden' ? [] : [{ button: RULES_TEXT.confirm, run: status('confirmed') }]),
        entry.status === 'hidden' ? { button: RULES_TEXT.show, run: status('unreviewed') } : { button: RULES_TEXT.hide, run: status('hidden') },
      ] });
    }

    rows.push({ kind: 'heading', text: RULES_TEXT.activities });
    for (const a of ACTIVITIES) {
      const own = rule.activities?.[a], inherited = d.activities?.[a];
      const first: Array<readonly [string, string]> = isModel ? [['', `Default (${inherited ? WEIGHT_LABELS[inherited] : RULES_TEXT.notAllowed})`], ['none', RULES_TEXT.notAllowed]] : [['', RULES_TEXT.notAllowed]];
      rows.push({ kind: 'choice', id: `act-${a}`, label: ACTIVITY_LABELS[a], value: own === undefined ? '' : own === null ? 'none' : own, options: [...first, ...levels()],
        set: (v) => set(`activities.${a}`, v === '' ? undefined : v === 'none' ? null : v) });
    }

    rows.push({ kind: 'heading', text: RULES_TEXT.data });
    rows.push(enumChoice('dataTier', RULES_TEXT.dataTier, DATA_TIERS, DATA_TIER_LABELS, 'Public', RULES_TEXT.dataTierHelp));
    rows.push(handlingText('hostCountry', RULES_TEXT.hostCountry, 'US'), tri('retainsPrompts', RULES_TEXT.retains), tri('trainsOnPrompts', RULES_TEXT.trains), handlingText('pinnedHost', RULES_TEXT.pinnedHost, 'None'));

    rows.push({ kind: 'heading', text: RULES_TEXT.use });
    rows.push(boolChoice('askFirst', RULES_TEXT.askFirst, RULES_TEXT.askFirstHelp), enumChoice('output', RULES_TEXT.output, OUTPUT_MODES, OUTPUT_LABELS, 'Text only'),
      boolChoice('sandbox', RULES_TEXT.sandbox), enumChoice('cost', RULES_TEXT.cost, COST_TIERS, COST_LABELS, 'Moderate', RULES_TEXT.costHelp));
    if (isModel) {
      const n = (rule.useAfter ?? d.useAfter ?? []).length;
      rows.push({ kind: 'action', id: 'wait', label: RULES_TEXT.wait, desc: RULES_TEXT.waitHelp, button: RULES_TUI_TEXT.waitButton(n), run: () => { this.view = 'wait'; this.forms.wait = new Form(); } });
    }
    rows.push({ kind: 'text', id: 'effort', label: RULES_TEXT.effort, value: rule.effort ?? '', placeholder: isModel ? d.effort ?? 'Default' : 'Default', save: (v) => set('effort', v || undefined) });

    rows.push({ kind: 'heading', text: RULES_TEXT.pause }, ...this.pauseRows(ctx, pid, model, rule.pause, d.pause));
    if (!isModel && meta.metered) rows.push({ kind: 'heading', text: RULES_TEXT.limits }, ...this.thresholdRows(ctx, pid));
    rows.push({ kind: 'heading', text: RULES_TEXT.notes });
    rows.push({ kind: 'text', id: 'notes', label: RULES_TEXT.notes, value: rule.notes ?? '', placeholder: isModel && d.notes ? d.notes : RULES_TEXT.notesHint, save: (v) => set('notes', v || undefined) });
    if (!isModel) rows.push(...this.modelListRows(ctx, pid, p.listMode, Object.values(p.models).map((x) => x.id)));
    return rows;
  }

  private pauseRows(ctx: Ctx, pid: string, model: string | null, own: Rule['pause'], inherited: Rule['pause']): Row[] {
    const path = fieldPath(pid, model, 'pause'), { meters, blocked } = pauseResets(ctx.state.snapshot, pid, ctx.now);
    const known = ctx.state.snapshot?.providers[pid]?.meters ?? [];
    const shown = own ?? (model !== null ? inherited : null);
    if (shown && pauseActive(shown, new Date(ctx.now))) {
      const rows: Row[] = [{ kind: 'note', text: pauseText(shown, known.find((x) => x.id === shown.meter)?.label, own === undefined) }];
      if (own) rows.push({ kind: 'action', id: 'resume', label: '', button: RULES_TEXT.resume, run: () => this.edit(ctx, (pol) => setField(pol, path, undefined, DEVICE)) });
      return rows;
    }
    const ps = this.pause;
    const rows: Row[] = [{ kind: 'choice', id: 'pause-mode', label: RULES_TEXT.pauseMode, desc: RULES_TEXT.pauseModeHelp, value: ps.mode,
      options: [['off', RULES_TEXT.pauseStop], ['weights', RULES_TEXT.pauseWeights]], set: (v) => { ps.mode = v === 'weights' ? 'weights' : 'off'; } }];
    if (ps.mode === 'weights') {
      for (const a of ACTIVITIES) rows.push({ kind: 'choice', id: `pw-${a}`, label: ACTIVITY_LABELS[a], indent: true, value: ps.weights[a] ?? '',
        options: [['', RULES_TEXT.leaveAsIs], ['none', RULES_TEXT.notAllowed], ...levels()], set: (v) => { ps.weights[a] = v; } });
    }
    rows.push({ kind: 'text', id: 'pause-until', label: RULES_TEXT.pauseUntil, desc: `${RULES_TEXT.pauseUntilHelp} ${RULES_TUI_TEXT.whenHelp}`, value: ps.until,
      save: (v) => { if (v && !parseWhen(v, ctx.now)) ctx.flash(RULES_TUI_TEXT.whenBad, true); else { ps.until = v; if (v) ps.meter = ''; } } });
    if (blocked) rows.push({ kind: 'note', text: blocked });
    if (meters.length) rows.push({ kind: 'choice', id: 'pause-meter', label: RULES_TEXT.pauseReset, value: ps.meter,
      options: [['', RULES_TEXT.chooseMeter], ...meters.map((x) => [x.id, x.label] as const)], set: (v) => { ps.meter = v; } });
    rows.push({ kind: 'action', id: 'pause', label: '', button: RULES_TUI_TEXT.pauseNow, run: async () => {
      const meter = ps.meter ? meters.find((x) => x.id === ps.meter) : undefined;
      const until = meter ? meter.resetsAt : ps.until ? parseWhen(ps.until, ctx.now) : null;
      if (!until) { ctx.flash(RULES_TUI_TEXT.pauseNeed, true); return; }
      if (Date.parse(until) <= ctx.now) { ctx.flash(RULES_TEXT.future, true); return; }
      const weights = ps.mode === 'weights' ? Object.fromEntries(Object.entries(ps.weights).filter(([, v]) => v !== '').map(([a, v]) => [a, v === 'none' ? null : v])) : null;
      await this.edit(ctx, (pol) => setField(pol, path, { until, weights: weights && Object.keys(weights).length ? weights : null, ...(meter ? { meter: meter.id } : {}) }, DEVICE));
      this.pause = { mode: 'off', weights: {}, until: '', meter: '' };
    } });
    return rows;
  }

  private thresholdRows(ctx: Ctx, pid: string): Row[] {
    const policy = policyOf(ctx.state), own = policy.providers[pid]?.thresholds ?? {}, t = resolveThresholds(policy.providers[pid]);
    const num = (key: 'warnPct' | 'denyPct' | 'minBalance', label: string, desc: string): Row => ({
      kind: 'text', id: `t-${key}`, label, desc, value: own[key] === undefined ? '' : String(own[key]), placeholder: t[key] === undefined || t[key] === null ? 'None' : String(t[key]),
      save: (v) => {
        const n = Number(v);
        if (v !== '' && (!Number.isFinite(n) || n < 0)) { ctx.flash(RULES_TUI_TEXT.numberBad, true); return; }
        return this.edit(ctx, (pol) => setField(pol, fieldPath(pid, null, `thresholds.${key}`), v === '' ? undefined : n, DEVICE));
      },
    });
    return [num('warnPct', RULES_TEXT.warnAt, RULES_TEXT.warnHelp), num('denyPct', RULES_TEXT.stopAt, RULES_TEXT.stopHelp), num('minBalance', RULES_TEXT.minBalance, RULES_TEXT.minBalanceHelp)];
  }

  private modelListRows(ctx: Ctx, pid: string, own: 'auto' | 'catalog' | undefined, have: string[]): Row[] {
    const { state } = ctx, plugin = allPlugins(state.config).find((x) => x.id === pid), entry = state.catalog[pid], listing = state.listing.includes(pid);
    const rows: Row[] = [];
    if (plugin?.listModels) {
      const fallback = plugin.modelListMode ?? 'auto';
      rows.push({ kind: 'heading', text: RULES_TEXT.modelList });
      rows.push({ kind: 'choice', id: 'listMode', label: RULES_TEXT.newModels, desc: RULES_TEXT.listHelp, value: own ?? '',
        options: [['', `Default (${LIST_MODE_LABELS[fallback]})`], ['auto', LIST_MODE_LABELS.auto], ['catalog', LIST_MODE_LABELS.catalog]],
        set: (v) => this.edit(ctx, (pol) => setField(pol, fieldPath(pid, null, 'listMode'), v || undefined, DEVICE)) });
      rows.push({ kind: 'note', text: listing ? RULES_TEXT.checking : entry ? RULES_TEXT.checked(ago(entry.fetchedAt, ctx.now), latestOnly(entry.models).length, entry.error ?? undefined) : RULES_TEXT.notChecked });
      rows.push({ kind: 'action', id: 'list-now', label: '', button: RULES_TEXT.checkNow, disabled: listing, run: () => this.act(ctx, 'listModels', [pid]) });
    }
    const choices = entry ? latestOnly(entry.models).filter((x) => !have.includes(x.id)) : [];
    rows.push({ kind: 'heading', text: RULES_TEXT.addModel });
    if (choices.length) {
      rows.push({ kind: 'choice', id: 'add-pick', label: RULES_TUI_TEXT.addFrom, value: this.add.pick, options: [['', RULES_TUI_TEXT.choose], ...choices.map((x) => [x.id, x.name ? `${x.name} (${x.id})` : x.id] as const)], set: (v) => { this.add.pick = v; } });
      rows.push({ kind: 'action', id: 'add-picked', label: '', button: RULES_TUI_TEXT.add, disabled: !this.add.pick, run: () => this.addModel(ctx, pid, this.add.pick) });
    }
    rows.push({ kind: 'text', id: 'add-id', label: RULES_TUI_TEXT.addId, value: '', placeholder: RULES_TEXT.addHint, save: (v) => this.addModel(ctx, pid, v) });
    rows.push(this.add.error ? { kind: 'note', text: this.add.error, style: 'crit' } : { kind: 'note', text: RULES_TEXT.addHelp });
    return rows;
  }

  private async addModel(ctx: Ctx, pid: string, id: string): Promise<void> {
    if (!validModelId(id)) { this.add.error = RULES_TEXT.badId; return; }
    const plugin = allPlugins(ctx.state.config).find((x) => x.id === pid), label = `${plugin?.labelPrefix ?? pid}/${id}`;
    const name = ctx.state.catalog[pid]?.models.find((x) => x.id === id)?.name;
    const c = structuredClone(ctx.state.config);
    c.policy ??= emptyPolicy();
    if (!addModels(c.policy, pid, [{ label, id, name }], 'manual').length) { this.add.error = RULES_TEXT.listed(id); return; }
    this.open.add(pid);
    this.openDetail(pid, label);
    await this.act(ctx, 'saveConfig', [c]);
  }

  /** The other models this one may wait on, each with a tick box. */
  private waitRows(ctx: Ctx): Row[] {
    const sel = this.sel, policy = policyOf(ctx.state);
    if (!sel?.model) return [{ kind: 'note', text: RULES_TEXT.choose }];
    const { provider: pid, model } = sel, p = policy.providers[pid], entry = p?.models[model];
    if (!p || !entry) return [{ kind: 'note', text: RULES_TEXT.gone }];
    const now = entry.rule.useAfter ?? p.defaults.useAfter ?? [], on = new Set(now), path = fieldPath(pid, model, 'useAfter');
    const others = Object.values(policy.providers).flatMap((q) => Object.entries(q.models).filter(([label, x]) => label !== model && x.status !== 'hidden').map(([label, x]) => ({ label, name: x.name ?? x.id })));
    const toggle = (label: string, tick: boolean) => {
      const next = tick ? [...new Set([...now, label])] : now.filter((x) => x !== label);
      return this.edit(ctx, (pol) => setField(pol, path, next.length ? next : undefined, DEVICE));
    };
    const rows: Row[] = [{ kind: 'heading', text: `${RULES_TEXT.wait}: ${entry.name ?? entry.id}` }, { kind: 'note', text: RULES_TEXT.waitHelp }];
    for (const x of others) rows.push({ kind: 'item', id: `w:${x.label}`, label: x.name, chips: [[x.label, ctx.theme.muted]], pick: on.has(x.label),
      setPick: (tick: boolean) => toggle(x.label, tick), enter: () => toggle(x.label, !on.has(x.label)), enterLabel: RULES_TUI_TEXT.tick });
    if (!others.length) rows.push({ kind: 'note', text: RULES_TEXT.waitNone });
    return rows;
  }

  // ---------------------------------------------------------------- history and dial-back

  private historyRows(ctx: Ctx): Row[] {
    const policy = policyOf(ctx.state), names = new Map(policyProviders(ctx.state.config).map((p) => [p.id, p.name]));
    const rows: Row[] = [{ kind: 'heading', text: RULES_TEXT.historyTitle }, { kind: 'note', text: RULES_TEXT.historySub }];
    const list = policy.history.map((c, i) => ({ c, i })).reverse().slice(0, 200);
    for (const { c, i } of list) {
      const d = describeChange(c, (pid) => names.get(pid) ?? pid);
      rows.push({ kind: 'item', id: `h:${i}`, label: `${d.who} ${d.field}: ${d.text}`, sub: RULES_TEXT.changedOn(c.at, c.device), enterLabel: RULES_TUI_TEXT.undo,
        enter: () => this.edit(ctx, (pol) => { const change = pol.history[i]; if (change) undoChange(pol, change, DEVICE); }) });
    }
    if (!list.length) rows.push({ kind: 'note', text: RULES_TEXT.noHistory });
    return rows;
  }

  private dialRows(ctx: Ctx): Row[] {
    const choices = dialEndChoices(ctx.state.snapshot, policyProviders(ctx.state.config), ctx.now), dl = this.dial, plan = dl.plan;
    const rows: Row[] = [
      { kind: 'heading', text: RULES_TEXT.dialTitle },
      { kind: 'note', text: RULES_TEXT.dialHelp },
      { kind: 'choice', id: 'dial-end', label: RULES_TEXT.dialUntil, value: dl.end, options: [...choices.map((c) => [c.value, c.label] as const), ['custom', RULES_TEXT.dialCustom]],
        set: (v) => { dl.end = v; dl.plan = null; dl.error = ''; } },
    ];
    const custom = dl.end === 'custom' || !choices.length;
    if (custom) rows.push({ kind: 'text', id: 'dial-custom', label: RULES_TEXT.dateTime, desc: RULES_TUI_TEXT.whenHelp, value: dl.custom, save: (v) => { dl.custom = v; dl.plan = null; dl.error = ''; } });
    if (dl.error) rows.push({ kind: 'note', text: dl.error, style: 'crit' });
    if (plan) {
      rows.push({ kind: 'note', text: `${RULES_TEXT.planCount(plan.items.length)} ${RULES_TEXT.leftAlone(plan.skipped)}`, style: 'bold' });
      for (const i of plan.items.slice(0, 10)) rows.push({ kind: 'note', text: `${i.label} ${RULES_TEXT.planAction(i.action)}`, indent: true });
      if (plan.items.length > 10) rows.push({ kind: 'note', text: RULES_TEXT.more(plan.items.length - 10), indent: true });
    }
    rows.push({ kind: 'buttons', id: 'dial', label: '', buttons: [
      { button: RULES_TUI_TEXT.preview, run: () => {
        const chosen = custom ? null : choices.find((c) => c.value === dl.end) ?? choices[0];
        const until = chosen ? chosen.until : parseWhen(dl.custom, ctx.now);
        if (!until || Date.parse(until) <= ctx.now) { dl.error = RULES_TEXT.future; dl.plan = null; return; }
        dl.error = '';
        dl.plan = planDialBack(policyOf(ctx.state), until, new Date(ctx.now));
      } },
      ...(plan?.items.length ? [{ button: RULES_TUI_TEXT.apply, run: async () => {
        await this.edit(ctx, (pol) => { for (const item of plan.items) setField(pol, item.path, pauseValue(item, plan.until), DEVICE); }, RULES_TEXT.dialDone(plan.items.length, plan.until));
        this.view = 'list';
      } }] : []),
      { button: RULES_TUI_TEXT.close, run: () => { this.view = 'list'; } },
    ] });
    return rows;
  }
}
