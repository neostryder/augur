// The setup interview. Every choice goes through the shared steps in view-model; this file only draws them and edits the answer object.
import type { UsageSnapshot } from '@augur/dispatch-protocol';
import { emptyProviderForm } from '@augur/view-model';
import {
  HOLD_BACK, SETUP_STEPS, afterApply, answersFromCurrent, answersFromProfile, applySteps, emptyAnswers, isValid, planSetup, problems, stepStatus, summaryLines,
} from '@augur/view-model';
import type { DetectedProvider, HoldChoice, SetupAnswers, SetupCurrent, SetupOp, SetupPlan, StackId, StepId, Strength } from '@augur/view-model';
import { esc } from '../util';
import { renderAddProvider, type AddProviderModel } from './add-provider';

/** A new install opens here. A later launch opens usage. */
export const initialView = (firstRun: boolean): 'setup' | 'dashboard' => firstRun ? 'setup' : 'dashboard';

/** Subscriptions the interview can ask about when detection did not see them. API services use the Add provider form. */
const SUBSCRIPTIONS = new Set(['claude', 'codex', 'grok', 'minimax', 'copilot']);
/** Subscriptions whose readers publish a session or weekly window, used only when no usage row has arrived yet. */
const WINDOW_IDS = new Set(['claude', 'codex', 'grok', 'minimax']);

const STACKS: Array<{ id: StackId; mark: string; title: string; help: string }> = [
  { id: 'claude-only', mark: 'C', title: 'Claude only', help: 'One Claude plan. Augur keeps it on pace and has nothing else to balance.' },
  { id: 'several', mark: 'S', title: 'Several subscriptions', help: 'Claude plus other plans such as Codex, Grok, or Copilot. You choose which ones to pace and the order Augur uses them in.' },
  { id: 'api-only', mark: 'K', title: 'API keys only', help: 'You pay per use, so nothing is paced. Name the providers and a monthly amount to stay under.' },
  { id: 'profile', mark: '+', title: 'Start from a profile file', help: 'Load a setup exported from another computer. The file holds no keys, and Augur checks all of it before anything changes.' },
];

const HOLD_CHOICES: Array<Exclude<HoldChoice, 'custom'>> = ['free', 'some', 'save'];
const HOLD_LABEL: Record<Exclude<HoldChoice, 'custom'>, string> = {
  free: 'Use it freely',
  some: 'Keep some back',
  save: 'Save it for the work only it does',
};

/** Shown for a subscription whose current reserve and band match none of the three choices. */
const CUSTOM_HOLD = 'This subscription has custom values from your current setup. They stay unless you pick one of the choices above.';

/** "1 change", "3 changes". */
const changeCount = (n: number): string => `${n} change${n === 1 ? '' : 's'}`;

const TICK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-5.5"/></svg>';

export interface SetupTrack {
  id: string;
  name: string;
  enabled: boolean;
  /** Signed in on this computer, from the first-run detection. */
  signedIn: boolean;
  hasWindow: boolean;
  /** A phone cannot turn on a provider that needs a sign-in on the computer. */
  locked: boolean;
}

export interface SetupApplyProgress {
  /** Operation ids that finished, in the order they ran. */
  ran: string[];
  /** The operation in flight, when one is. */
  pending: string | null;
  failed: { id: string; error: string } | null;
  complete: boolean;
}

export interface SetupModel {
  step: StepId;
  answers: SetupAnswers;
  current: SetupCurrent;
  plan: SetupPlan;
  tracks: SetupTrack[];
  apply: SetupApplyProgress | null;
  add: AddProviderModel | null;
  profileText: string;
  profileProblems: string[];
  /** Skip setup is offered only on a new install. */
  firstRun: boolean;
  /** Steps the person has left. A ready step stays a number until then. */
  seen: StepId[];
  routeNotes: Record<string, string>;
  testing: string | null;
  busy: boolean;
}

export interface SetupOpen {
  firstRun: boolean;
  current: SetupCurrent;
  tracks: SetupTrack[];
  routes: ReadonlySet<string>;
}

