// The chat's state and everything that changes it. Views read `state` and listen with `on`; only the functions here write to it.
import type { ChatDetail, ChatEvent, ChatMessage, ChatModelInfo, ChatSummary } from '@augur/dispatch-protocol';
import type { DataTier } from '@augur/core';
import { api, send, Unauthorized } from './api';

export const TIERS: DataTier[] = ['public', 'internal', 'sensitive', 'regulated'];
export const tierRank = (t: DataTier): number => TIERS.indexOf(t);

export type Theme = 'system' | 'light' | 'dark';
export interface Prefs { theme: Theme; textSize: number; compact: boolean; motion: boolean; openThinking: boolean; lastRoute: string; lastTier: DataTier; sidebar: boolean }

const PREFS_KEY = 'augur.chat.prefs';
const DEFAULT_PREFS: Prefs = { theme: 'system', textSize: 1, compact: false, motion: true, openThinking: false, lastRoute: '', lastTier: 'internal', sidebar: true };

function loadPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) }; } catch { return { ...DEFAULT_PREFS }; }
}

/** What a chat that has not been created yet holds. The service makes the chat when the first message is sent. */
export interface Draft { route: string; tier: DataTier; temporary: boolean; system: string; settings: Record<string, unknown> }

export interface Streaming { chat: string; assistant: string; startedAt: number; thinkEndedAt: number | null; abort: AbortController }

export const state = {
  ready: false,
  needsToken: false,
  models: [] as ChatModelInfo[],
  chats: [] as Array<ChatSummary & { snippet?: string }>,
  query: '',
  current: null as ChatDetail | null,
  draft: { route: '', tier: 'internal', temporary: false, system: '', settings: {} } as Draft,
  streaming: null as Streaming | null,
  prefs: loadPrefs(),
  toast: null as { text: string; kind: 'info' | 'error'; id: number } | null,
  settingsOpen: false,
  pickerOpen: false,
  paletteOpen: false,
};

type Topic = 'all' | 'chats' | 'thread' | 'stream' | 'models' | 'prefs' | 'toast' | 'overlay';
const listeners = new Set<(topic: Topic) => void>();
export const on = (fn: (topic: Topic) => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const emit = (topic: Topic = 'all'): void => { for (const fn of listeners) fn(topic); };

// ---- small helpers the views share ----

export const model = (route: string | undefined): ChatModelInfo | undefined => state.models.find(m => m.route === route);
export const activeRoute = (): string => state.current?.route ?? state.draft.route;
export const activeTier = (): DataTier => state.current?.tier ?? state.draft.tier;
export const activeTemporary = (): boolean => state.current?.temporary ?? state.draft.temporary;
export const activeSettings = (): Record<string, unknown> => state.current?.settings ?? state.draft.settings;
export const activeSystem = (): string => state.current?.system ?? state.draft.system;

/** Whether a model can take a chat at `tier`: the rules allow it at all, and the most sensitive data it may see is at least this. */
export function fits(m: ChatModelInfo, tier: DataTier): boolean { return m.usable && m.tierMax !== null && tierRank(m.tierMax) >= tierRank(tier); }

export function pathOf(chat: ChatDetail): ChatMessage[] {
  const byId = new Map(chat.tree.map(m => [m.id, m]));
  const out: ChatMessage[] = [];
  for (let id = chat.head; id;) { const m = byId.get(id); if (!m) break; out.unshift(m); id = m.parent; }
  return out;
}

export function siblingsOf(chat: ChatDetail, m: ChatMessage): ChatMessage[] {
  return chat.tree.filter(x => x.parent === m.parent && x.role === m.role).sort((a, b) => a.at - b.at);
}

/** The newest message at the end of the branch that starts at `id`. */
export function leafOf(chat: ChatDetail, id: string): string {
  let at = id;
  for (;;) {
    const kids = chat.tree.filter(m => m.parent === at).sort((a, b) => b.at - a.at);
    if (!kids[0]) return at;
    at = kids[0].id;
  }
}

let toastId = 0;
export function notify(text: string, kind: 'info' | 'error' = 'info'): void {
  const id = ++toastId;
  state.toast = { text, kind, id };
  emit('toast');
  setTimeout(() => { if (state.toast?.id === id) { state.toast = null; emit('toast'); } }, kind === 'error' ? 7000 : 3200);
}

function failed(e: unknown): void {
  if (e instanceof Unauthorized) { state.needsToken = true; emit('all'); return; }
  notify(e instanceof Error ? e.message : String(e), 'error');
}

// ---- prefs ----

export function setPrefs(patch: Partial<Prefs>): void {
  state.prefs = { ...state.prefs, ...patch };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); if (patch.theme) localStorage.setItem('augur.chat.theme', patch.theme); } catch { /* blocked storage: the choice lasts until the page closes */ }
  applyPrefs();
  emit('prefs');
}

