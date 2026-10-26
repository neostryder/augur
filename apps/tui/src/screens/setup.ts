// The setup interview. Choices go through the shared steps in view-model. This file draws them and edits the answer object.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ACTIVITIES, allPlugins, applyEdit, emptyPolicy, type EngineState } from '@augur/core';
import { augurHome } from '@augur/augurd';
import type { UsageSnapshot } from '@augur/dispatch-protocol';
import { routeSecretName } from '@augur/dispatch-protocol';
import { inset, type Key, type Rect, type Screen } from '@augur/terminal';
import {
  DISPATCH_TEXT, HOLD_BACK, SETUP_STEPS, afterApply, answersFromCurrent, answersFromProfile, applyProvider, applySteps, emptyAnswers, emptyProviderForm, isValid, planOfForm, planRows, planSetup, problems, providerFields, stepStatus, summaryLines,
} from '@augur/view-model';
import type { DetectedProvider, HoldChoice, ProviderFormState, SetupAnswers, SetupCurrent, SetupOp, SetupPlan, StackId, StepId, Strength } from '@augur/view-model';
import { parseRoutesText } from '@augur/view-model';
import type { Ctx, Hint, Page } from '../page.js';

/** Subscriptions the interview can ask about when detection did not see them. API services use the Add provider form. */
const SUBSCRIPTIONS = new Set(['claude', 'codex', 'grok', 'minimax', 'copilot']);
const WINDOW_IDS = new Set(['claude', 'codex', 'grok', 'minimax']);
const ORDER: StepId[] = ['stack', 'providers', 'pace', 'review', 'done'];
const HOLD_CHOICES: Array<Exclude<HoldChoice, 'custom'>> = ['free', 'some', 'save'];
const STRENGTHS: Strength[] = ['strong', 'light', 'unsure'];
const WIDE = 100;
const SUMMARY_COL = 120;

const STACKS: Array<{ id: StackId; title: string; help: string }> = [
  { id: 'claude-only', title: 'Claude only', help: 'One Claude plan. Augur keeps it on pace and has nothing else to balance.' },
  { id: 'several', title: 'Several subscriptions', help: 'Claude plus other plans such as Codex, Grok, or Copilot. You choose which ones to pace and the order Augur uses them in.' },
  { id: 'api-only', title: 'API keys only', help: 'You pay per use, so nothing is paced. Name the providers and a monthly amount to stay under.' },
  { id: 'profile', title: 'Start from a profile file', help: 'Load a setup exported from another computer. The file holds no keys, and Augur checks all of it before anything changes.' },
];

const HOLD_LABEL: Record<Exclude<HoldChoice, 'custom'>, string> = {
  free: 'Use it freely',
  some: 'Keep some back',
  save: 'Save it for the work only it does',
};

const STRENGTH_LABEL: Record<Strength, string> = { strong: 'Strong', light: 'Light', unsure: 'Not sure' };
const SHORT: Record<StepId, string> = { stack: 'Stack', providers: 'Providers', pace: 'Pace', review: 'Review', done: 'Done' };

/** The terminal app runs on the computer beside the service, so its edits carry the same device name as the Rules screen. */
const DEVICE = 'desktop';
const SETTLED = ['completed', 'failed', 'artifact_validation_failed', 'cancelled', 'killed', 'lost'];

/** Shown for a subscription whose current reserve and band match none of the three choices. */
const CUSTOM_HOLD = 'This subscription has custom values from your current setup. They stay unless you pick one of the choices above.';

/** "1 change", "3 changes". */
const changeCount = (n: number): string => `${n} change${n === 1 ? '' : 's'}`;

export interface TuiTrack {
  id: string;
  name: string;
  enabled: boolean;
  signedIn: boolean;
  hasWindow: boolean;
  locked: boolean;
}

export interface TuiApply {
  ran: string[];
  failed: { id: string; error: string } | null;
  complete: boolean;
}

export interface TuiModel {
  step: StepId;
  cursor: number;
  answers: SetupAnswers;
  current: SetupCurrent;
  plan: SetupPlan;
  tracks: TuiTrack[];
  /** Steps the person has left. A ready step keeps its number until then. */
  seen: StepId[];
  firstRun: boolean;
  profilePath: string;
  profileProblems: string[];
  apply: TuiApply | null;
  add: ProviderFormState | null;
  addError: string;
  adding: boolean;
  routeNotes: Record<string, string>;
  testing: string | null;
  busy: boolean;
  typing: { id: string; value: string } | null;
}

export interface TuiOpen {
  firstRun: boolean;
  current: SetupCurrent;
  tracks: TuiTrack[];
}

export type SetupEffect =
  | { kind: 'apply' }
  | { kind: 'skip' }
  | { kind: 'leave' }
  | { kind: 'profile'; path: string }
  | { kind: 'add' }
  | { kind: 'test'; name: string }
  | { kind: 'rules'; provider: string; model: string }
  | { kind: 'track'; id: string; on: boolean }
  | { kind: 'detect' };

export interface ReduceResult { model: TuiModel; effect: SetupEffect | null; handled: boolean }

interface Item { id: string; text: string; disabled?: boolean }
type Block = { kind: 'note'; text: string } | { kind: 'item'; item: Item };

const trackRow = (t: TuiTrack): DetectedProvider => ({ id: t.id, label: t.name, hasWindow: t.hasWindow, found: true, confirmed: true });

export function providerHasWindow(usage: UsageSnapshot | null, id: string): boolean {
  const entry = usage?.providers[id];
  if (!entry) return WINDOW_IDS.has(id);
  return (entry.meters ?? []).some((m) => typeof m.usedPct === 'number' && (m.windowKind === 'session' || m.windowKind === 'weekly') && !/scoped/.test(m.id ?? ''));
}

export function modelsOf(current: SetupCurrent): Array<{ label: string; provider: string }> {
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const out: Array<{ label: string; provider: string }> = [];
  for (const [provider, raw] of Object.entries(rec(rec(current.policy).providers))) {
    for (const [label, mraw] of Object.entries(rec(rec(raw).models))) {
      if (rec(mraw).status === 'hidden') continue;
      out.push({ label, provider });
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label) || a.provider.localeCompare(b.provider));
  return out;
}