/** A session or weekly meter wins. With no usage row yet, the four subscriptions that publish one count. */
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

const trackRow = (t: SetupTrack): DetectedProvider => ({ id: t.id, label: t.name, hasWindow: t.hasWindow, found: true, confirmed: true });

function startingStack(detected: readonly DetectedProvider[]): Exclude<StackId, 'profile'> {
  const paced = detected.filter((d) => d.found && d.confirmed && d.hasWindow);
  if (paced.length > 1) return 'several';
  if (paced.length === 1 && paced[0]!.id === 'claude') return 'claude-only';
  if (paced.length === 1) return 'several';
  return 'api-only';
}

export function refreshPlan(model: SetupModel): SetupModel {
  return { ...model, plan: planSetup(model.answers, model.current) };
}

export function openSetup(input: SetupOpen): SetupModel {
  const signedIn = input.tracks.filter((t) => t.signedIn).map(trackRow);
  const answers = input.firstRun ? emptyAnswers(startingStack(signedIn), signedIn) : answersFromCurrent(input.current);
  return refreshPlan({
    step: 'stack',
    answers,
    current: input.current,
    plan: planSetup(answers, input.current),
    tracks: input.tracks,
    apply: null,
    add: { form: emptyProviderForm(), existing: input.routes, picked: false, busy: false, error: '', embedded: true },
    profileText: '',
    profileProblems: [],
    firstRun: input.firstRun,
    seen: [],
    routeNotes: {},
    testing: null,
    busy: false,
  });
}

export function goStep(model: SetupModel, step: StepId): SetupModel {
  if (!SETUP_STEPS.some((s) => s.id === step) || model.step === step) return model;
  const seen = model.seen.includes(model.step) ? model.seen : [...model.seen, model.step];
  return { ...model, step, seen };
}

/** Moves between the four answer steps. Done is reached by Apply, or by the step list. */
export function shiftStep(model: SetupModel, dir: -1 | 1): SetupModel {
  if (model.step === 'done') return model;
  const ids = ['stack', 'providers', 'pace', 'review'] as const;
  const at = ids.indexOf(model.step);
  if (at < 0) return model;
  const next = ids[at + dir];
  return next ? goStep(model, next) : model;
}

export function selectStack(model: SetupModel, stack: StackId): SetupModel {
  if (stack === 'profile') {
    if (model.answers.stack === 'profile') return model;
    return refreshPlan({ ...model, answers: { ...model.answers, stack: 'profile' } });
  }
  const detected = model.tracks.filter((t) => t.signedIn).map(trackRow);
  return refreshPlan({ ...model, answers: emptyAnswers(stack, detected), profileText: '', profileProblems: [] });
}

/** A bad file sets the problems and leaves the answers and the plan as they were. */
export function loadProfile(model: SetupModel, text: string): SetupModel {
  const got = answersFromProfile(text, model.current);
  if ('problems' in got) return { ...model, profileText: text, profileProblems: [...got.problems] };
  return refreshPlan({ ...model, answers: got.answers, profileText: text, profileProblems: [] });
}

/** Adds subscriptions Check again newly found. Ones already answered stay as they are. */
export function applyDetection(model: SetupModel, tracks: SetupTrack[]): SetupModel {
  const detected = model.answers.detected.map((d) => ({ ...d }));
  const rank = [...model.answers.rank];
  const holdBack = { ...model.answers.holdBack };
  for (const t of tracks) {
    if (!t.signedIn) continue;
    const row = detected.find((d) => d.id === t.id);
    if (!row) {
      detected.push(trackRow(t));
      if (t.hasWindow) {
        rank.push(t.id);
        holdBack[t.id] = holdBack[t.id] ?? 'some';
      }
    }
  }
  return refreshPlan({ ...model, tracks, answers: { ...model.answers, detected, rank, holdBack } });
}