export function applyPrefs(): void {
  const root = document.documentElement, p = state.prefs;
  if (p.theme === 'system') delete root.dataset.theme; else root.dataset.theme = p.theme;
  root.style.setProperty('--fs', String(p.textSize));
  root.dataset.density = p.compact ? 'compact' : 'cozy';
  root.dataset.motion = p.motion ? 'on' : 'off';
}

// ---- loading ----

export async function loadModels(): Promise<void> {
  try { state.models = await api.models(); } catch (e) { failed(e); return; }
  if (!state.draft.route || !model(state.draft.route)) {
    const pick = model(state.prefs.lastRoute) && fits(model(state.prefs.lastRoute)!, state.draft.tier) ? state.prefs.lastRoute : state.models.find(m => fits(m, state.draft.tier))?.route ?? state.models[0]?.route ?? '';
    state.draft.route = pick;
  }
  emit('models');
}

export async function loadChats(): Promise<void> {
  try { state.chats = await api.chats(state.query.trim()); emit('chats'); } catch (e) { failed(e); }
}

export async function start(): Promise<void> {
  state.draft.tier = state.prefs.lastTier;
  await Promise.all([loadModels(), loadChats()]);
  state.ready = true;
  emit('all');
}

export async function openChat(id: string): Promise<void> {
  if (state.streaming && state.streaming.chat !== id) stop();
  try { state.current = await api.chat(id); } catch (e) { failed(e); return; }
  location.hash = `#${id}`;
  emit('all');
}

export function newChat(opts: { temporary?: boolean } = {}): void {
  if (state.streaming) stop();
  state.current = null;
  state.draft = { route: state.draft.route || state.prefs.lastRoute, tier: state.prefs.lastTier, temporary: !!opts.temporary, system: '', settings: {} };
  history.replaceState(null, '', location.pathname + location.search);
  emit('all');
}

function summaryOf(c: ChatDetail): ChatSummary {
  return { id: c.id, title: c.title, route: c.route, tier: c.tier, pinned: c.pinned, temporary: c.temporary, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: c.tree.length, preview: c.preview };
}

function touchList(c: ChatDetail): void {
  const sum = summaryOf(c), i = state.chats.findIndex(x => x.id === c.id);
  if (i >= 0) state.chats[i] = { ...state.chats[i]!, ...sum, updatedAt: Date.now() }; else if (!state.query) state.chats.unshift(sum);
  state.chats.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  emit('chats');
}

// ---- changing the chat ----

let settingsTimer: ReturnType<typeof setTimeout> | undefined;
export function setSettings(next: Record<string, unknown>): void {
  if (!state.current) { state.draft.settings = next; emit('overlay'); return; }
  state.current.settings = next;
  clearTimeout(settingsTimer);
  const id = state.current.id;
  settingsTimer = setTimeout(() => { void api.update(id, { settings: next }).catch(failed); }, 350);
  emit('overlay');
}

export async function setSystem(text: string): Promise<void> {
  if (!state.current) { state.draft.system = text; return; }
  state.current.system = text;
  try { await api.update(state.current.id, { system: text }); } catch (e) { failed(e); }
}

export async function setRoute(route: string): Promise<void> {
  const m = model(route);
  if (!m) return;
  setPrefs({ lastRoute: route });
  if (!state.current) { state.draft.route = route; state.draft.settings = {}; emit('all'); return; }
  try { await api.update(state.current.id, { route }); state.current.route = route; touchList(state.current); emit('all'); } catch (e) { failed(e); }
}

export async function setTier(tier: DataTier): Promise<void> {
  setPrefs({ lastTier: tier });
  if (!state.current) {
    state.draft.tier = tier;
    const m = model(state.draft.route);
    if (!m || !fits(m, tier)) { const alt = state.models.find(x => fits(x, tier)); if (alt) state.draft.route = alt.route; }
    emit('all');
    return;
  }
  try { await api.update(state.current.id, { tier }); state.current.tier = tier; emit('all'); } catch (e) { failed(e); }
}

export async function rename(title: string): Promise<void> {
  if (!state.current || !title.trim()) return;
  try { await api.update(state.current.id, { title: title.trim() }); state.current.title = title.trim().slice(0, 80); touchList(state.current); emit('all'); } catch (e) { failed(e); }
}