function startingStack(detected: readonly DetectedProvider[]): Exclude<StackId, 'profile'> {
  const paced = detected.filter((d) => d.found && d.confirmed && d.hasWindow);
  if (paced.length > 1) return 'several';
  if (paced.length === 1 && paced[0]!.id === 'claude') return 'claude-only';
  if (paced.length === 1) return 'several';
  return 'api-only';
}

function refresh(model: TuiModel): TuiModel {
  return { ...model, plan: planSetup(model.answers, model.current) };
}

export function openSetup(input: TuiOpen): TuiModel {
  const signedIn = input.tracks.filter((t) => t.signedIn).map(trackRow);
  const answers = input.firstRun ? emptyAnswers(startingStack(signedIn), signedIn) : answersFromCurrent(input.current);
  return refresh({
    step: 'stack', cursor: 0, answers, current: input.current, plan: planSetup(answers, input.current), tracks: input.tracks,
    seen: [], firstRun: input.firstRun, profilePath: '', profileProblems: [], apply: null, add: null, addError: '', adding: false,
    routeNotes: {}, testing: null, busy: false, typing: null,
  });
}

export function goStep(model: TuiModel, step: StepId): TuiModel {
  if (!ORDER.includes(step) || model.step === step) return model;
  const seen = model.seen.includes(model.step) ? model.seen : [...model.seen, model.step];
  return clamp({ ...model, step, seen, cursor: 0, typing: null });
}

export function selectStack(model: TuiModel, stack: StackId): TuiModel {
  if (stack === 'profile') {
    if (model.answers.stack === 'profile') return model;
    return refresh({ ...model, answers: { ...model.answers, stack: 'profile' } });
  }
  const detected = model.tracks.filter((t) => t.signedIn).map(trackRow);
  return refresh({ ...model, answers: emptyAnswers(stack, detected), profilePath: '', profileProblems: [] });
}

/** A bad file or a missing read sets the problems and leaves the answers and the plan as they were. */
export function loadProfileText(model: TuiModel, text: string | null): TuiModel {
  if (text === null) return { ...model, profileProblems: ['Could not read that file. Check the path and try again.'] };
  const got = answersFromProfile(text, model.current);
  if ('problems' in got) return { ...model, profileProblems: [...got.problems] };
  return refresh({ ...model, answers: got.answers, profileProblems: [], profilePath: model.profilePath });
}

export function setConfirmed(model: TuiModel, id: string, confirmed: boolean): TuiModel {
  const detected = model.answers.detected.map((d) => d.id === id ? { ...d, confirmed } : d);
  const row = detected.find((d) => d.id === id);
  let rank = confirmed ? [...model.answers.rank] : model.answers.rank.filter((x) => x !== id);
  const holdBack = { ...model.answers.holdBack };
  if (!confirmed) delete holdBack[id];
  else if (row?.found && row.hasWindow) {
    if (!rank.includes(id)) rank = [...rank, id];
    if (!holdBack[id]) holdBack[id] = 'some';
  }
  return refresh({ ...model, answers: { ...model.answers, detected, rank, holdBack } });
}

export function addUnfound(model: TuiModel, id: string): TuiModel {
  const track = model.tracks.find((t) => t.id === id);
  if (!track) return model;
  if (model.answers.detected.some((d) => d.id === id)) {
    const detected = model.answers.detected.map((d) => d.id === id ? { ...d, found: true, hasWindow: track.hasWindow, label: track.name } : d);
    return setConfirmed({ ...model, answers: { ...model.answers, detected } }, id, true);
  }
  const detected = [...model.answers.detected, { id, label: track.name, hasWindow: track.hasWindow, found: true, confirmed: true }];
  const rank = track.hasWindow ? [...model.answers.rank, id] : model.answers.rank;
  const holdBack = track.hasWindow ? { ...model.answers.holdBack, [id]: model.answers.holdBack[id] ?? 'some' as const } : model.answers.holdBack;
  return refresh({ ...model, answers: { ...model.answers, detected, rank, holdBack } });
}

export function setHold(model: TuiModel, id: string, choice: Exclude<HoldChoice, 'custom'>): TuiModel {
  return refresh({ ...model, answers: { ...model.answers, holdBack: { ...model.answers.holdBack, [id]: choice } } });
}

export function moveRank(model: TuiModel, id: string, dir: -1 | 1): TuiModel {
  const rank = [...model.answers.rank];
  const at = rank.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= rank.length) return model;
  const swap = rank[to]!;
  rank[to] = rank[at]!;
  rank[at] = swap;
  return refresh({ ...model, answers: { ...model.answers, rank } });
}

export function setPayNone(model: TuiModel): TuiModel {
  return refresh({ ...model, answers: { ...model.answers, payPerUse: { providers: [], amount: null } } });
}

export function togglePayProvider(model: TuiModel, id: string, on: boolean): TuiModel {
  const pay = model.answers.payPerUse ?? { providers: [] as string[], amount: null };
  const providers = on ? [...new Set([...pay.providers, id])] : pay.providers.filter((x) => x !== id);
  return refresh({ ...model, answers: { ...model.answers, payPerUse: { providers, amount: pay.amount } } });
}

export function setPayAmount(model: TuiModel, amount: number | null): TuiModel {
  const pay = model.answers.payPerUse ?? { providers: [] as string[], amount: null };
  return refresh({ ...model, answers: { ...model.answers, payPerUse: { providers: [...pay.providers], amount } } });
}

export function setStrength(model: TuiModel, label: string, value: Strength): TuiModel {
  return refresh({ ...model, answers: { ...model.answers, strengths: { ...model.answers.strengths, [label]: value } } });
}

export function setListAnswer(model: TuiModel, which: 'prose' | 'seatsSecond', value: string[] | 'skipped'): TuiModel {
  return refresh({ ...model, answers: { ...model.answers, [which]: value } });
}

function useStrong(model: TuiModel, which: 'prose' | 'seatsSecond'): TuiModel {
  const labels = Object.entries(model.answers.strengths).filter(([, v]) => v === 'strong').map(([k]) => k).sort();
  return setListAnswer(model, which, labels);
}

function toggleList(model: TuiModel, which: 'prose' | 'seatsSecond', label: string, on: boolean): TuiModel {
  const cur = model.answers[which];
  const list = Array.isArray(cur) ? [...cur] : [];
  const next = on ? [...new Set([...list, label])] : list.filter((x) => x !== label);
  return setListAnswer(model, which, next);
}