export function setConfirmed(model: SetupModel, id: string, confirmed: boolean): SetupModel {
  const detected = model.answers.detected.map((d) => d.id === id ? { ...d, confirmed } : d);
  const row = detected.find((d) => d.id === id);
  let rank = confirmed ? [...model.answers.rank] : model.answers.rank.filter((x) => x !== id);
  const holdBack = { ...model.answers.holdBack };
  if (!confirmed) delete holdBack[id];
  else if (row?.found && row.hasWindow) {
    if (!rank.includes(id)) rank = [...rank, id];
    if (!holdBack[id]) holdBack[id] = 'some';
  }
  return refreshPlan({ ...model, answers: { ...model.answers, detected, rank, holdBack } });
}

export function addUnfound(model: SetupModel, id: string): SetupModel {
  const track = model.tracks.find((t) => t.id === id);
  if (!track) return model;
  if (model.answers.detected.some((d) => d.id === id)) {
    const detected = model.answers.detected.map((d) => d.id === id ? { ...d, found: true, hasWindow: track.hasWindow, label: track.name } : d);
    return setConfirmed({ ...model, answers: { ...model.answers, detected } }, id, true);
  }
  const detected = [...model.answers.detected, { id, label: track.name, hasWindow: track.hasWindow, found: true, confirmed: true }];
  const rank = track.hasWindow ? [...model.answers.rank, id] : model.answers.rank;
  const holdBack = track.hasWindow ? { ...model.answers.holdBack, [id]: model.answers.holdBack[id] ?? 'some' as const } : model.answers.holdBack;
  return refreshPlan({ ...model, answers: { ...model.answers, detected, rank, holdBack } });
}

export function noteAdded(model: SetupModel, providerId: string): SetupModel {
  if (!providerId || model.answers.added.includes(providerId)) return model;
  return refreshPlan({ ...model, answers: { ...model.answers, added: [...model.answers.added, providerId] } });
}

export function setHold(model: SetupModel, id: string, choice: Exclude<HoldChoice, 'custom'>): SetupModel {
  return refreshPlan({ ...model, answers: { ...model.answers, holdBack: { ...model.answers.holdBack, [id]: choice } } });
}

export function moveRank(model: SetupModel, id: string, dir: -1 | 1): SetupModel {
  const rank = [...model.answers.rank];
  const at = rank.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= rank.length) return model;
  const swap = rank[to]!;
  rank[to] = rank[at]!;
  rank[at] = swap;
  return refreshPlan({ ...model, answers: { ...model.answers, rank } });
}

export function fillRank(model: SetupModel): SetupModel {
  if (model.answers.rank.length > 0) return model;
  const rank = model.answers.detected.filter((d) => d.confirmed && d.found && d.hasWindow).map((d) => d.id);
  if (!rank.length) return model;
  return refreshPlan({ ...model, answers: { ...model.answers, rank } });
}

export function setPayNone(model: SetupModel): SetupModel {
  return refreshPlan({ ...model, answers: { ...model.answers, payPerUse: { providers: [], amount: null } } });
}

export function togglePayProvider(model: SetupModel, id: string, on: boolean): SetupModel {
  const pay = model.answers.payPerUse ?? { providers: [] as string[], amount: null };
  const providers = on ? [...new Set([...pay.providers, id])] : pay.providers.filter((x) => x !== id);
  return refreshPlan({ ...model, answers: { ...model.answers, payPerUse: { providers, amount: pay.amount } } });
}

export function setPayAmount(model: SetupModel, amount: number | null): SetupModel {
  const pay = model.answers.payPerUse ?? { providers: [] as string[], amount: null };
  return refreshPlan({ ...model, answers: { ...model.answers, payPerUse: { providers: [...pay.providers], amount } } });
}

export function setStrength(model: SetupModel, label: string, value: Strength): SetupModel {
  return refreshPlan({ ...model, answers: { ...model.answers, strengths: { ...model.answers.strengths, [label]: value } } });
}

export function setListAnswer(model: SetupModel, which: 'prose' | 'seatsSecond', value: string[] | 'skipped'): SetupModel {
  return refreshPlan({ ...model, answers: { ...model.answers, [which]: value } });
}

export function useStrongFor(model: SetupModel, which: 'prose' | 'seatsSecond'): SetupModel {
  const labels = Object.entries(model.answers.strengths).filter(([, v]) => v === 'strong').map(([k]) => k).sort();
  return setListAnswer(model, which, labels);
}

