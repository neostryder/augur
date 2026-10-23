// The command palette (Ctrl or Cmd + K): every action, every saved chat, and every model, behind one search box.
import { clear, h, icon } from './dom';
import { closePop } from './picker';
import { openDrawer } from './drawer';
import { activeRoute, model, newChat, openChat, setPrefs, setRoute, state, emit } from './state';

interface Cmd { id: string; icon: string; label: string; hint?: string; kb?: string; run(): void }

const THEMES = ['system', 'light', 'dark'] as const;

function commands(toggleSide: () => void): Cmd[] {
  const out: Cmd[] = [
    { id: 'new', icon: 'plus', label: 'New chat', kb: 'Ctrl+Shift+O', run: () => newChat() },
    { id: 'temp', icon: 'ghost', label: 'New temporary chat', hint: 'Kept in memory only', run: () => newChat({ temporary: true }) },
    { id: 'settings', icon: 'sliders', label: 'Model settings for this chat', run: openDrawer },
    { id: 'side', icon: 'menu', label: 'Show or hide the chat list', kb: 'Ctrl+B', run: toggleSide },
    { id: 'theme', icon: 'auto', label: 'Change the theme', hint: `Now ${state.prefs.theme}`, run: () => setPrefs({ theme: THEMES[(THEMES.indexOf(state.prefs.theme) + 1) % THEMES.length]! }) },
    { id: 'compact', icon: 'sliders', label: state.prefs.compact ? 'Use roomy spacing' : 'Use compact spacing', run: () => setPrefs({ compact: !state.prefs.compact }) },
    { id: 'usage', icon: 'info', label: 'Open usage and settings', run: () => { location.href = '../'; } },
  ];
  for (const m of state.models) out.push({ id: `m:${m.route}`, icon: m.local ? 'home' : 'cloud', label: `Use ${m.label}`, hint: m.model, run: () => void setRoute(m.route) });
  for (const c of state.chats.slice(0, 30)) out.push({ id: `c:${c.id}`, icon: c.temporary ? 'ghost' : 'file', label: c.title, hint: model(c.route)?.label ?? c.route, run: () => void openChat(c.id) });
  return out;
}

let host: HTMLElement | null = null;

export function closePalette(): void { host?.remove(); host = null; document.querySelector('.scrim.pal')?.remove(); state.paletteOpen = false; emit('overlay'); }

export function openPalette(toggleSide: () => void): void {
  if (host) { closePalette(); return; }
  closePop();
  state.paletteOpen = true;
  const all = commands(toggleSide), current = activeRoute();
  let at = 0, shown: Cmd[] = all;
  const input = h('input', { type: 'search', placeholder: 'Type a command, a chat, or a model', 'aria-label': 'Command palette', autocomplete: 'off' });
  const list = h('div', { class: 'list', role: 'listbox' });
  const draw = (): void => {
    clear(list);
    const q = input.value.trim().toLowerCase();
    shown = all.filter(c => !q || `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q)).slice(0, 40);
    at = Math.min(at, Math.max(0, shown.length - 1));
    if (!shown.length) { list.append(h('p', { class: 'empty-list' }, 'Nothing matches that.')); return; }
    shown.forEach((c, i) => list.append(h('button', { class: `opt${i === at ? ' cur' : ''}`, type: 'button', role: 'option', 'aria-selected': i === at, on: { click: () => run(c), pointermove: () => { if (at !== i) { at = i; draw(); } } } },
      h('span', { style: 'color:var(--muted);margin-top:2px' }, icon(c.icon, 16)),
      h('span', { class: 'tx' }, h('b', {}, c.label), c.hint ? h('small', {}, c.hint) : null),
      c.id === `m:${current}` ? h('span', { class: 'tick' }, icon('check', 16)) : null,
      c.kb ? h('span', { class: 'kb' }, c.kb) : null)));
    list.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (c: Cmd): void => { closePalette(); c.run(); };
  input.addEventListener('input', () => { at = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); at = (at + 1) % Math.max(1, shown.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); at = (at - 1 + shown.length) % Math.max(1, shown.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = shown[at]; if (c) run(c); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  host = h('div', { class: 'pop palette', role: 'dialog', 'aria-label': 'Command palette' }, h('div', { class: 'search' }, input), list);
  document.body.append(h('div', { class: 'scrim dim pal', on: { pointerdown: closePalette } }), host);
  draw();
  input.focus();
}