export function noteAdded(model: TuiModel, providerId: string): TuiModel {
  if (!providerId || model.answers.added.includes(providerId)) return model;
  return refresh({ ...model, answers: { ...model.answers, added: [...model.answers.added, providerId] } });
}

/**
 * Runs the plan's operations in order. A failed send stops the run. Operations that already finished stay in `ran`.
 */
export async function runApply(model: TuiModel, send: (op: SetupOp) => Promise<void>): Promise<TuiModel> {
  const plan = model.plan;
  if (!isValid(plan)) return { ...model, apply: { ran: [], failed: { id: '', error: problems(plan).join(' ') }, complete: false } };
  const ran: string[] = [];
  for (const op of applySteps(plan)) {
    try { await send(op); }
    catch (e) {
      const failed = { id: op.payload.id, error: e instanceof Error ? e.message : String(e) };
      return { ...model, apply: { ran: [...ran], failed, complete: false }, busy: false };
    }
    ran.push(op.payload.id);
  }
  return { ...model, apply: { ran, failed: null, complete: true }, step: 'done', cursor: 0, busy: false, typing: null };
}

const pacedOf = (answers: SetupAnswers): DetectedProvider[] => answers.detected.filter((d) => d.confirmed && d.found && d.hasWindow);

function stepNote(model: TuiModel, id: StepId): string {
  const names: Record<StackId, string> = { 'claude-only': 'Claude only', several: 'Several subscriptions', 'api-only': 'API keys only', profile: 'Profile file' };
  if (id === 'stack') return names[model.answers.stack];
  const status = stepStatus(model.answers, id);
  if (status === 'todo') return 'Not started';
  if (id === 'providers') return `${model.answers.detected.filter((d) => d.confirmed).length} confirmed`;
  if (id === 'pace') return status === 'partial' ? 'In progress' : model.plan.rankWords;
  if (id === 'review') return changeCount(applySteps(model.plan).length);
  return model.apply?.complete ? 'Applied' : status === 'partial' ? 'In progress' : 'Not started';
}

function stepTicked(model: TuiModel, id: StepId): boolean {
  if (model.step === id || !model.seen.includes(id)) return false;
  const note = stepNote(model, id);
  if (note === 'Not started' || note === '0 confirmed') return false;
  return stepStatus(model.answers, id) === 'ready';
}

function bracket(label: string, on: boolean): string { return on ? `[${label}]` : label; }

function holdLine(model: TuiModel, d: DetectedProvider): string {
  const choice = model.answers.holdBack[d.id];
  const choices = HOLD_CHOICES.map((v) => bracket(HOLD_LABEL[v], choice === v)).join('  ');
  const custom = choice === 'custom' ? 'custom  ' : '';
  return `${d.label}  ${custom}${choices}`;
}

function strengthLine(model: TuiModel, label: string): string {
  const value = model.answers.strengths[label];
  const choices = STRENGTHS.map((v) => bracket(STRENGTH_LABEL[v], value === v)).join('  ');
  return `${label}  ${choices}`;
}

function listBits(model: TuiModel, which: 'prose' | 'seatsSecond', title: string, prefix: string): Block[] {
  const cur = model.answers[which];
  const labels = new Set(modelsOf(model.current).map((m) => m.label));
  if (Array.isArray(cur)) for (const x of cur) labels.add(x);
  const out: Block[] = [{ kind: 'note', text: title }];
  if (cur === 'skipped') {
    out.push({ kind: 'note', text: 'Skipped, so nothing changes.' });
    out.push({ kind: 'item', item: { id: `${prefix}-clear`, text: 'Choose models' } });
    return out;
  }
  if (cur === null) out.push({ kind: 'note', text: 'Not chosen yet. Nothing changes until you pick models or choose Skip.' });
  for (const label of [...labels].sort()) {
    const on = Array.isArray(cur) && cur.includes(label);
    out.push({ kind: 'item', item: { id: `${prefix}:${label}`, text: `${on ? '[x]' : '[ ]'} ${label}` } });
  }
  out.push({ kind: 'item', item: { id: `${prefix}-strong`, text: 'Use the strong models' } });
  out.push({ kind: 'item', item: { id: `${prefix}-skip`, text: 'Skip' } });
  return out;
}

