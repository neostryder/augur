// The chat page: mounts the sidebar, header, thread and composer, and wires them to the shared state.
import './chat.css';
import { hasToken, setToken, takeTokenFromAddress } from './api';
import { MULTI_USER, TEMP_NOTE } from './copy';
import { openDrawer } from './drawer';
import { clear, h, icon, iconButton } from './dom';
import { mountComposer, renderComposer, focusComposer } from './composer';
import { openPalette } from './palette';
import { mountSidebar, renderList, renderSession } from './sidebar';
import { identify, type Session } from './session';
import { mountThread, renderStream, renderThread } from './thread';
import { installTips } from './tip';
import { activeRoute, activeTemporary, applyPrefs, emit, model, newChat, on, openChat, rename, setPrefs, start, state } from './state';

takeTokenFromAddress();
applyPrefs();
installTips();

/** A skin is a JSON object of CSS token names to values, kept in this browser. It is applied over the defaults. */
function applySkin(): void {
  try {
    const raw = localStorage.getItem('augur.chat.skin');
    if (!raw) return;
    const skin = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(skin)) if (/^--[a-z0-9-]+$/i.test(k) && typeof v === 'string') document.documentElement.style.setProperty(k, v);
  } catch { /* an unreadable skin is ignored */ }
}
applySkin();

const app = document.getElementById('chat')!;
clear(app);
const side = h('aside', { class: 'side', 'aria-label': 'Chats' });
const main = h('main', { class: 'main' });
const top = h('header', { class: 'top' });
const bannerHost = h('div');
const wrap = h('div', { class: 'thread-wrap' });
const composerHost = h('div', { class: 'composer' });
const toastHost = h('div', { 'aria-live': 'polite', role: 'status' });
main.append(top, bannerHost, wrap, composerHost);
app.append(side, main, toastHost);

const narrow = (): boolean => matchMedia('(max-width: 860px)').matches;
function toggleSide(): void {
  if (narrow()) { app.classList.toggle('side-open'); return; }
  setPrefs({ sidebar: !state.prefs.sidebar });
  app.classList.toggle('no-side', !state.prefs.sidebar);
}
app.classList.toggle('no-side', !state.prefs.sidebar);
app.addEventListener('pointerdown', e => { if (app.classList.contains('side-open') && !(e.target as HTMLElement).closest('.side, .menu-btn')) app.classList.remove('side-open'); });

function drawHeader(): void {
  clear(top);
  const chat = state.current, m = model(activeRoute());
  const title = h('input', { class: 'title', value: chat?.title ?? 'New chat', 'aria-label': 'Chat title', readOnly: !chat, spellcheck: false, maxLength: 80 });
  title.addEventListener('change', () => void rename(title.value));
  title.addEventListener('keydown', e => { if (e.key === 'Enter') title.blur(); if (e.key === 'Escape') { title.value = chat?.title ?? 'New chat'; title.blur(); } });
  top.append(
    iconButton('menu', 'Show or hide the chat list', toggleSide, 'menu-btn'),
    title,
    h('div', { class: 'tools' },
      iconButton('command', 'Command palette (Ctrl+K)', () => openPalette(toggleSide)),
      iconButton('sliders', m ? `${m.label} settings` : 'Model settings', openDrawer, state.settingsOpen ? 'on' : '')));
  main.classList.toggle('temp', activeTemporary());
  clear(bannerHost);
  if (activeTemporary()) bannerHost.append(h('div', { class: 'temp-banner' }, icon('ghost', 14), TEMP_NOTE));
}

function drawToast(): void {
  clear(toastHost);
  if (state.toast) toastHost.append(h('div', { class: `toast${state.toast.kind === 'error' ? ' error' : ''}`, role: state.toast.kind === 'error' ? 'alert' : 'status' }, state.toast.text));
}

let sessionScreen: Session['screen'] | 'loading' = 'loading';
let sessionMessage = '';
function drawGate(): void {
  document.querySelector('.gate')?.remove();
  if (state.needsToken) sessionScreen = 'gate';
  app.hidden = sessionScreen !== 'chat';
  app.inert = sessionScreen !== 'chat';
  if (sessionScreen === 'chat' || sessionScreen === 'loading') return;
  const title = h('h1', { tabIndex: -1 }, MULTI_USER.GATE.title);
  if (sessionScreen !== 'gate') {
    document.body.append(h('section', { class: 'gate', role: 'alert' }, title, h('p', {}, sessionMessage)));
    title.focus();
    return;
  }
  const input = h('input', { type: 'password', placeholder: MULTI_USER.GATE.token, 'aria-label': MULTI_USER.GATE.token, autocomplete: 'off' });
  const form = h('form', { class: 'gate', on: { submit: (e: Event) => { e.preventDefault(); if (!input.value.trim()) return; setToken(input.value.trim()); location.reload(); } } },
    title, h('p', {}, MULTI_USER.GATE.prompt), sessionMessage ? h('p', { role: 'alert' }, sessionMessage) : null, input, h('button', { class: 'btn primary', type: 'submit' }, MULTI_USER.GATE.open));
  document.body.append(form);
  input.focus();
}

on(topic => {
  switch (topic) {
    case 'stream': renderStream(); break;
    case 'chats': renderList(); break;
    case 'toast': drawToast(); break;
    case 'prefs': drawHeader(); renderThread(); break;
    case 'thread': renderThread(); renderComposer(); break;
    case 'overlay': drawHeader(); renderComposer(); break;
    case 'models': drawHeader(); renderThread(); renderComposer(); break;
    default: drawHeader(); renderList(); renderSession(); renderThread(); renderComposer(); drawGate(); break;
  }
});

async function boot(): Promise<void> {
  state.needsToken = false;
  sessionScreen = 'loading';
  drawGate();
  const session = await identify();
  sessionScreen = session.screen;
  sessionMessage = session.screen === 'chat' ? '' : session.screen === 'gate' && !hasToken() ? '' : session.message;
  state.identity = session.screen === 'chat' ? session.identity : null;
  state.needsToken = session.screen === 'gate';
  renderSession();
  drawGate();
  if (session.screen !== 'chat') return;
  await start();
  const id = location.hash.slice(1);
  if (id) void openChat(id);
  if (!state.needsToken) focusComposer();
}

mountSidebar(side);
mountThread(wrap);
mountComposer(composerHost);
drawHeader();
drawGate();

document.addEventListener('keydown', e => {
  if (!state.identity || state.needsToken || (e.target as HTMLElement).closest('.admin')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(toggleSide); }
  else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSide(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); focusComposer(); }
  else if (mod && e.key === ',') { e.preventDefault(); openDrawer(); }
});
addEventListener('hashchange', () => {
  if (location.hash.startsWith('#token=')) { takeTokenFromAddress(); location.reload(); return; }
  if (!state.identity || state.needsToken) return;
  const id = location.hash.slice(1);
  if (id && id !== state.current?.id) void openChat(id);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => emit('prefs'));

void boot();