export async function pin(id: string, pinned: boolean): Promise<void> {
  try { await api.update(id, { pinned }); } catch (e) { failed(e); return; }
  if (state.current?.id === id) state.current.pinned = pinned;
  const c = state.chats.find(x => x.id === id);
  if (c) c.pinned = pinned;
  state.chats.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  emit('chats');
}

export async function remove(id: string): Promise<void> {
  try { await api.remove(id); } catch (e) { failed(e); return; }
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.current?.id === id) newChat();
  emit('all');
}

export async function switchBranch(m: ChatMessage, delta: number): Promise<void> {
  const chat = state.current;
  if (!chat || state.streaming) return;
  const sibs = siblingsOf(chat, m), at = sibs.findIndex(s => s.id === m.id), to = sibs[at + delta];
  if (!to) return;
  const head = leafOf(chat, to.id);
  chat.head = head;
  emit('thread');
  try { await api.update(chat.id, { head }); } catch (e) { failed(e); }
}

// ---- sending ----

export interface SendOptions { text: string; files?: File[]; parent?: string | null; retry?: string; route?: string }

function applyEvent(chat: ChatDetail, ev: ChatEvent, run: Streaming): void {
  const find = (id: string): ChatMessage | undefined => chat.tree.find(m => m.id === id);
  switch (ev.t) {
    case 'start':
      if (!find(ev.user.id)) chat.tree.push(ev.user);
      chat.tree.push(ev.assistant);
      chat.head = ev.assistant.id;
      run.assistant = ev.assistant.id;
      emit('thread');
      break;
    case 'delta': { const m = find(run.assistant); if (m) { m.text += ev.text; if (!run.thinkEndedAt && m.reasoning) run.thinkEndedAt = Date.now(); } emit('stream'); break; }
    case 'think': { const m = find(run.assistant); if (m) m.reasoning = (m.reasoning ?? '') + ev.text; emit('stream'); break; }
    case 'usage': { const m = find(run.assistant); if (m) m.usage = ev.usage; break; }
    case 'title': chat.title = ev.title; touchList(chat); emit('all'); break;
    case 'done': { const i = chat.tree.findIndex(m => m.id === ev.message.id); if (i >= 0) chat.tree[i] = ev.message; emit('thread'); break; }
    case 'error': notify(ev.message, 'error'); break;
    case 'file': { const m = find(run.assistant); if (m) m.files = [...m.files, ev.file]; emit('thread'); break; }
  }
}

export async function sendMessage(opts: SendOptions): Promise<boolean> {
  if (state.streaming) return false;
  let chat = state.current;
  try {
    if (!chat) {
      const d = state.draft, made = await api.create({ route: d.route, tier: d.tier, temporary: d.temporary, ...(d.system ? { system: d.system } : {}), ...(Object.keys(d.settings).length ? { settings: d.settings } : {}) });
      chat = await api.chat(made.id);
      state.current = chat;
      location.hash = `#${chat.id}`;
      touchList(chat);
      emit('all');
    }
    const ids: string[] = [];
    for (const f of opts.files ?? []) ids.push((await api.upload(chat.id, f)).id);
    const run: Streaming = { chat: chat.id, assistant: '', startedAt: Date.now(), thinkEndedAt: null, abort: new AbortController() };
    state.streaming = run;
    emit('all');
    const target = chat;
    try {
      await send({ chat: chat.id, text: opts.text, ...(ids.length ? { files: ids } : {}), ...(opts.parent !== undefined ? { parent: opts.parent } : {}), ...(opts.retry ? { retry: opts.retry } : {}), ...(opts.route ? { route: opts.route } : {}) },
        ev => { if (state.current?.id === target.id) applyEvent(target, ev, run); }, run.abort.signal);
    } catch (e) { if ((e as Error).name !== 'AbortError') failed(e); }
    state.streaming = null;
    if (state.current?.id === target.id) { try { const fresh = await api.chat(target.id); if (state.current?.id === target.id) state.current = fresh; } catch { /* the local copy stands */ } touchList(state.current ?? target); }
    emit('all');
    return true;
  } catch (e) { state.streaming = null; failed(e); emit('all'); return false; }
}

export function stop(): void {
  const run = state.streaming;
  if (!run) return;
  void api.stop(run.chat).catch(() => undefined);
  run.abort.abort();
}

export const regenerate = (user: ChatMessage, route?: string): Promise<boolean> => sendMessage({ text: '', retry: user.id, ...(route ? { route } : {}) });
export const editAndSend = (m: ChatMessage, text: string): Promise<boolean> => sendMessage({ text, parent: m.parent });