function payOptions(model: TuiModel): Array<[string, string]> {
  const pay = model.answers.payPerUse;
  const options = new Map<string, string>();
  for (const t of model.tracks) if (!t.hasWindow) options.set(t.id, t.name);
  for (const id of model.answers.added) if (!options.has(id)) options.set(id, id);
  for (const id of pay?.providers ?? []) if (!options.has(id)) options.set(id, id);
  return [...options.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

function addBlocks(model: TuiModel): Block[] {
  const f = model.add;
  if (!f) return [{ kind: 'item', item: { id: 'add-open', text: 'Add an API service' } }];
  const fields = providerFields(f.kind);
  const out: Block[] = [{ kind: 'note', text: 'Add provider' }];
  const kind = f.kind;
  out.push({ kind: 'item', item: { id: 'ap-kind', text: `Service  ${kind}` } });
  const text = (id: string, label: string, value: string): Block => ({ kind: 'item', item: { id, text: `${label}  ${value || '(empty)'}` } });
  if (fields.provider) out.push(text('ap:provider', 'Provider id', f.provider));
  if (fields.baseUrl) out.push(text('ap:baseUrl', 'Base URL', f.baseUrl));
  if (fields.route) out.push(text('ap:route', 'Route name', f.route));
  if (fields.model) out.push(text('ap:model', 'Model id', f.model));
  out.push({ kind: 'item', item: { id: 'ap:key', text: f.key ? 'API key  entered' : 'API key  (empty)' } });
  const existing = new Set(model.current.routes.map((r) => r.name));
  const got = planOfForm(f, existing);
  if ('problems' in got) {
    if (!got.fresh) for (const p of got.problems) out.push({ kind: 'note', text: p });
  } else {
    for (const row of planRows(got.plan)) out.push({ kind: 'note', text: `${row.label}: ${row.text}` });
  }
  if (model.addError) out.push({ kind: 'note', text: model.addError });
  const canAdd = !('problems' in got) && !model.adding;
  out.push({ kind: 'item', item: { id: 'ap-add', text: model.adding ? 'Adding' : 'Add provider', disabled: !canAdd } });
  out.push({ kind: 'item', item: { id: 'ap-cancel', text: 'Cancel' } });
  return out;
}

function skipItem(model: TuiModel): Block[] {
  return model.firstRun && model.step !== 'done' ? [{ kind: 'item', item: { id: 'skip', text: 'Skip setup' } }] : [];
}

function blocks(model: TuiModel): Block[] {
  const out: Block[] = [];
  const step = SETUP_STEPS.find((s) => s.id === model.step)!;
  out.push({ kind: 'note', text: step.title });
  out.push({ kind: 'note', text: step.sub });
  if (model.step === 'stack') {
    for (const s of STACKS) {
      const on = model.answers.stack === s.id;
      out.push({ kind: 'item', item: { id: `stack:${s.id}`, text: `${s.title}${on ? '  picked' : ''}` } });
      out.push({ kind: 'note', text: s.help });
    }
    if (model.answers.stack === 'profile') {
      const shown = model.typing?.id === 'profile' ? model.typing.value : model.profilePath;
      out.push({ kind: 'item', item: { id: 'profile-path', text: `Profile path  ${shown || '(type a path)'}` } });
      for (const p of model.profileProblems) out.push({ kind: 'note', text: p });
    }
    const found = model.tracks.filter((t) => t.signedIn).map((t) => t.name);
    out.push({ kind: 'note', text: found.length ? `Augur found these signed in on this computer: ${found.join(', ')}.` : 'Augur found no subscription signed in on this computer.' });
    out.push({ kind: 'item', item: { id: 'detect', text: 'Check again' } });
  } else if (model.step === 'providers') {
    if (!model.answers.detected.length) out.push({ kind: 'note', text: 'No subscription was found. Add an API service below, or go back to the first step and choose Check again.' });
    for (const d of model.answers.detected) {
      out.push({ kind: 'item', item: { id: `confirm:${d.id}`, text: `${d.confirmed ? '[x]' : '[ ]'} ${d.label}  ${d.hasWindow ? 'Has a usage window' : 'No usage window'}` } });
    }
    const have = new Set(model.answers.detected.filter((d) => d.found).map((d) => d.id));
    const missing = model.tracks.filter((t) => SUBSCRIPTIONS.has(t.id) && !t.signedIn && !have.has(t.id));
    if (missing.length) out.push({ kind: 'note', text: 'Not found on this computer' });
    for (const t of missing) out.push({ kind: 'item', item: { id: `missing:${t.id}`, text: `I have ${t.name}` } });
    out.push({ kind: 'note', text: 'Tracking' });
    for (const t of model.tracks) out.push({ kind: 'item', item: { id: `track:${t.id}`, text: `${t.enabled ? '[x]' : '[ ]'} ${t.name}${t.locked ? '  Desktop only' : ''}`, disabled: t.locked } });
    if (model.answers.added.length) out.push({ kind: 'note', text: `Added: ${model.answers.added.join(', ')}` });
    out.push(...addBlocks(model));
  } else if (model.step === 'pace') {
    const paced = pacedOf(model.answers);
    out.push({ kind: 'note', text: 'How much to hold back' });
    if (!paced.length) out.push({ kind: 'note', text: 'No subscription with a usage window is confirmed, so nothing is paced.' });
    for (const d of paced) {
      out.push({ kind: 'item', item: { id: `hold:${d.id}`, text: holdLine(model, d) } });
      const choice = model.answers.holdBack[d.id];
      const text = choice && choice !== 'custom' ? HOLD_BACK[choice].text : choice === 'custom' ? CUSTOM_HOLD : '';
      if (text) out.push({ kind: 'note', text });
    }
    out.push({ kind: 'note', text: 'Order of use' });
    const labelOf = new Map(model.answers.detected.map((d) => [d.id, d.label]));
    if (!model.answers.rank.length) {
      out.push({ kind: 'note', text: model.plan.rankWords });
      if (paced.length >= 2) out.push({ kind: 'item', item: { id: 'rank-fill', text: 'Rank the subscriptions' } });
    }
    model.answers.rank.forEach((id, i) => {
      out.push({ kind: 'item', item: { id: `rank:${id}`, text: `Rank ${i + 1}  ${labelOf.get(id) ?? id}` } });
    });
    out.push({ kind: 'note', text: 'Pay per use' });
    const pay = model.answers.payPerUse;
    const none = !!pay && pay.providers.length === 0;
    out.push({ kind: 'item', item: { id: 'pay-none', text: `${none ? '[x]' : '[ ]'} No backup spending` } });
    for (const [id, name] of payOptions(model)) {
      const on = !!pay?.providers.includes(id);
      out.push({ kind: 'item', item: { id: `pay:${id}`, text: `${on ? '[x]' : '[ ]'} ${name}` } });
    }
    const amount = model.typing?.id === 'amount' ? model.typing.value : pay?.amount == null ? '' : String(pay.amount);
    out.push({ kind: 'item', item: { id: 'amount', text: `Monthly amount  ${amount || '(none)'}` } });
    out.push({ kind: 'note', text: 'Dollars per month. Choose No backup spending, or select the providers to use and enter an amount.' });
  } else if (model.step === 'review') {
    out.push({ kind: 'note', text: 'What each model is good at' });
    const models = modelsOf(model.current);
    if (!models.length) out.push({ kind: 'note', text: 'No models are in the rules yet. Add an API service on the Providers and keys step, or apply without any.' });
    for (const m of models) out.push({ kind: 'item', item: { id: `strength:${m.label}`, text: strengthLine(model, m.label) } });
    out.push({ kind: 'note', text: 'Not sure leaves a model as it is.' });
    out.push(...listBits(model, 'prose', 'Writes the best prose', 'prose'));
    out.push(...listBits(model, 'seatsSecond', 'Gives a second opinion', 'second'));
    for (const p of problems(model.plan)) out.push({ kind: 'note', text: p });
    if (model.apply?.ran.length || model.apply?.failed) {
      for (const id of model.apply?.ran ?? []) out.push({ kind: 'note', text: `${changeLabel(model.plan, id)} saved.` });
      if (model.apply?.failed) out.push({ kind: 'note', text: model.apply.failed.id ? `Could not save ${changeLabel(model.plan, model.apply.failed.id)}: ${model.apply.failed.error}` : model.apply.failed.error });
    }
    out.push(...summaryBlocks(model));
    const n = applySteps(model.plan).length;
    const disabled = !isValid(model.plan) || model.busy;
    out.push({ kind: 'item', item: { id: 'apply', text: disabled ? `Apply ${changeCount(n)}  disabled` : `Apply ${changeCount(n)}`, disabled } });
  } else {
    const done = afterApply(model.plan);
    out.push({ kind: 'note', text: 'Test your routes' });
    if (!done.routesToTest.length) out.push({ kind: 'note', text: 'No route has a key yet.' });
    for (const name of done.routesToTest) {
      const note = model.routeNotes[name] ?? '';
      out.push({ kind: 'item', item: { id: `test:${name}`, text: model.testing === name ? `Testing ${name}` : `Test ${name}`, disabled: !!model.testing } });
      if (note) out.push({ kind: 'note', text: note });
    }
    out.push({ kind: 'note', text: 'Still to confirm' });
    const providerOf = new Map(modelsOf(model.current).map((m) => [m.label, m.provider]));
    if (!done.unreviewed.length) out.push({ kind: 'note', text: 'Every model is confirmed.' });
    for (const label of done.unreviewed) out.push({ kind: 'item', item: { id: `rules:${providerOf.get(label) ?? ''}:${label}`, text: `Open rules  ${label}` } });
    out.push({ kind: 'note', text: 'What happens next' });
    for (const line of done.next) out.push({ kind: 'note', text: line });
    out.push({ kind: 'item', item: { id: 'close', text: 'Finish setup' } });
  }
  out.push(...skipItem(model));
  return out;
}

function changeLabel(plan: SetupPlan, id: string): string {
  return plan.changes.find((c) => c.id === id)?.label ?? id;
}

function summaryBlocks(model: TuiModel): Block[] {
  const lines = summaryLines(model.plan).flatMap((g) => g.lines);
  return lines.map((text) => ({ kind: 'note', text }));
}

function itemList(model: TuiModel): Item[] {
  return blocks(model).flatMap((b) => b.kind === 'item' ? [b.item] : []);
}

function clamp(model: TuiModel): TuiModel {
  const n = itemList(model).length;
  const cursor = n === 0 ? 0 : Math.max(0, Math.min(model.cursor, n - 1));
  return cursor === model.cursor ? model : { ...model, cursor };
}

function fit(text: string, width: number): string {
  if (text.length > width) return text.slice(0, Math.max(0, width));
  return text + ' '.repeat(width - text.length);
}

function beside(cols: string[][], widths: number[]): string[] {
  const n = Math.max(1, ...cols.map((c) => c.length));
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(cols.map((c, k) => fit(c[i] ?? '', widths[k]!)).join('  ').trimEnd());
  return out;
}

function stepColumn(model: TuiModel, width: number): string[] {
  const lines = ['Steps'];
  SETUP_STEPS.forEach((s, i) => {
    const mark = stepTicked(model, s.id) ? 'ok' : String(i + 1);
    const prefix = model.step === s.id ? '*' : ' ';
    lines.push(...wrapLine(`${prefix} ${mark} ${s.title}`, width, '  '));
    lines.push(...wrapLine(`    ${stepNote(model, s.id)}`, width));
  });
  lines.push(...wrapLine('A step you leave alone changes nothing.', width));
  return lines;
}

function stepLine(model: TuiModel, width: number): string[] {
  const labels = SETUP_STEPS.map((s, i) => {
    const label = `${i + 1} ${SHORT[s.id]}`;
    return model.step === s.id ? `[${label}]` : label;
  });
  const rows: string[] = [];
  let row = '';
  for (const label of labels) {
    const next = row ? `${row}  ${label}` : label;
    if (next.length > width && row) {
      rows.push(row);
      row = label;
    } else row = next;
  }
  if (row) rows.push(...linesOf(row, width));
  return rows;
}

function formLines(model: TuiModel): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const b of blocks(model)) {
    if (b.kind === 'note') { lines.push(`  ${b.text}`); continue; }
    lines.push(`${n === model.cursor ? '>' : ' '} ${b.item.text}`);
    n += 1;
  }
  return lines;
}

