// The sidebar: new chat, search, and the saved and temporary chats grouped by when they were last used.
import type { ChatSummary } from '@augur/dispatch-protocol';
import { ago, clear, h, icon, iconButton } from './dom';
import { closePop, popover } from './picker';
import { PREF_TIPS } from './copy';
import { loadChats, model, newChat, openChat, pin, remove, setPrefs, state, type Theme } from './state';

let list: HTMLElement, search: HTMLInputElement, timer: ReturnType<typeof setTimeout> | undefined;

function groupName(c: ChatSummary, now: Date): string {
  if (c.pinned) return 'Pinned';
  const day = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(now.getTime()) - day(c.updatedAt)) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 8 ? 'Previous 7 days' : 'Earlier';
}

function row(c: ChatSummary & { snippet?: string }): HTMLElement {
  const sub = (c.snippet || c.preview || (model(c.route)?.label ?? c.route)).replace(/[#*_`>|~[\]]+/g, '').replace(/\s+/g, ' ').trim();
  const del = iconButton('trash', 'Delete this chat', e => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    if (btn.dataset.sure) { void remove(c.id); return; }
    btn.dataset.sure = '1';
    btn.classList.add('danger', 'on');
    btn.dataset.tip = 'Click again to delete';
    setTimeout(() => { delete btn.dataset.sure; btn.classList.remove('on'); btn.dataset.tip = 'Delete this chat'; }, 2600);
  });
  const el = h('div', { class: `row${state.current?.id === c.id ? ' on' : ''}`, role: 'button', tabIndex: 0, dataset: { id: c.id }, 'aria-current': state.current?.id === c.id ? 'true' : undefined },
    c.temporary ? h('span', { class: 'pinned', 'data-tip': 'Temporary chat' }, icon('ghost', 16)) : null,
    h('div', { class: 'rt' }, h('b', {}, c.title), h('small', {}, `${ago(c.updatedAt)}${sub ? ` - ${sub}` : ''}`)),
    h('span', { class: 'acts' }, iconButton('pin', c.pinned ? 'Unpin' : 'Pin to the top', e => { e.stopPropagation(); void pin(c.id, !c.pinned); }, c.pinned ? 'on' : ''), del));
  el.addEventListener('click', () => { document.querySelector('.chat-root')?.classList.remove('side-open'); void openChat(c.id); });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  return el;
}

export function renderList(): void {
  clear(list);
  if (!state.chats.length) { list.append(h('p', { class: 'empty-list' }, state.query ? 'No chat matches that.' : 'Your chats will be listed here.')); return; }
  const now = new Date(), order = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Earlier'], groups = new Map<string, Array<ChatSummary & { snippet?: string }>>();
  for (const c of state.chats) { const g = state.query ? 'Matches' : groupName(c, now); groups.set(g, [...(groups.get(g) ?? []), c]); }
  for (const g of state.query ? ['Matches'] : order) {
    const items = groups.get(g);
    if (!items) continue;
    list.append(h('div', { class: 'grp' }, g), ...items.map(row));
  }
}

export function openPrefs(anchor: HTMLElement): void {
  const p = state.prefs;
  const sw = (on: boolean, change: (v: boolean) => void, label: string, tip: string): HTMLElement =>
    h('label', { class: 'line', 'data-card-title': label, 'data-card': tip }, h('span', {}, label), h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: on, on: { change: e => change((e.target as HTMLInputElement).checked) } }), h('span')));
  const themes: Array<[Theme, string, string]> = [['system', 'auto', 'Follow the system'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']];
  const body = h('div', { class: 'prefs', role: 'dialog', 'aria-label': 'Preferences' },
    h('div', { class: 'line' }, h('span', {}, 'Theme'), h('span', { class: 'seg' }, ...themes.map(([t, ic, tip]) => h('button', { type: 'button', class: p.theme === t ? 'on' : '', 'aria-label': tip, 'data-tip': tip, on: { click: () => { setPrefs({ theme: t }); closePop(); } } }, icon(ic, 16))))),
    h('div', { class: 'line' }, h('span', {}, 'Text size'), h('span', { class: 'seg' }, ...[[0.9, 'S'], [1, 'M'], [1.12, 'L'], [1.25, 'XL']].map(([v, l]) => h('button', { type: 'button', class: p.textSize === v ? 'on' : '', on: { click: () => { setPrefs({ textSize: v as number }); closePop(); } } }, String(l))))),
    sw(p.compact, v => setPrefs({ compact: v }), 'Compact spacing', PREF_TIPS.compact),
    sw(p.motion, v => setPrefs({ motion: v }), 'Animations', PREF_TIPS.motion),
    sw(p.openThinking, v => setPrefs({ openThinking: v }), 'Show reasoning open', PREF_TIPS.thinking));
  popover(anchor, body, { up: true });
}

export function mountSidebar(host: HTMLElement): void {
  search = h('input', { type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats', autocomplete: 'off' });
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.query = search.value; void loadChats(); }, 220); });
  list = h('div', { class: 'side-list' });
  const prefs = iconButton('sliders', 'Preferences', e => openPrefs(e.currentTarget as HTMLElement));
  host.append(
    h('div', { class: 'side-head' }, h('div', { class: 'brand' }, h('span', { class: 'mark' }), 'Augur Chat'), iconButton('close', 'Close the list', () => document.querySelector('.chat-root')?.classList.remove('side-open'), 'only-narrow')),
    h('div', { class: 'side-new' },
      h('button', { class: 'btn primary', type: 'button', on: { click: () => { newChat(); document.querySelector('.chat-root')?.classList.remove('side-open'); } } }, icon('plus', 16), 'New chat'),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'New temporary chat', 'data-card-title': 'Temporary chat', 'data-card': 'Kept in memory only. It is gone when you close it or the service restarts, and it never touches the disk.', on: { click: () => { newChat({ temporary: true }); document.querySelector('.chat-root')?.classList.remove('side-open'); } } }, icon('ghost', 16))),
    h('div', { class: 'side-search' }, icon('search', 16), search),
    list,
    h('div', { class: 'side-foot' }, h('a', { href: '../', 'data-tip': 'Usage and settings' }, 'Usage'), h('span', { class: 'grow' }), prefs));
  renderList();
}
