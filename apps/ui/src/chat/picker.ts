// Popovers: the model picker, the data-level chooser, and the small ones. Each closes on a click outside, on Escape, and when it is chosen from.
import type { ChatModelInfo } from '@augur/dispatch-protocol';
import type { DataTier } from '@augur/core';
import { TIER_COPY, TIER_LOCKED } from './copy';
import { clear, compact, h, icon } from './dom';
import { TIERS, fits, state, tierRank } from './state';

/** A steady color for a route, so the same model always looks like itself. */
export function hueOf(route: string): string {
  let n = 0;
  for (const c of route) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${n % 360} 52% 46%)`;
}
export const initialOf = (m: { label: string }): string => (m.label.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();

export function pips(tier: DataTier): HTMLElement {
  const at = tierRank(tier);
  return h('span', { class: 'pips', 'aria-hidden': 'true' }, ...TIERS.map((_, i) => h('i', { class: i <= at ? 'on' : '' })));
}

export function modelBadges(m: ChatModelInfo): HTMLElement {
  return h('span', { class: 'badges' },
    h('span', { class: 'badge', 'data-card-title': m.local ? 'Runs on your network' : 'Runs on a hosted service', 'data-card': m.local ? 'Your text is sent to a machine you control and goes no further.' : 'Your text is sent over the internet to the provider that runs this model.' }, icon(m.local ? 'home' : 'cloud', 12), m.local ? 'Local' : 'Hosted'),
    m.vision ? h('span', { class: 'badge', 'data-tip': 'Can look at images' }, icon('eye', 12)) : null,
    m.contextTokens ? h('span', { class: 'badge', 'data-tip': 'How much text it can hold in mind at once' }, `${compact(m.contextTokens)} ctx`) : null,
  );
}

let close: (() => void) | null = null;
export const closePop = (): void => { close?.(); close = null; };

/** Opens `body` as a popover near `anchor`. */
export function popover(anchor: HTMLElement, body: HTMLElement, opts: { align?: 'left' | 'right'; up?: boolean } = {}): void {
  closePop();
  const scrim = h('div', { class: 'scrim', on: { pointerdown: () => closePop() } });
  body.classList.add('pop');
  document.body.append(scrim, body);
  const a = anchor.getBoundingClientRect(), r = body.getBoundingClientRect(), pad = 8;
  let x = opts.align === 'right' ? a.right - r.width : a.left;
  x = Math.max(pad, Math.min(x, innerWidth - r.width - pad));
  let y = opts.up ? a.top - r.height - 8 : a.bottom + 8;
  if (y + r.height > innerHeight - pad) y = Math.max(pad, a.top - r.height - 8);
  if (y < pad) y = pad;
  body.style.left = `${x}px`;
  body.style.top = `${y}px`;
  const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); anchor.focus(); } };
  document.addEventListener('keydown', key, true);
  close = () => { document.removeEventListener('keydown', key, true); scrim.remove(); body.remove(); };
}

export interface PickOptions { title?: string; current?: string; onPick(route: string): void; up?: boolean; align?: 'left' | 'right'; tier?: DataTier }

/** The model picker: search, grouped by where the model runs, and a reason beside any model that cannot take this chat. */
export function openModelPicker(anchor: HTMLElement, o: PickOptions): void {
  const tier = o.tier ?? state.current?.tier ?? state.draft.tier;
  const list = h('div', { class: 'list' }), input = h('input', { type: 'search', placeholder: 'Find a model', 'aria-label': 'Find a model', autocomplete: 'off' });
  const wrap = h('div', { class: 'picker', role: 'dialog', 'aria-label': o.title ?? 'Choose a model' }, h('div', { class: 'search' }, input), list);
  const draw = (): void => {
    clear(list);
    const q = input.value.trim().toLowerCase();
    const rows = state.models.filter(m => !q || `${m.label} ${m.model} ${m.route}`.toLowerCase().includes(q));
    if (!rows.length) { list.append(h('p', { class: 'empty-list' }, state.models.length ? 'No model matches.' : 'No chat models are set up yet.')); return; }
    const groups: Array<[string, ChatModelInfo[]]> = [['On your network', rows.filter(m => m.local)], ['Hosted', rows.filter(m => !m.local)]];
    for (const [name, items] of groups) {
      if (!items.length) continue;
      list.append(h('h6', {}, name));
      for (const m of items) {
        const ok = fits(m, tier), why = !m.usable ? (m.why ?? 'The rules do not allow this model right now.') : !ok ? `Cleared up to ${m.tierMax ? TIER_COPY[m.tierMax].name.toLowerCase() : 'no'} data, and this chat is ${TIER_COPY[tier].name.toLowerCase()}.` : '';
        const btn = h('button', { class: `opt${m.route === o.current ? ' cur' : ''}`, type: 'button', disabled: !ok, on: { click: () => { closePop(); o.onPick(m.route); } } },
          h('span', { class: 'av', style: { background: hueOf(m.route) } }, initialOf(m)),
          h('span', { class: 'tx' }, h('b', {}, m.label), h('small', {}, why || m.model), modelBadges(m)),
          m.route === o.current ? h('span', { class: 'tick' }, icon('check', 16)) : null);
        list.append(btn);
      }
    }
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') list.querySelector<HTMLButtonElement>('.opt:not(:disabled)')?.click(); });
  draw();
  popover(anchor, wrap, { ...(o.up ? { up: true } : {}), ...(o.align ? { align: o.align } : {}) });
  input.focus();
}

/** The data-level chooser. A level below the chat's own is locked once it has messages. */
export function openTierMenu(anchor: HTMLElement, current: DataTier, locked: boolean, onPick: (t: DataTier) => void, up = false): void {
  const body = h('div', { class: 'tierlist', role: 'menu', 'aria-label': 'Data level' });
  body.append(h('h6', {}, 'How sensitive is this chat?'));
  for (const t of TIERS) {
    const below = locked && tierRank(t) < tierRank(current), anyone = state.models.some(m => fits(m, t));
    body.append(h('button', { class: `opt${t === current ? ' cur' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': t === current, disabled: below, title: below ? TIER_LOCKED : '', on: { click: () => { closePop(); onPick(t); } } },
      pips(t), h('span', { class: 'tx' }, h('b', {}, TIER_COPY[t].name), h('small', {}, below ? TIER_LOCKED : TIER_COPY[t].blurb), !anyone && !below ? h('small', { style: 'color:var(--warn)' }, 'No model you have set up is cleared for this yet.') : null),
      t === current ? h('span', { class: 'tick' }, icon('check', 16)) : null));
  }
  popover(anchor, body, { align: 'left', up });
}
