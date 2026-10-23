// The chat's calls to the service. The web token stays in this browser and travels in the Authorization header, never in an address.
import type { ChatDetail, ChatEvent, ChatFileRef, ChatModelInfo, ChatSendParams, ChatSummary } from '@augur/dispatch-protocol';
import type { DataTier } from '@augur/core';

const TOKEN_KEY = 'augur.webToken';

export class Unauthorized extends Error {}

let token = '';
const read = (): string => { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } };
export const hasToken = (): boolean => !!(token || read());
export function setToken(value: string): void { token = value; try { if (value) localStorage.setItem(TOKEN_KEY, value); else localStorage.removeItem(TOKEN_KEY); } catch { /* the token is asked for again next visit */ } }

/** A link such as `/chat/#token=...` carries the token once. It is stored and the fragment is removed from the address bar. */
export function takeTokenFromAddress(): void {
  const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  setToken(decodeURIComponent(m[1]!).trim());
}

const root = (): string => new URL('../api/chat/', location.href).toString();
const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${token || read()}`, ...extra });

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(root() + path, { ...init, headers: { ...headers(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) } });
  if (res.status === 401 || res.status === 403) throw new Unauthorized('The token was not accepted.');
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? (text || `HTTP ${res.status}`));
  return body as T;
}

export const api = {
  models: async (): Promise<ChatModelInfo[]> => (await call<{ models: ChatModelInfo[] }>('models')).models,
  chats: async (q = ''): Promise<Array<ChatSummary & { snippet?: string }>> => (await call<{ chats: Array<ChatSummary & { snippet?: string }> }>(q ? `chats?q=${encodeURIComponent(q)}` : 'chats')).chats,
  chat: (id: string): Promise<ChatDetail> => call<ChatDetail>(`chats/${encodeURIComponent(id)}`),
  create: (input: { route: string; tier?: DataTier; temporary?: boolean; system?: string; settings?: Record<string, unknown> }): Promise<ChatSummary> => call<ChatSummary>('chats', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: { title?: string; route?: string; tier?: DataTier; pinned?: boolean; system?: string; settings?: Record<string, unknown>; head?: string | null }): Promise<ChatSummary> =>
    call<ChatSummary>(`chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string): Promise<{ removed: boolean }> => call(`chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  stop: (id: string): Promise<{ stopped: boolean }> => call(`chats/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' }),
  upload: (id: string, file: File): Promise<ChatFileRef> =>
    call<ChatFileRef>(`chats/${encodeURIComponent(id)}/files`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) } }),
  /** The address a file shows from. It needs the token, so it is fetched into a blob (see fileUrl). */
  filePath: (id: string): string => `files/${encodeURIComponent(id)}`,
};

const blobs = new Map<string, Promise<string>>();
/** A blob address for an attachment, fetched once with the token. */
export function fileUrl(id: string): Promise<string> {
  let hit = blobs.get(id);
  if (!hit) {
    hit = fetch(root() + api.filePath(id), { headers: headers() }).then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return URL.createObjectURL(await r.blob()); });
    blobs.set(id, hit);
    hit.catch(() => blobs.delete(id));
  }
  return hit;
}

/** Sends a message and reads the reply as it is written. Resolves when the stream ends; `signal` stops reading, and the service stops writing. */
export async function send(params: ChatSendParams, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(root() + 'send', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(params), signal });
  if (res.status === 401 || res.status === 403) throw new Unauthorized('The token was not accepted.');
  if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { onEvent(JSON.parse(line) as ChatEvent); } catch { /* a partial or foreign line */ } }
    }
  }
}