/** Keeps a status tag on its own line when the row is wider than the terminal, so the word is still on screen. */
function linesOf(text: string, width: number): string[] {
  if (width < 8 || text.length <= width) return [text];
  const tag = text.match(/ \((unchanged|will change|new)\)$/);
  if (tag && tag.index !== undefined && tag.index > 0) {
    const body = text.slice(0, tag.index);
    const mark = text.slice(tag.index + 1);
    return [...linesOf(body, width), mark.length <= width ? mark : mark.slice(0, width)];
  }
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let at = rest.lastIndexOf(' ', width);
    if (at < 8) at = width;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^ /, '');
  }
  if (rest) out.push(rest);
  return out;
}

function wrapLine(text: string, width: number, continuation = ''): string[] {
  if (text.length <= width) return [text];
  const indent = text.match(/^\s*/)?.[0] ?? '';
  const hanging = continuation || indent;
  const available = Math.max(1, width - Math.max(indent.length, hanging.length));
  return linesOf(text.slice(indent.length), available).map((line, i) => `${i === 0 ? indent : hanging}${line}`);
}

/** Lines for one frame. Wide terminals put the steps on the left. Narrow ones keep the summary above Apply. */
export function renderSetup(model: TuiModel, width: number): string[] {
  const safe = clamp(model);
  const form = formLines(safe);
  if (width >= WIDE) {
    const steps = stepColumn(safe, 26);
    const summary = width >= SUMMARY_COL ? ['What Augur will set', ...summaryLines(safe.plan).flatMap((g) => g.lines)] : [];
    const formW = Math.max(20, width - 28 - (summary.length ? 36 : 0) - (summary.length ? 4 : 2));
    const cols = [steps, form.flatMap((l) => wrapLine(l, formW, '  '))];
    const widths = [26, formW];
    if (summary.length) { cols.push(summary.flatMap((l) => wrapLine(l, 34, '  '))); widths.push(34); }
    return beside(cols, widths);
  }
  const extra = model.step === 'review' ? [] : summaryLines(safe.plan).flatMap((g) => g.lines).map((l) => `  ${l}`);
  return [...stepLine(safe, width), ...[...form, ...extra].flatMap((l) => wrapLine(l, width, '  '))];
}

