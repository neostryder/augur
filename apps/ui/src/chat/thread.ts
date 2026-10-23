// The conversation: the messages on the branch being read, with their attachments, reasoning, branch switcher and actions.
// Structure re-renders when messages change; while a reply streams only its own text is redrawn, once a frame.
import type { ChatFileRef, ChatMessage } from '@augur/dispatch-protocol';
import { fileUrl } from './api';
import { EMPTY } from './copy';
import { clear, compact, h, icon, iconButton, replace } from './dom';
import { render } from './markdown';
import { hueOf, initialOf, modelBadges, openModelPicker } from './picker';
import { activeTier, editAndSend, fits, model, pathOf, regenerate, setRoute, siblingsOf, state, switchBranch } from './state';

let editing: string | null = null;
let stuck = true;
let live: { id: string; body: HTMLElement; think: HTMLDetailsElement | null; sum: HTMLElement | null; raf: number } | null = null;

export function lightbox(src: string): void {
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Image', on: { click: () => box.remove() } }, h('img', { src, alt: '' }));
  const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', key); } };
  document.addEventListener('keydown', key);
  document.body.append(box);
}

function fileEl(f: ChatFileRef): HTMLElement {
  if (f.kind === 'image') {
    const img = h('img', { class: 'thumb', alt: f.name, loading: 'lazy' });
    fileUrl(f.id).then(u => { img.src = u; img.addEventListener('click', () => lightbox(u)); }, () => { img.alt = `${f.name} could not be loaded`; });
    return img;
  }
  if (f.kind === 'audio') {
    const a = h('audio', { class: 'player', controls: true, preload: 'none', 'aria-label': f.name });
    fileUrl(f.id).then(u => { a.src = u; }, () => undefined);
    return a;
  }
  const chip = h('a', { class: 'fchip', href: '#', download: f.name, title: `Download ${f.name}` }, icon(f.kind === 'text' ? 'file' : 'download', 16), h('span', {}, f.name));
  chip.addEventListener('click', e => { e.preventDefault(); void fileUrl(f.id).then(u => { const a = h('a', { href: u, download: f.name }); document.body.append(a); a.click(); a.remove(); }); });
  return chip;
}

const filesEl = (m: ChatMessage): HTMLElement | null => (m.files.length ? h('div', { class: 'files' }, ...m.files.map(fileEl)) : null);

function copyText(text: string, btn: HTMLElement): void {
  void navigator.clipboard?.writeText(text).then(() => { btn.classList.add('on'); setTimeout(() => btn.classList.remove('on'), 1200); }, () => undefined);
}

function branchEl(m: ChatMessage): HTMLElement | null {
  const chat = state.current;
  if (!chat) return null;
  const sibs = siblingsOf(chat, m);
  if (sibs.length < 2) return null;
  const at = sibs.findIndex(s => s.id === m.id);
  const prev = iconButton('left', 'Previous version', () => void switchBranch(m, -1));
  const next = iconButton('right', 'Next version', () => void switchBranch(m, 1));
  prev.disabled = at <= 0 || !!state.streaming;
  next.disabled = at >= sibs.length - 1 || !!state.streaming;
  return h('span', { class: 'branch', 'aria-label': `Version ${at + 1} of ${sibs.length}` }, prev, `${at + 1}/${sibs.length}`, next);
}

function usageText(m: ChatMessage): string {
  const u = m.usage;
  if (!u) return '';
  return `${compact(u.inputTokens)} in, ${compact(u.outputTokens)} out${u.costUsd !== undefined ? `, $${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}` : ''}`;
}

function thinkEl(m: ChatMessage, isLive: boolean): HTMLDetailsElement | null {
  if (!m.reasoning) return null;
  const waiting = isLive && !m.text;
  const sum = h('span', { class: waiting ? 'shim' : '' }, waiting ? 'Thinking...' : 'Reasoning');
  const d = h('details', { class: 'think', open: waiting || state.prefs.openThinking }, h('summary', {}, icon('brain', 14), sum, icon('down', 14)), h('div', { class: 'tx' }, m.reasoning));
  return d;
}

function userMsg(m: ChatMessage, last: boolean): HTMLElement {
  const el = h('div', { class: 'msg user', dataset: { id: m.id } });
  el.append(...[filesEl(m)].filter((x): x is HTMLElement => !!x));
  if (editing === m.id) {
    const ta = h('textarea', { value: m.text, 'aria-label': 'Edit your message' });
    const save = h('button', { class: 'btn primary', type: 'button', on: { click: () => { const t = ta.value; editing = null; void editAndSend(m, t); } } }, 'Save and resend');
    const cancel = h('button', { class: 'btn', type: 'button', on: { click: () => { editing = null; renderThread(); } } }, 'Cancel');
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click(); if (e.key === 'Escape') cancel.click(); });
    el.append(h('div', { class: 'edit-box' }, ta, h('div', { class: 'row2' }, cancel, save)));
    queueMicrotask(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    return el;
  }
  if (m.text) el.append(h('div', { class: 'bubble' }, m.text));
  const copyBtn = iconButton('copy', 'Copy', e => copyText(m.text, e.currentTarget as HTMLElement));
  el.append(h('div', { class: 'meta' }, branchEl(m), h('span', { class: 'acts' }, copyBtn, state.streaming ? null : iconButton('edit', last ? 'Edit and resend' : 'Edit here and branch', () => { editing = m.id; renderThread(); }))));
  return el;
}

