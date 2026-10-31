import { emptyPolicy, migrateConfig, undoChange, type ModelEntry, type Shell } from '@augur/core';
import { initialNodeState, NODE_TEXT } from '@augur/view-model';
import { App } from '../src/app';
import { registerNodeView, type NodeModel } from '../src/views/node-view';
import '../src/node-view.css';

const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const key = (target: Element, value: string, extra = {}): void => { target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })); };
const pointer = (target: EventTarget, type: string, x = 0, y = 0, pointerType = 'touch'): void => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType })); };
const click = (target: Element, detail = 0): void => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); };
let dispose = (): void => {};

function fixture(wiring = false, tab: NodeModel['node']['tab'] = 'weight') {
  dispose(); document.body.replaceChildren();
  const config = migrateConfig({}); config.policy = emptyPolicy(); config.policy.balance = { profile: 'neutral' };
  const entry = (id: string): ModelEntry => ({ id, source: 'manual', status: 'confirmed', firstSeen: '', rule: {} });
  config.policy.providers.openrouter = { defaults: { dataTier: 'regulated', activities: { write_code: 'normal', review_code: 'often' }, askFirst: false }, models: { 'openrouter/terra': entry('terra'), 'openrouter/luna': entry('luna') } };
  const m: NodeModel = { config, held: [], providers: [], plugins: new Map(), snapshot: null, dark: true, policyError: null, sel: { provider: 'openrouter', model: 'openrouter/terra' }, query: '', filter: 'all', open: new Set(), picked: new Set(), showHistory: false, addError: '', note: '', bulkTier: '', bulkField: 'cost', bulkValue: '', preview: null, dialOpen: false, dialEnd: '', dialCustom: '', dialPlan: null, dialError: '', pauseMode: 'off', pauseWeights: {}, catalog: { openrouter: { fetchedAt: '', models: [{ id: 'new' }] } }, listing: new Set(), canList: false, mode: 'node', node: { ...initialNodeState(), tab } };
  const root = document.createElement('div'), tip = document.createElement('div'); document.body.append(root, tip);
  let saves = 0, renders = 0;
  const app = new App({ kind: 'desktop', host: { platform: 'windows' } } as Shell, root, tip) as any;
  Object.assign(app, { config, snapshot: null, catalog: m.catalog, nodeState: m.node, view: 'rules', rulesMode: 'node', nodeSel: m.sel });
  app.saveRules = async () => { saves++; }; app.render = async () => { renders++; };
  if (wiring) app.wireEvents();
  registerNodeView();
  const node = document.createElement('augur-node-view') as HTMLElement & { model: NodeModel; activity: string; openSwitcher(): void };
  const edits: Array<{ path: string; value: unknown }> = [], selections: unknown[] = [], adds: unknown[] = [];
  node.addEventListener('node-edit', event => edits.push((event as CustomEvent).detail));
  node.addEventListener('node-select', event => selections.push((event as CustomEvent).detail));
  node.addEventListener('node-add', event => adds.push((event as CustomEvent).detail));
  root.append(node); node.model = m;
  dispose = () => { app.view = 'dashboard'; root.remove(); tip.remove(); };
  const q = <T extends Element = HTMLElement>(selector: string): T => { const found = node.querySelector<T>(selector); if (!found) throw new Error(`Missing element: ${selector}`); return found; };
  const redraw = (): void => { node.model = { ...m, node: app.nodeState, sel: app.nodeSel }; };
  return { app, m, node, root, tip, q, redraw, edits, selections, adds, saves: () => saves, renders: () => renders };
}