function cycle<T>(list: readonly T[], cur: T | undefined, dir: -1 | 1): T {
  const at = cur === undefined ? -1 : list.indexOf(cur);
  return list[(at + dir + list.length) % list.length]!;
}

function same(model: TuiModel): ReduceResult { return { model, effect: null, handled: true }; }
function idle(model: TuiModel): ReduceResult { return { model, effect: null, handled: false }; }

function commitTyping(model: TuiModel): ReduceResult {
  const typing = model.typing;
  if (!typing) return same(model);
  const value = typing.value.trim();
  const cleared = { ...model, typing: null };
  if (typing.id === 'profile') {
    return { model: { ...cleared, profilePath: value }, effect: { kind: 'profile', path: value }, handled: true };
  }
  if (typing.id === 'amount') {
    const amount = value === '' ? null : Number(value);
    return same(setPayAmount(cleared, amount !== null && Number.isFinite(amount) ? amount : null));
  }
  if (typing.id.startsWith('ap:') && model.add) {
    const field = typing.id.slice(3) as 'route' | 'model' | 'provider' | 'baseUrl' | 'key';
    const add = { ...model.add, [field]: field === 'key' ? value : value };
    return same({ ...cleared, add, addError: '' });
  }
  return same(cleared);
}

function typeKey(model: TuiModel, key: Key): ReduceResult {
  const typing = model.typing!;
  if (key.label === 'escape') return same({ ...model, typing: null });
  if (key.label === 'enter') return commitTyping(model);
  if (key.label === 'backspace') return same({ ...model, typing: { ...typing, value: typing.value.slice(0, -1) } });
  if (key.name === 'char' && key.text && !key.ctrl && !key.alt) return same({ ...model, typing: { ...typing, value: typing.value + key.text } });
  return same(model);
}

function activate(model: TuiModel, item: Item, key: Key): ReduceResult {
  if (item.disabled) return same(model);
  const side = key.label === 'left' || key.label === 'h' ? -1 : key.label === 'right' || key.label === 'l' ? 1 : 0;
  const id = item.id;
  if (id.startsWith('stack:')) return same(selectStack(model, id.slice(6) as StackId));
  if (id === 'profile-path') return same({ ...model, typing: { id: 'profile', value: model.profilePath } });
  if (id === 'detect') return { model, effect: { kind: 'detect' }, handled: true };
  if (id.startsWith('confirm:')) {
    const pid = id.slice(8);
    const row = model.answers.detected.find((d) => d.id === pid);
    return same(setConfirmed(model, pid, !row?.confirmed));
  }
  if (id.startsWith('missing:')) return same(addUnfound(model, id.slice(8)));
  if (id.startsWith('track:')) {
    const pid = id.slice(6);
    const row = model.tracks.find((t) => t.id === pid);
    if (!row || row.locked) return same(model);
    const on = !row.enabled;
    const tracks = model.tracks.map((t) => t.id === pid ? { ...t, enabled: on } : t);
    return { model: { ...model, tracks }, effect: { kind: 'track', id: pid, on }, handled: true };
  }
  if (id === 'add-open') return same({ ...model, add: emptyProviderForm(), addError: '' });
  if (id === 'ap-cancel') return same({ ...model, add: null, addError: '' });
  if (id === 'ap-kind' && model.add) {
    const ids = ['openai', 'openrouter', 'groq', 'together', 'fireworks', 'deepseek', 'mistral', 'gemini', 'anthropic', 'openai-compatible', 'anthropic-compatible'];
    const known = ids.includes(model.add.kind) ? ids : [model.add.kind, ...ids];
    const next = cycle(known, model.add.kind, side || 1);
    return same({ ...model, add: emptyProviderForm(next), addError: '' });
  }
  if (id.startsWith('ap:') && model.add) {
    const field = id.slice(3) as 'route' | 'model' | 'provider' | 'baseUrl' | 'key';
    return same({ ...model, typing: { id, value: field === 'key' ? '' : model.add[field] } });
  }
  if (id === 'ap-add') return { model, effect: { kind: 'add' }, handled: true };
  if (id.startsWith('hold:')) {
    const pid = id.slice(5);
    const cur = model.answers.holdBack[pid];
    const next = cycle(HOLD_CHOICES, cur === 'custom' ? undefined : cur, side || 1);
    return same(setHold(model, pid, next));
  }
  if (id === 'rank-fill') {
    const rank = pacedOf(model.answers).map((d) => d.id);
    if (!rank.length) return same(model);
    return same(refresh({ ...model, answers: { ...model.answers, rank } }));
  }
  if (id === 'pay-none') return same(setPayNone(model));
  if (id.startsWith('pay:')) {
    const pid = id.slice(4);
    const on = !(model.answers.payPerUse?.providers.includes(pid));
    return same(togglePayProvider(model, pid, on));
  }
  if (id === 'amount') {
    const cur = model.answers.payPerUse?.amount;
    return same({ ...model, typing: { id: 'amount', value: cur == null ? '' : String(cur) } });
  }
  if (id.startsWith('strength:')) {
    const label = id.slice(9);
    const cur = model.answers.strengths[label];
    const next = cycle(STRENGTHS, cur, side || 1);
    return same(setStrength(model, label, next));
  }
  if (id.startsWith('prose:') || id.startsWith('second:')) {
    const which = id.startsWith('prose:') ? 'prose' : 'seatsSecond';
    const label = id.slice(id.indexOf(':') + 1);
    const cur = model.answers[which];
    const on = !(Array.isArray(cur) && cur.includes(label));
    return same(toggleList(model, which, label, on));
  }
  if (id === 'prose-strong') return same(useStrong(model, 'prose'));
  if (id === 'second-strong') return same(useStrong(model, 'seatsSecond'));
  if (id === 'prose-skip') return same(setListAnswer(model, 'prose', 'skipped'));
  if (id === 'second-skip') return same(setListAnswer(model, 'seatsSecond', 'skipped'));
  if (id === 'prose-clear') return same(setListAnswer(model, 'prose', []));
  if (id === 'second-clear') return same(setListAnswer(model, 'seatsSecond', []));
  if (id === 'apply') return { model, effect: { kind: 'apply' }, handled: true };
  if (id === 'skip') return { model, effect: { kind: 'skip' }, handled: true };
  if (id.startsWith('test:')) return { model, effect: { kind: 'test', name: id.slice(5) }, handled: true };
  if (id.startsWith('rules:')) {
    const rest = id.slice(6);
    const cut = rest.indexOf(':');
    return { model, effect: { kind: 'rules', provider: rest.slice(0, cut), model: rest.slice(cut + 1) }, handled: true };
  }
  if (id === 'close') return { model, effect: { kind: 'leave' }, handled: true };
  return same(model);
}