export function toggleListModel(model: SetupModel, which: 'prose' | 'seatsSecond', label: string, on: boolean): SetupModel {
  const cur = model.answers[which];
  const list = Array.isArray(cur) ? [...cur] : [];
  const next = on ? [...new Set([...list, label])] : list.filter((x) => x !== label);
  return setListAnswer(model, which, next);
}

/**
 * Runs the plan's operations in order. A failed send stops the run. Operations that already finished stay in `ran`.
 */
export async function runApply(plan: SetupPlan, send: (op: SetupOp) => Promise<void>, onProgress?: (progress: SetupApplyProgress) => void | Promise<void>): Promise<SetupApplyProgress> {
  const progress: SetupApplyProgress = { ran: [], pending: null, failed: null, complete: false };
  if (!isValid(plan)) {
    progress.failed = { id: '', error: problems(plan).join(' ') };
    return progress;
  }
  for (const op of applySteps(plan)) {
    progress.pending = op.payload.id;
    if (onProgress) await onProgress({ ran: [...progress.ran], pending: progress.pending, failed: null, complete: false });
    try {
      await send(op);
    } catch (e) {
      const failed = { id: op.payload.id, error: e instanceof Error ? e.message : String(e) };
      const stopped = { ran: [...progress.ran], pending: null, failed, complete: false };
      if (onProgress) await onProgress(stopped);
      return stopped;
    }
    progress.ran.push(op.payload.id);
  }
  const done = { ran: [...progress.ran], pending: null, failed: null, complete: true };
  if (onProgress) await onProgress(done);
  return done;
}

const pacedOf = (answers: SetupAnswers): DetectedProvider[] => answers.detected.filter((d) => d.confirmed && d.found && d.hasWindow);

function stepNote(model: SetupModel, plan: SetupPlan, id: StepId): string {
  const names: Record<StackId, string> = { 'claude-only': 'Claude only', several: 'Several subscriptions', 'api-only': 'API keys only', profile: 'Profile file' };
  if (id === 'stack') return names[model.answers.stack];
  const status = stepStatus(model.answers, id);
  if (status === 'todo') return 'Not started';
  if (id === 'providers') return `${model.answers.detected.filter((d) => d.confirmed).length} confirmed`;
  if (id === 'pace') return status === 'partial' ? 'In progress' : plan.rankWords;
  if (id === 'review') return changeCount(applySteps(plan).length);
  return model.apply?.complete ? 'Applied' : status === 'partial' ? 'In progress' : 'Not started';
}

function changeLabel(plan: SetupPlan, id: string): string {
  return plan.changes.find((c) => c.id === id)?.label ?? id;
}

/** A failure before any write has no change id, so it shows the error alone. */
function failText(plan: SetupPlan, failed: { id: string; error: string }): string {
  return failed.id ? `Could not save ${changeLabel(plan, failed.id)}: ${failed.error}` : failed.error;
}

const seg = (label: string, options: Array<{ value: string; label: string; on: boolean; attrs: string }>): string =>
  `<div class="seg" role="radiogroup" aria-label="${esc(label)}">${options.map((o) =>
    `<button type="button" role="radio" aria-checked="${o.on}" class="${o.on ? 'on' : ''}" ${o.attrs}>${esc(o.label)}</button>`).join('')}</div>`;