export async function run(name: string): Promise<string> {
  const f = fixture(['add refusal', 'copy undo', 'suggest undo', 'Ctrl K drafts', 'Ctrl K drag', 'activity shortcuts', 'tooltip scope'].includes(name), name === 'Ctrl K drafts' ? 'behavior' : 'weight');
  const { node, q, edits, m, app } = f;
  switch (name) {
    case 'drag commit':
      pointer(q('[data-node-edge]'), 'pointerdown'); pointer(document, 'pointermove', 40); pointer(document, 'pointerup', 40);
      check(edits.length === 1 && edits[0]!.value === 'often', 'A drag must commit one detent once.');
      check(!m.config.policy!.providers.openrouter!.models['openrouter/terra']!.rule.activities, 'The preview must preserve inheritance.'); break;
    case 'drag cancel':
      pointer(q('[data-node-edge]'), 'pointerdown'); pointer(document, 'pointermove', 40); pointer(document, 'pointercancel', 40);
      check(edits.length === 0 && q('[data-node-edge]').getAttribute('aria-valuetext') === 'Normal', 'Cancel must restore the original level.'); break;
    case 'click without movement':
      pointer(q('[data-node-edge]'), 'pointerdown'); pointer(document, 'pointerup');
      check(edits.length === 0, 'A stationary click must preserve inheritance.'); break;
    case 'keyboard slider':
      key(q('[data-node-edge]'), 'ArrowRight'); key(q('[data-node-edge]'), 'ArrowRight');
      check(edits.length === 0, 'Keyboard steps must wait for the idle gap.');
      await wait(400); check(edits.length === 1 && edits[0]!.value === 'preferred', 'Keyboard steps must commit together.');
      key(q('[data-node-edge]'), 'ArrowLeft'); await wait(400); check(edits.length === 2, 'An idle gap must start another entry.'); break;
    case 'range keyboard': {
      const range = q<HTMLInputElement>('#nv-level');
      for (const value of ['3', '4']) { key(range, 'ArrowRight'); range.value = value; range.dispatchEvent(new Event('input', { bubbles: true })); range.dispatchEvent(new Event('change', { bubbles: true })); }
      check(range.getAttribute('aria-valuetext') === 'Preferred', 'The range must announce its current level.');
      check(edits.length === 0, 'Range steps must wait for the idle gap.'); await wait(400);
      check(edits.length === 1 && edits[0]!.value === 'preferred', 'Range steps must commit together.'); break;
    }
    case 'tab arrows':
      q<HTMLElement>('#nv-tab-weight').focus(); key(q('#nv-tab-weight'), 'ArrowRight');
      check(document.activeElement?.id === 'nv-tab-data' && q('#nv-tab-data').getAttribute('aria-selected') === 'true', 'Arrow keys must select and focus the next tab.');
      key(q('#nv-tab-data'), 'End'); check(document.activeElement?.id === 'nv-tab-behavior', 'End must select the last tab.'); break;
    case 'ring arrows': {
      check(node.querySelectorAll('.nv-slice > path[tabindex="0"]').length === 1 && node.querySelectorAll('.nv-label[tabindex]').length === 0, 'The ring must use one slice tab stop.');
      const first = q<HTMLElement>('.nv-slice > path[tabindex="0"]'); first.focus(); key(first, 'ArrowRight');
      check(document.activeElement?.id !== first.id && document.activeElement?.matches('.nv-slice > path'), 'Arrows must move focus between slices.');
      check(node.querySelectorAll('[data-node-edge][tabindex="0"]').length === 1, 'The selected edge must remain reachable.'); break;
    }
    case 'Escape':
      pointer(q('[data-node-edge]'), 'pointerdown'); pointer(document, 'pointermove', 40); key(q('[data-node-edge]'), 'Escape'); pointer(document, 'pointerup');
      check(edits.length === 0, 'Escape must cancel the drag.');
      q<HTMLElement>('#nv-activity').focus(); node.openSwitcher(); key(q('#nv-activity-search'), 'Escape');
      check(!node.querySelector('.nv-switch') && document.activeElement?.id === 'nv-activity', 'Escape must close and restore focus.'); break;
    case 'focus trap': {
      node.openSwitcher(); const search = q<HTMLInputElement>('#nv-activity-search'); search.value = 'zzzz'; search.dispatchEvent(new Event('input', { bubbles: true }));
      key(q('#nv-activity-search'), 'Tab', { shiftKey: true }); check(document.activeElement?.id === 'nv-gate-dialog', 'The gate must stay in the focus trap.');
      key(q('#nv-gate-dialog'), 'Tab'); check(document.activeElement?.id === 'nv-activity-search', 'Tab must wrap to search.');
      click(q('[data-node-switch="close"]')); check(document.activeElement?.matches('.nv-phone-search'), 'Close must restore a live control.'); break;
    }
    case 'long press': {
      const slice = q('[data-node-select]'); pointer(slice, 'pointerdown'); await wait(450);
      check(node.querySelector('[role="tooltip"]'), 'A touch hold must show the tooltip.'); pointer(slice, 'pointerup'); click(slice, 1);
      check(f.selections.length === 0 && !node.querySelector('.nv-touch-tip'), 'The held touch click must be suppressed.'); break;
    }
    case 'outside release':
      pointer(q('[data-node-select]'), 'pointerdown'); await wait(450); pointer(document, 'pointerup'); click(q('[data-node-select]'));
      check(f.selections.length === 1 && !node.querySelector('.nv-touch-tip'), 'An outside release must allow the next keyboard click.'); break;
    case 'cancel and blur':
      for (const event of ['pointercancel', 'blur']) {
        pointer(q('[data-node-select]'), 'pointerdown'); await wait(450);
        if (event === 'blur') window.dispatchEvent(new Event('blur')); else pointer(document, event);
        check(!node.querySelector('.nv-touch-tip'), 'Cancellation must remove the held tooltip.'); click(q('[data-node-select]'));
      }
      check(f.selections.length === 2, 'Cancellation must preserve keyboard selection.'); break;
    case 'mouse hold':
      pointer(q('[data-node-select]'), 'pointerdown', 0, 0, 'mouse'); await wait(450); pointer(document, 'pointerup', 0, 0, 'mouse'); click(q('[data-node-select]'), 1);
      check(f.selections.length === 1 && !node.querySelector('.nv-touch-tip'), 'A mouse hold must select normally.'); break;
    case 'node selection':
      m.sel = null; node.model = m; check(m.sel === null && f.selections.length === 0, 'Initial node selection must leave list selection alone.'); break;
    case 'catalog tap':
      click(q('[data-node-add]')); check(f.adds.length === 0, 'A catalog tap must select a candidate.');
      click(q('[data-node-confirm-add]')); check(f.adds.length === 1, 'Add must work without drag events.'); break;
    case 'drag feedback': {
      const item = q('[data-node-add]'); item.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      m.node.dataTier = 'regulated'; m.config.policy!.providers.openrouter!.defaults.dataTier = 'public';
      q('.nv-gauge').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
      check(q('.nv-preview').textContent === NODE_TEXT.refuseTier, 'A refused hover must explain the gate.');
      node.dispatchEvent(new DragEvent('dragend', { bubbles: true })); check(q('.nv-preview').textContent === NODE_TEXT.preview, 'Drag end must clear refusal feedback.');
      m.nodeNote = NODE_TEXT.refuseTier; node.model = m; node.activity = 'review_code'; check(q('.nv-preview').textContent === NODE_TEXT.preview, 'Activity changes must clear refusal feedback.'); break;
    }
    case 'add refusal': {
      const rules = m.config.policy!.providers.openrouter!, entry = rules.models['openrouter/terra']!;
      entry.rule.activities = { write_code: 'preferred' };
      await app.addNodeModels(['openrouter/terra']); check(entry.rule.activities.write_code === 'preferred' && app.nodeNote, 'Existing levels must not be overwritten.');
      for (const rule of [{ askFirst: true }, { pause: { until: '2099-01-01T00:00:00Z', weights: null } }, { activities: { write_code: null } }, { dataTier: 'public' }]) {
        rules.defaults.activities = {}; entry.rule = rule as ModelEntry['rule']; await app.addNodeModels(['openrouter/terra']);
        check(app.nodeNote && entry.rule.activities?.write_code !== 'normal', 'Refused additions must explain and preserve their rule.');
      }
      entry.rule = {}; entry.status = 'unreviewed'; await app.addNodeModels(['openrouter/terra']); check(app.nodeNote && entry.status === 'unreviewed', 'Unreviewed entries must remain refused.');
      rules.defaults.askFirst = true; await app.addNodeModels(['openrouter/new']); check(app.nodeNote && !rules.models['openrouter/new'], 'A refused default must also block new catalog entries.');
      rules.defaults.askFirst = false; entry.status = 'confirmed';
      app.snapshot = { schema: 1, generatedAt: new Date().toISOString(), providers: { openrouter: { meters: [{ id: 'week', usedPct: 100 }], money: [] } } };
      await app.addNodeModels(['openrouter/terra']); check(app.nodeNote && !entry.rule.activities?.write_code, 'An expended entry must remain out of the catalog.'); break;
    }
    case 'copy undo': {
      node.dispatchEvent(new CustomEvent('node-copy', { bubbles: true, detail: { activity: 'review_code' } }));
      const policy = m.config.policy!; check(policy.history.length === 1 && f.saves() === 1, 'Copy must make one entry and save.');
      check(Object.values(policy.providers.openrouter!.models).every(entry => entry.rule.activities?.write_code === 'often'), 'Copy must edit every source entry.');
      undoChange(policy, policy.history[0]!, 'test'); check(Object.values(policy.providers.openrouter!.models).every(entry => entry.rule.activities?.write_code === undefined), 'One undo must restore the whole copy.'); break;
    }
    case 'suggest undo': {
      m.config.policy!.providers.cogitator = { defaults: { dataTier: 'regulated', askFirst: false }, models: {} };
      m.catalog.cogitator = { fetchedAt: '', models: ['gemma-4-12b', 'gemma-4-e4b-it-qat', 'gemma-4-e2b-it-qat'].map(id => ({ id })) };
      app.nodeState.activity = 'summarize_extract'; node.dispatchEvent(new CustomEvent('node-suggest', { bubbles: true }));
      const policy = m.config.policy!, entries = Object.values(policy.providers.cogitator!.models);
      check(entries.length === 3 && entries.every(entry => entry.status === 'unreviewed'), 'Suggestions must add three unreviewed entries.');
      check(policy.history.length === 1 && f.saves() === 1, 'Suggestions must record one history entry and save.');
      undoChange(policy, policy.history[0]!, 'test'); check(entries.every(entry => entry.status === 'hidden' && !entry.rule.activities?.summarize_extract), 'One undo must remove the whole suggestion from use.'); break;
    }
    case 'Ctrl K drafts':
      for (const tab of ['behavior', 'data']) {
        m.node.tab = tab as NodeModel['node']['tab']; node.model = m;
        const fields = [...node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-rule][type="text"],textarea[data-rule]')];
        check(fields.length > 0, 'The fixture must include draft fields.'); for (const input of fields) input.value = 'pending text';
        fields[0]!.focus(); key(fields[0]!, 'k', { ctrlKey: true }); check(node.querySelector('.nv-switch'), 'Ctrl K must open search.');
        click(q('[data-node-switch="close"]')); check(fields.every(input => input.isConnected && input.value === 'pending text'), 'Search must preserve effort, notes, and country drafts.');
      }
      check(f.renders() === 0, 'Ctrl K must leave the root intact.'); break;
    case 'Ctrl K drag':
      pointer(q('[data-node-edge]'), 'pointerdown'); pointer(document, 'pointermove', 40); key(q('[data-node-edge]'), 'k', { ctrlKey: true }); pointer(document, 'pointerup', 40);
      check(edits.length === 1 && edits[0]!.value === 'often' && f.renders() === 0, 'Ctrl K must preserve an active drag.'); break;
    case 'activity shortcuts':
      key(q('#nv-activity'), ']'); check(app.nodeState.activity === 'review_code', 'Right bracket must step forward.');
      key(q('#nv-activity'), '['); check(app.nodeState.activity === 'write_code', 'Left bracket must step backward.');
      key(q('#nv-catalog-search'), ']'); check(app.nodeState.activity === 'write_code', 'Typing brackets must preserve the activity.'); break;
    case 'tooltip scope': {
      const outside = document.createElement('button'); f.root.append(outside); f.tip.style.opacity = '1';
      await app.onClick({ target: outside }); check(f.tip.style.opacity === '1', 'Clicks outside the node view must preserve other tooltips.');
      outside.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); check(f.tip.style.opacity === '1', 'Focus outside the node view must preserve other tooltips.');
      app.onHover({ target: q('[data-node-tip]') }); check(f.tip.classList.contains('node-tip'), 'Node hover must use the custom tooltip.');
      q('[data-node-tip]').dispatchEvent(new FocusEvent('focusout', { bubbles: true })); check(!f.tip.classList.contains('rich'), 'Node focus dismissal must remove its classes.');
      await app.onClick({ target: q('[data-node-select]') }); check(!f.tip.classList.contains('rich') && !f.tip.classList.contains('node-tip'), 'Node dismissal must remove its classes.');
      check(!node.querySelector('[data-node-tip][title]'), 'Node controls must use only the custom tooltip.'); break;
    }
    case 'phone layout': {
      const layout = q('.nv-layout'); check(layout.tagName === 'MAIN', 'The layout must preserve its main landmark.');
      check(![...node.querySelectorAll('.nv-chips button span')].some(span => span.textContent === '0%'), 'Mix chips must include only active entries.');
      check(q('[data-node-edge]').getBoundingClientRect().width >= 24 && getComputedStyle(q('[data-node-edge]')).opacity === '1', 'Phone edges must have a visible touch target.');
      check(q('#nv-level').getAttribute('aria-label') === 'terra: Level' && q('#nv-level').getAttribute('aria-valuetext') === 'Normal', 'The range must label its subject and level.'); break;
    }
    case 'phone focus':
      node.openSwitcher(); click(q('[data-node-switch="close"]')); check(document.activeElement?.matches('[data-node-switch="open"]'), 'Close must focus an activity control.'); break;
    case 'popup bounds': {
      let size: number[] = []; app.shell.setPopupSize = async (...value: number[]) => { size = value; }; app.shell.maxPopupHeight = async () => 600;
      await app.sizePopup(); check(size[0]! <= screen.availWidth && size[1]! <= 600, 'The popup must fit the available screen.'); break;
    }
    case 'null level':
      m.config.policy!.providers.openrouter!.models['openrouter/terra']!.rule.activities = { write_code: null }; node.model = m;
      check(q('output').textContent === NODE_TEXT.notAllowed && q('#nv-level').getAttribute('aria-valuetext') === NODE_TEXT.notAllowed, 'A blocked level must not read Normal.'); break;
    case 'blocked chips':
      m.config.policy!.providers.openrouter!.models['openrouter/terra']!.status = 'hidden'; node.model = m;
      check(node.querySelectorAll('.nv-chips button').length === 1 && !q('.nv-chips').textContent?.includes('terra'), 'Mix chips must omit hidden entries.');
      m.config.policy!.providers.openrouter!.models['openrouter/luna']!.rule.askFirst = true; node.model = m;
      check(node.querySelectorAll('.nv-chips button').length === 0, 'Mix chips must omit refused entries.'); break;
    default: throw new Error(`Unknown case: ${name}`);
  }
  return name;
}