export function reduce(model: TuiModel, key: Key): ReduceResult {
  if (model.typing) return typeKey(model, key);
  if (key.label === 'tab') return same(goStep(model, ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(model.step) + 1)] ?? model.step));
  if (key.label === 'shift+tab') return same(goStep(model, ORDER[Math.max(0, ORDER.indexOf(model.step) - 1)] ?? model.step));
  if (/^[1-5]$/.test(key.label)) return same(goStep(model, ORDER[Number(key.label) - 1]!));
  if (key.label === 'escape') {
    if (model.add) return same({ ...model, add: null, addError: '' });
    if (model.step === 'stack') return { model, effect: { kind: 'leave' }, handled: true };
    return same(goStep(model, ORDER[ORDER.indexOf(model.step) - 1]!));
  }
  const list = itemList(model);
  const item = list[model.cursor];
  if (model.step === 'pace' && item?.id.startsWith('rank:') && (key.label === 'u' || key.label === 'd' || key.label === 'shift+up' || key.label === 'shift+down')) {
    const dir = key.label === 'u' || key.label === 'shift+up' ? -1 : 1;
    const next = moveRank(model, item.id.slice(5), dir);
    const at = itemList(next).findIndex((i) => i.id === item.id);
    return same(at < 0 ? next : { ...next, cursor: at });
  }
  const move = key.label === 'up' || key.label === 'k' ? -1 : key.label === 'down' || key.label === 'j' ? 1 : 0;
  if (move) {
    if (!list.length) return same(model);
    const cursor = Math.max(0, Math.min(list.length - 1, model.cursor + move));
    return same({ ...model, cursor });
  }
  if (!item) return idle(model);
  if (key.label === 'enter' || key.label === ' ' || key.label === 'left' || key.label === 'right' || key.label === 'h' || key.label === 'l') return activate(model, item, key);
  return idle(model);
}

export interface SetupDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string | null;
  rules?: { openDetail(provider: string, model: string | null): void };
  wait?: (ms: number) => Promise<void>;
}

function usageOf(state: EngineState): UsageSnapshot | null {
  const snap = state.snapshot;
  if (!snap) return null;
  const providers: UsageSnapshot['providers'] = {};
  for (const [id, p] of Object.entries(snap.providers)) {
    providers[id] = {
      meters: p.meters.map((m) => ({ id: m.id, label: m.label, usedPct: m.usedPct, resetsAt: m.resetsAt ?? null, windowSeconds: m.windowSeconds ?? null, ...(m.windowKind ? { windowKind: m.windowKind } : {}) })),
      money: p.money.filter((x) => x.amount != null).map((x) => ({ id: x.id, amount: x.amount as number, ...(x.currency ? { currency: x.currency } : {}) })),
      stale: p.stale,
      fetchedAt: p.fetchedAt,
    };
  }
  return { providers };
}

function tracksFrom(state: EngineState): TuiTrack[] {
  const usage = usageOf(state);
  const plugins = new Map(allPlugins(state.config).map((p) => [p.id, p]));
  const out: TuiTrack[] = [];
  for (const pc of state.config.providers) {
    const plugin = plugins.get(pc.id);
    if (!plugin) continue;
    const entry = state.snapshot?.providers[pc.id];
    const signedIn = plugin.needsLocalLogin ? entry?.ok === true : pc.enabled;
    out.push({ id: pc.id, name: plugin.name, enabled: pc.enabled, signedIn, hasWindow: providerHasWindow(usage, pc.id), locked: false });
  }
  return out;
}

function currentFrom(state: EngineState, routes: SetupCurrent['routes']): SetupCurrent {
  return { policy: state.config.policy ?? emptyPolicy(), routes, usage: usageOf(state) };
}