function stackStep(model: SetupModel): string {
  const cards = STACKS.map((s) => {
    const on = model.answers.stack === s.id;
    return `<button type="button" class="setup-stack${on ? ' on' : ''}" data-action="setup-stack" data-stack="${s.id}" aria-pressed="${on}">
      <span class="setup-stack-h"><span class="ap-mark" aria-hidden="true">${esc(s.mark)}</span><b>${esc(s.title)}</b>${on ? '<span class="chip">Picked</span>' : ''}</span>
      <span class="help">${esc(s.help)}</span></button>`;
  }).join('');
  const found = model.tracks.filter((t) => t.signedIn).map((t) => t.name);
  const foundText = found.length ? `Augur found these signed in on this computer: ${found.join(', ')}.` : 'Augur found no subscription signed in on this computer.';
  const profile = model.answers.stack === 'profile' ? `<div class="card">
      <div class="field"><label for="setup-profile-file">Profile file</label>
        <input type="file" id="setup-profile-file" data-setup-file accept="application/json,.json"></div>
      <div class="field"><label for="setup-profile-text">Or paste the profile</label>
        <textarea id="setup-profile-text" data-setup-profile spellcheck="false">${esc(model.profileText)}</textarea></div>
      <div class="actions"><button type="button" class="btn" data-action="setup-profile">Check profile</button></div>
      ${model.profileProblems.length ? `<div class="rnote bad" role="alert">${model.profileProblems.map((p) => `<div>${esc(p)}</div>`).join('')}</div>` : ''}
    </div>` : '';
  return `<h2 class="sec">Pick a starting stack</h2><div class="setup-stacks">${cards}</div>${profile}
    <div class="card setup-found"><span class="setup-dot" aria-hidden="true"></span><span class="help">${esc(foundText)}</span>
      <button type="button" class="btn" data-action="setup-detect">Check again</button></div>`;
}

function providersStep(model: SetupModel): string {
  const rows = model.answers.detected.map((d) => `<div class="row"><label class="name">${esc(d.label)}<span class="desc">${d.hasWindow ? 'Has a usage window' : 'No usage window'}</span></label>
    <label class="switch"><input type="checkbox" data-setup-confirm="${esc(d.id)}" ${d.confirmed ? 'checked' : ''} aria-label="Confirm ${esc(d.label)}"><span></span></label></div>`).join('');
  const have = new Set(model.answers.detected.filter((d) => d.found).map((d) => d.id));
  const missing = model.tracks.filter((t) => SUBSCRIPTIONS.has(t.id) && !t.signedIn && !have.has(t.id));
  const missingHtml = missing.length ? `<h2 class="sec">Not found on this computer</h2><div class="card">${missing.map((t) =>
    `<div class="row"><label class="name">${esc(t.name)}</label><button type="button" class="btn small" data-action="setup-add-missing" data-id="${esc(t.id)}">I have this</button></div>`).join('')}</div>` : '';
  const tracks = model.tracks.map((t) => `<div class="row"><label class="name">${esc(t.name)}${t.locked ? '<span class="desc">Desktop only</span>' : ''}</label>
    <label class="switch"><input type="checkbox" data-setup-track="${esc(t.id)}" ${t.enabled ? 'checked' : ''} ${t.locked ? 'disabled' : ''} aria-label="Track ${esc(t.name)}"><span></span></label></div>`).join('');
  const added = model.answers.added.length ? `<p class="help">Added: ${esc(model.answers.added.join(', '))}</p>` : '';
  return `<h2 class="sec">Confirm what Augur found</h2><div class="card">${rows || '<p class="help">No subscription was found. Add an API service below, or go back to the first step and choose Check again.</p>'}</div>
    ${missingHtml}
    <h2 class="sec">Tracking</h2><div class="card"><p class="help">Turn on what you want to track. You can change this any time.</p>${tracks}</div>
    <h2 class="sec">API services</h2>${added}${model.add ? renderAddProvider(model.add) : ''}`;
}