function assistantMsg(m: ChatMessage, user: ChatMessage | undefined, isLive: boolean): HTMLElement {
  const info = model(m.route), label = info?.label ?? m.route ?? 'Model';
  const body = h('div', { class: 'body md' });
  body.append(render(m.text));
  const think = thinkEl(m, isLive), el = h('div', { class: `msg assistant${isLive ? ' live' : ''}${m.state === 'stopped' ? ' stopped' : ''}`, dataset: { id: m.id } });
  const sumEl = think?.querySelector<HTMLElement>('summary span') ?? null;
  el.append(h('div', { class: 'who' }, h('span', { class: 'av', style: { background: hueOf(m.route ?? label) } }, initialOf({ label })), h('b', {}, label), m.state === 'stopped' ? 'stopped' : null));
  if (think) el.append(think);
  const files = filesEl(m);
  if (files) el.append(files);
  el.append(body);
  if (m.state === 'error' && m.error) el.append(h('div', { class: 'err' }, icon('warn', 15), m.error));
  if (!isLive) {
    const served = m.served ? Object.entries(m.served).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
    const copyBtn = iconButton('copy', 'Copy reply', e => copyText(m.text, e.currentTarget as HTMLElement));
    const again = user ? iconButton('retry', 'Write this again', () => void regenerate(user)) : null;
    const other = user ? iconButton('branch', 'Write this again with another model', e => openModelPicker(e.currentTarget as HTMLElement, { title: 'Write this again with', ...(m.route ? { current: m.route } : {}), onPick: r => void regenerate(user, r), up: true })) : null;
    el.append(h('div', { class: 'meta' }, branchEl(m), h('span', { class: 'acts' }, copyBtn, state.streaming ? null : again, state.streaming ? null : other),
      usageText(m) ? h('span', { 'data-tip': served || 'Tokens used by this reply' }, usageText(m)) : null));
  }
  if (isLive) live = { id: m.id, body, think, sum: sumEl, raf: 0 };
  return el;
}

function emptyState(): HTMLElement {
  const tier = activeTier(), el = h('div', { class: 'empty' }, h('div', { class: 'halo', 'aria-hidden': 'true' }), h('h1', {}, EMPTY.title), h('p', {}, state.models.length ? EMPTY.lead : EMPTY.noModels));
  if (state.models.length) {
    const cards = h('div', { class: 'cards' });
    const sorted = [...state.models].sort((a, b) => Number(fits(b, tier)) - Number(fits(a, tier)));
    for (const m of sorted.slice(0, 8)) {
      const ok = fits(m, tier), cur = m.route === state.draft.route;
      cards.append(h('button', { class: `mcard${cur ? ' on' : ''}`, type: 'button', disabled: !ok, title: ok ? '' : (m.why ?? 'Not cleared for this chat\'s data level'), on: { click: () => void setRoute(m.route) } },
        h('b', {}, h('span', { class: 'av', style: { width: '10px', height: '10px', borderRadius: '50%', background: hueOf(m.route), display: 'inline-block' } }), m.label), h('small', {}, m.model), modelBadges(m)));
    }
    el.append(cards);
  }
  el.append(h('div', { class: 'keys' }, EMPTY.hints));
  return el;
}

let scroller: HTMLElement, col: HTMLElement, jump: HTMLElement;

export function renderThread(): void {
  live = null;
  const chat = state.current;
  if (!chat) { replace(col, emptyState()); return; }
  const path = pathOf(chat), nodes: HTMLElement[] = [];
  path.forEach((m, i) => {
    if (m.role === 'user') nodes.push(userMsg(m, i >= path.length - 2));
    else nodes.push(assistantMsg(m, path[i - 1]?.role === 'user' ? path[i - 1] : undefined, state.streaming?.assistant === m.id && m.state === 'streaming'));
  });
  replace(col, ...nodes);
  if (stuck) scrollEnd(false);
}

function scrollEnd(smooth: boolean): void { scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }

/** Redraws just the message being written. */
export function renderStream(): void {
  const chat = state.current, run = state.streaming;
  if (!chat || !run || !live) return;
  const l = live;
  if (l.raf) return;
  l.raf = requestAnimationFrame(() => {
    l.raf = 0;
    const m = chat.tree.find(x => x.id === l.id);
    if (!m || live !== l) return;
    clear(l.body);
    l.body.append(render(m.text));
    if (m.reasoning) {
      if (!l.think) { renderThread(); return; }
      const tx = l.think.querySelector('.tx');
      if (tx) tx.textContent = m.reasoning;
      if (m.text && l.sum) {
        const secs = run.thinkEndedAt ? Math.max(1, Math.round((run.thinkEndedAt - run.startedAt) / 1000)) : 0;
        l.sum.className = '';
        l.sum.textContent = secs ? `Thought for ${secs}s` : 'Reasoning';
        if (!state.prefs.openThinking) l.think.open = false;
      }
    }
    if (stuck) scrollEnd(false);
  });
}

export function mountThread(host: HTMLElement): void {
  col = h('div', { class: 'col' });
  scroller = h('div', { class: 'thread', role: 'log', 'aria-live': 'off', 'aria-label': 'Conversation' }, col);
  jump = h('button', { class: 'chip jump', type: 'button', hidden: true, on: { click: () => { stuck = true; scrollEnd(true); } } }, icon('down', 14), 'Latest');
  scroller.addEventListener('scroll', () => {
    stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
    jump.hidden = stuck || !state.streaming;
  }, { passive: true });
  host.append(scroller, jump);
  renderThread();
}

export const stickToBottom = (): void => { stuck = true; };
export const scrollToEnd = (): void => scrollEnd(true);
export function editLast(): boolean {
  const chat = state.current;
  if (!chat || state.streaming) return false;
  const last = [...pathOf(chat)].reverse().find(m => m.role === 'user');
  if (!last) return false;
  editing = last.id;
  renderThread();
  return true;
}