export class SetupPage implements Page {
  name = 'Setup';
  model: TuiModel | null = null;
  private top = 0;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readFile: (path: string) => string | null;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: SetupDeps = {}) {
    this.env = deps.env ?? process.env;
    this.readFile = deps.readFile ?? ((path) => {
      try { return existsSync(path) ? readFileSync(path, 'utf8') : null; } catch { return null; }
    });
    this.wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get routesPath(): string { return this.env.AUGURD_ROUTES ?? join(augurHome(this.env), 'dispatch', 'routes.json'); }

  typing(): boolean { return this.model?.typing !== null; }

  reopen(ctx: Ctx): void {
    const routes = this.model?.current.routes ?? [];
    this.model = openSetup({ firstRun: false, current: currentFrom(ctx.state, routes), tracks: tracksFrom(ctx.state) });
    this.top = 0;
    void this.loadRoutes(ctx);
  }

  private ensure(ctx: Ctx): void {
    if (this.model) return;
    this.model = openSetup({ firstRun: ctx.state.firstRun, current: currentFrom(ctx.state, []), tracks: tracksFrom(ctx.state) });
    void this.loadRoutes(ctx);
  }

  private async loadRoutes(ctx: Ctx): Promise<void> {
    const model = this.model;
    if (!model) return;
    let text: string | null = null;
    try { text = existsSync(this.routesPath) ? readFileSync(this.routesPath, 'utf8') : null; } catch { return; }
    const parsed = parseRoutesText(text);
    if (!parsed.ok || !this.model) return;
    const routes: Array<SetupCurrent['routes'][number]> = [];
    for (const r of parsed.file.routes) {
      const hasKey = await ctx.link.run<boolean>('hasSecret', routeSecretName(r.name)).then((v) => v === true).catch(() => false);
      routes.push({ name: r.name, model: r.model, hasKey });
    }
    if (!this.model) return;
    this.model = refresh({ ...this.model, current: { ...this.model.current, routes } });
    ctx.redraw();
  }

  draw(screen: Screen, r: Rect, ctx: Ctx): void {
    this.ensure(ctx);
    if (!this.model) return;
    const lines = renderSetup(this.model, r.w);
    const cursorLine = lines.findIndex((l) => l.includes('> '));
    if (cursorLine >= 0) {
      if (cursorLine < this.top) this.top = cursorLine;
      if (cursorLine >= this.top + r.h) this.top = cursorLine - r.h + 1;
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, lines.length - r.h)));
    const box = inset(r, 0, 0);
    lines.slice(this.top, this.top + box.h).forEach((line, i) => screen.put(box.x, box.y + i, line.slice(0, box.w)));
  }

  async key(key: Key, ctx: Ctx): Promise<boolean> {
    this.ensure(ctx);
    if (!this.model) return false;
    const out = reduce(this.model, key);
    this.model = out.model;
    if (out.effect) await this.runEffect(ctx, out.effect);
    return out.handled;
  }

  hints(): Hint[] {
    return [['Up/Down', 'Move'], ['Enter', 'Choose'], ['Tab', 'Next step'], ['1-5', 'Step'], ['u/d', 'Reorder'], ['Esc', 'Back']];
  }

  private async runEffect(ctx: Ctx, effect: SetupEffect): Promise<void> {
    const model = this.model;
    if (!model) return;
    if (effect.kind === 'leave' || effect.kind === 'skip') { ctx.openPage('Usage'); return; }
    if (effect.kind === 'profile') {
      this.model = loadProfileText(model, this.readFile(effect.path));
      return;
    }
    if (effect.kind === 'detect') {
      this.model = { ...model, tracks: tracksFrom(ctx.state) };
      return;
    }
    if (effect.kind === 'track') {
      const c = structuredClone(ctx.state.config);
      const pc = c.providers.find((p) => p.id === effect.id);
      if (pc) pc.enabled = effect.on;
      ctx.state.config = c;
      if (!model.firstRun) await ctx.link.run('saveConfig', c);
      return;
    }
    if (effect.kind === 'apply') { await this.apply(ctx); return; }
    if (effect.kind === 'add') { await this.addProvider(ctx); return; }
    if (effect.kind === 'test') { await this.testRoute(ctx, effect.name); return; }
    if (effect.kind === 'rules') {
      this.deps.rules?.openDetail(effect.provider, effect.model);
      ctx.openPage('Rules');
    }
  }

  private async apply(ctx: Ctx): Promise<void> {
    const model = this.model;
    if (!model || model.busy) return;
    this.model = { ...model, busy: true };
    const next = await runApply(this.model, async (op) => {
      const c = structuredClone(ctx.state.config);
      c.policy ??= emptyPolicy();
      applyEdit(c.policy, op.payload, DEVICE);
      await ctx.link.run('saveConfig', c);
      ctx.state.config = c;
    });
    this.model = next;
    // Skip writes nothing. A finished first run clears that flag, so the next launch does not ask again.
    if (next.apply?.complete && ctx.state.firstRun) {
      try { await ctx.link.run('finishSetup', structuredClone(ctx.state.config)); }
      catch (e) { ctx.flash((e as Error).message || 'Could not finish setup, so it opens again at the next launch.', true); }
    }
    ctx.redraw();
  }

  private async addProvider(ctx: Ctx): Promise<void> {
    const model = this.model;
    const form = model?.add;
    if (!model || !form || model.adding) return;
    const got = planOfForm(form, new Set(model.current.routes.map((r) => r.name)));
    if ('problems' in got) { this.model = { ...model, addError: got.problems[0] ?? 'That provider is not ready to add. Fill in the fields it still needs.' }; return; }
    this.model = { ...model, adding: true, addError: '' };
    ctx.redraw();
    try {
      const plan = got.plan;
      await applyProvider(plan, form.key, {
        addProvider: (input) => ctx.link.run('addProvider', input),
        setSecret: async (name, value) => { await ctx.link.run('setSecret', name, value); },
        setProviderKey: async (provider, field, value) => { await ctx.link.run('setProviderKey', provider, field, value); },
        readRoutes: async () => (existsSync(this.routesPath) ? readFileSync(this.routesPath, 'utf8') : null),
        writeRoutes: async (text) => {
          mkdirSync(dirname(this.routesPath), { recursive: true });
          const tmp = `${this.routesPath}.${process.pid}.tmp`;
          writeFileSync(tmp, text);
          renameSync(tmp, this.routesPath);
        },
      });
      const added = noteAdded(this.model ?? model, plan.provider);
      const policy = ctx.state.config.policy ?? added.current.policy;
      const prev = new Set(modelsOf(added.current).map((m) => m.label));
      const current = { ...added.current, policy };
      const strengths = { ...added.answers.strengths };
      for (const m of modelsOf(current)) if (!prev.has(m.label) && strengths[m.label] === undefined) strengths[m.label] = 'unsure';
      this.model = refresh({ ...added, current, answers: { ...added.answers, strengths }, add: null, adding: false, addError: '' });
    } catch (e) {
      if (this.model) this.model = { ...this.model, adding: false, addError: (e as Error).message || 'Could not add that provider.' };
    }
    ctx.redraw();
  }

  private async testRoute(ctx: Ctx, name: string): Promise<void> {
    const model = this.model;
    if (!model || !name || model.testing) return;
    this.model = { ...model, testing: name, routeNotes: { ...model.routeNotes, [name]: '' } };
    ctx.redraw();
    const say = (text: string) => {
      if (!this.model) return;
      this.model = { ...this.model, testing: null, routeNotes: { ...this.model.routeNotes, [name]: text } };
      ctx.redraw();
    };
    try {
      const base = {
        route: name, dataTier: 'public' as const, tools: 'read' as const, output: 'text_only' as const, cwd: mkdtempSync(join(tmpdir(), 'augur-route-test-')), timeoutS: 120,
        prompt: { text: 'Reply with the single word ok and nothing else.' }, caller: { kind: 'cli' as const, label: 'route test' }, allow: ['unpicked' as const],
      };
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
}