function paceStep(model: SetupModel, plan: SetupPlan): string {
  const paced = pacedOf(model.answers);
  const holds = paced.map((d) => {
    const choice = model.answers.holdBack[d.id];
    const custom = choice === 'custom';
    const buttons = seg(`${d.label} hold-back`, HOLD_CHOICES.map((v) => ({ value: v, label: HOLD_LABEL[v], on: choice === v, attrs: `data-action="setup-hold" data-id="${esc(d.id)}" data-value="${v}"` })));
    const text = custom ? CUSTOM_HOLD : choice ? HOLD_BACK[choice].text : '';
    return `<div class="setup-hold" data-setup-hold="${esc(d.id)}"><div class="name">${esc(d.label)}</div>${buttons}${text ? `<p class="help">${esc(text)}</p>` : ''}</div>`;
  }).join('');
  const rank = model.answers.rank;
  const labelOf = new Map(model.answers.detected.map((d) => [d.id, d.label]));
  const rankHtml = rank.length ? `<ol class="setup-rank">${rank.map((id, i) => {
    const name = labelOf.get(id) ?? id;
    return `<li><span class="setup-rank-n">${i + 1}</span><span class="setup-rank-name">${esc(name)}</span>
      <button type="button" class="btn small" data-action="setup-rank" data-id="${esc(id)}" data-dir="up" aria-label="Move ${esc(name)} up" ${i === 0 ? 'disabled' : ''}>Up</button>
      <button type="button" class="btn small" data-action="setup-rank" data-id="${esc(id)}" data-dir="down" aria-label="Move ${esc(name)} down" ${i === rank.length - 1 ? 'disabled' : ''}>Down</button></li>`;
  }).join('')}</ol>` : `<p class="help">${esc(plan.rankWords)}</p>${paced.length >= 2 ? '<button type="button" class="btn" data-action="setup-rank-fill">Rank the subscriptions</button>' : ''}`;
  const pay = model.answers.payPerUse;
  const none = !!pay && pay.providers.length === 0;
  const options = new Map<string, string>();
  for (const t of model.tracks) if (!t.hasWindow) options.set(t.id, t.name);
  for (const id of model.answers.added) if (!options.has(id)) options.set(id, id);
  for (const id of pay?.providers ?? []) if (!options.has(id)) options.set(id, id);
  const checks = [...options.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) =>
    `<label class="setup-check"><input type="checkbox" data-setup-pay="${esc(id)}" ${pay?.providers.includes(id) ? 'checked' : ''}>${esc(name)}</label>`).join('');
  const amount = pay?.amount == null ? '' : String(pay.amount);
  return `<h2 class="sec">How much to hold back</h2><div class="card">${holds || '<p class="help">No subscription with a usage window is confirmed, so nothing is paced.</p>'}</div>
    <h2 class="sec">Order of use</h2><div class="card">${rankHtml}</div>
    <h2 class="sec">Pay per use</h2><div class="card">
      <button type="button" class="btn${none ? ' primary' : ''}" data-action="setup-pay-none" aria-pressed="${none}">No backup spending</button>
      <div class="setup-checks">${checks}</div>
      <div class="field"><label for="setup-amount">Monthly amount</label>
        <input type="number" min="0" step="1" id="setup-amount" data-setup-amount value="${esc(amount)}" aria-label="Monthly backup amount in dollars">
        <span class="help">Dollars per month. Choose No backup spending, or select the providers to use and enter an amount.</span></div>
    </div>`;
}

function listBlock(model: SetupModel, which: 'prose' | 'seatsSecond', title: string, action: string): string {
  const cur = model.answers[which];
  const labels = new Set(modelsOf(model.current).map((m) => m.label));
  if (Array.isArray(cur)) for (const x of cur) labels.add(x);
  const sorted = [...labels].sort();
  if (cur === 'skipped') return `<div><div class="name">${esc(title)}</div><p class="help">Skipped, so nothing changes.</p>
    <button type="button" class="btn small" data-action="${action}-clear">Choose models</button></div>`;
  const checks = sorted.map((label) => `<label class="setup-check"><input type="checkbox" data-${action}="${esc(label)}" ${Array.isArray(cur) && cur.includes(label) ? 'checked' : ''}>${esc(label)}</label>`).join('');
  return `<div><div class="name">${esc(title)}</div>${cur === null ? '<p class="help">Not chosen yet. Nothing changes until you pick models or choose Skip.</p>' : ''}
    <div class="setup-checks">${checks}</div>
    <div class="actions"><button type="button" class="btn small" data-action="${action}-strong">Use the strong models</button>
      <button type="button" class="btn small" data-action="${action}-skip">Skip</button></div></div>`;
}

function reviewStep(model: SetupModel, plan: SetupPlan): string {
  const models = modelsOf(model.current);
  const rows = models.map((m) => {
    const value = model.answers.strengths[m.label];
    const buttons = seg(`${m.label} strength`, (['strong', 'light', 'unsure'] as const).map((v) => ({
      value: v, label: v === 'strong' ? 'Strong' : v === 'light' ? 'Light' : 'Not sure', on: value === v,
      attrs: `data-action="setup-strength" data-model="${esc(m.label)}" data-value="${v}"`,
    })));
    return `<tr data-setup-model="${esc(m.label)}"><td><b>${esc(m.label)}</b><div class="help">${esc(m.provider)}</div></td><td>${buttons}</td></tr>`;
  }).join('');
  const n = applySteps(plan).length;
  const bad = problems(plan);
  const ran = model.apply;
  const progress = ran && (ran.ran.length || ran.failed || ran.pending) ? `<div class="card" role="status">
      ${ran.pending ? `<p>Applying ${esc(changeLabel(plan, ran.pending))}.</p>` : ''}
      ${ran.ran.length ? `<ul class="setup-ran">${ran.ran.map((id) => `<li data-ran="${esc(id)}">${esc(changeLabel(plan, id))} saved.</li>`).join('')}</ul>` : ''}
      ${ran.failed ? `<p class="bad-json" role="alert" data-failed="${esc(ran.failed.id)}">${esc(failText(plan, ran.failed))}</p>` : ''}
    </div>` : '';
  return `<h2 class="sec">What each model is good at</h2>
    <div class="card setup-table-wrap">${rows ? `<table class="setup-models"><tbody>${rows}</tbody></table>` : '<p class="help">No models are in the rules yet. Add an API service on the Providers and keys step, or apply without any.</p>'}
      <p class="help">Not sure leaves a model as it is.</p></div>
    <h2 class="sec">Prose and a second opinion</h2>
    <div class="card setup-pair">${listBlock(model, 'prose', 'Writes the best prose', 'setup-prose')}${listBlock(model, 'seatsSecond', 'Gives a second opinion', 'setup-second')}</div>
    ${bad.length ? `<div class="rnote bad" role="alert" data-setup-problems>${bad.map((p) => `<div>${esc(p)}</div>`).join('')}</div>` : ''}
    ${progress}
    <div class="actions">${model.firstRun ? '<button type="button" class="btn" data-action="setup-skip">Skip setup</button>' : ''}
      <button type="button" class="btn" data-action="setup-back">Back</button>
      <button type="button" class="btn primary" data-action="setup-apply" data-setup-apply ${!isValid(plan) || model.busy ? 'disabled' : ''}>Apply ${changeCount(n)}</button></div>`;
}

function doneStep(model: SetupModel, plan: SetupPlan): string {
  const done = afterApply(plan);
  const providerOf = new Map(modelsOf(model.current).map((m) => [m.label, m.provider]));
  const tests = done.routesToTest.length ? done.routesToTest.map((name) => {
    const note = model.routeNotes[name] ?? '';
    const testing = model.testing === name;
    return `<div class="row"><label class="name">${esc(name)}${note ? `<span class="desc">${esc(note)}</span>` : ''}</label>
      <button type="button" class="btn" data-action="setup-test" data-id="${esc(name)}" ${testing || model.testing ? 'disabled' : ''}>${testing ? 'Testing' : 'Test'}</button></div>`;
  }).join('') : '<p class="help">No route has a key yet.</p>';
  const open = done.unreviewed.length ? done.unreviewed.map((label) =>
    `<div class="row"><label class="name">${esc(label)}</label><button type="button" class="btn small" data-action="setup-rules" data-provider="${esc(providerOf.get(label) ?? '')}" data-model="${esc(label)}">Open rules</button></div>`).join('')
    : '<p class="help">Every model is confirmed.</p>';
  const next = done.next.map((line) => `<li>${esc(line)}</li>`).join('');
  return `<h2 class="sec">Test your routes</h2><div class="card">${tests}</div>
    <h2 class="sec">Still to confirm</h2><div class="card">${open}</div>
    <h2 class="sec">What happens next</h2><div class="card"><ol class="setup-next">${next}</ol></div>
    <div class="actions"><button type="button" class="btn primary" data-action="setup-close">Finish setup</button></div>`;
}

function summary(plan: SetupPlan): string {
  const tail = / \((unchanged|will change|new)\)$/;
  const groups = summaryLines(plan).flatMap((g) => g.lines.map((line) => ({ step: g.step, line })));
  if (!groups.length) return '<p class="help">Each setting your answers touch shows up here, marked new, will change, or unchanged.</p>';
  const items = groups.map(({ line }) => {
    const m = line.match(tail);
    if (!m) return `<li><span class="setup-sum-t">${esc(line)}</span></li>`;
    const body = line.slice(0, line.length - m[0].length);
    const cut = body.indexOf(': ');
    const title = cut < 0 ? body : body.slice(0, cut);
    const detail = cut < 0 ? '' : body.slice(cut + 2);
    const kind = m[1] === 'will change' ? 'change' : m[1] === 'new' ? 'new' : 'unchanged';
    const tag = kind === 'unchanged' ? 'setup-tag' : `setup-tag setup-tag-${kind}`;
    return `<li><span class="setup-sum-t">${esc(title)}${detail ? `<small>${esc(detail)}</small>` : ''}</span><span class="${tag}">${esc(m[1]!)}</span></li>`;
  }).join('');
  return `<ul class="setup-sum">${items}</ul>`;
}

/** A starting stack fills later steps before anyone opens them, and Done stays "Not started" until Apply. Neither gets a tick. */
function stepTicked(model: SetupModel, plan: SetupPlan, id: StepId): boolean {
  if (model.step === id || !model.seen.includes(id)) return false;
  const note = stepNote(model, plan, id);
  if (note === 'Not started' || note === '0 confirmed') return false;
  return stepStatus(model.answers, id) === 'ready';
}

function steps(model: SetupModel, plan: SetupPlan): string {
  const rows = SETUP_STEPS.map((s, i) => {
    const on = model.step === s.id;
    const mark = stepTicked(model, plan, s.id) ? `<span class="setup-num done">${TICK}</span>` : `<span class="setup-num${on ? ' now' : ''}">${i + 1}</span>`;
    return `<button type="button" class="setup-step${on ? ' on' : ''}" data-action="setup-step" data-step="${s.id}"${on ? ' aria-current="step"' : ''}>
      ${mark}<span><b>${esc(s.title)}</b><span class="help">${esc(stepNote(model, plan, s.id))}</span></span></button>`;
  }).join('');
  return `<p class="lab">Steps</p><div class="card setup-step-list">${rows}</div>
    <p class="help">You can jump to any step. A step you leave alone changes nothing.</p>`;
}

function nav(model: SetupModel): string {
  const ids = SETUP_STEPS.map((s) => s.id);
  const at = ids.indexOf(model.step);
  const back = at > 0 && model.step !== 'done' ? `<button type="button" class="btn" data-action="setup-back">Back</button>` : '';
  const next = model.step !== 'review' && model.step !== 'done' && at >= 0 && at < ids.length - 1
    ? `<button type="button" class="btn primary" data-action="setup-next">Continue</button>` : '';
  const skip = model.firstRun && model.step !== 'done' ? `<button type="button" class="btn" data-action="setup-skip">Skip setup</button>` : '';
  if (!back && !next && !skip) return '';
  return `<div class="actions">${skip}${back}${next}</div>`;
}

export function renderSetup(model: SetupModel): string {
  const plan = planSetup(model.answers, model.current);
  const body = model.step === 'providers' ? providersStep(model)
    : model.step === 'pace' ? paceStep(model, plan)
      : model.step === 'review' ? reviewStep(model, plan)
        : model.step === 'done' ? doneStep(model, plan)
          : stackStep(model);
  return `<div class="setup"><header class="top"><div><h1>Set up Augur</h1><div class="sub">Nothing is saved until you press Apply.</div></div></header>
    <div class="setup-cols"><div class="setup-steps">${steps(model, plan)}</div>
      <div class="setup-main">${body}${model.step === 'review' ? '' : nav(model)}</div>
      <div class="setup-summary" aria-live="polite"><p class="lab">What Augur will set</p><div class="card">${summary(plan)}</div></div></div></div>`;
}
