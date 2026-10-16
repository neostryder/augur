// The shell for the app when augurd serves it over the network. The page is a view of the engine, like the desktop panel: it holds no
// provider logins and reads no provider itself. State and changes arrive on one streamed response, and commands go back as plain POSTs.
// The token that opens the link is kept in this browser only, and travels in the Authorization header, never in an address.
import type { Shell } from '@augur/core';
import { createBrowserShell } from './browser';

const TOKEN_KEY = 'augur.webToken';

export const isServed = (): boolean => !!document.querySelector('meta[name="augur-served"]');

function savedToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
function saveToken(token: string): void {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* blocked storage: the token is asked for again next visit */ }
}

/** A link such as `http://host:7420/#token=...` carries the token once. It is stored and the fragment is removed from the address bar. */
function tokenFromAddress(): string {
  const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (!m) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]!).trim();
}

/** Asks for the web token in a small form over the page. Resolves with what was typed. */
function askToken(message: string): Promise<string> {
  return new Promise((resolve) => {
    const box = document.createElement('form');
    box.className = 'served-gate';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Sign in to Augur');
    box.style.cssText = 'position:fixed;inset:0;display:grid;place-content:center;gap:10px;padding:24px;background:var(--page,#fff);z-index:99;max-width:100%';
    const note = document.createElement('p');
    note.textContent = message;
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Web token';
    input.setAttribute('aria-label', 'Web token');
    const go = document.createElement('button');
    go.type = 'submit';
    go.className = 'btn';
    go.textContent = 'Open Augur';
    box.append(note, input, go);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      box.remove();
      resolve(value);
    });
    document.body.append(box);
    input.focus();
  });
}

class BadToken extends Error {}

/** Reads a streamed NDJSON body line by line. Returns when the stream ends. */
async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  }
}

export function createServedShell(): Shell {
  const base = createBrowserShell();
  let token = tokenFromAddress() || savedToken();
  if (token) saveToken(token);
  let stream: AbortController | null = null;

  const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
  const forgetToken = () => { token = ''; saveToken(''); };

  const open = async (onLine: (line: string) => void): Promise<{ send(line: string): Promise<void> }> => {
    const old = stream;
    stream = null;
    old?.abort();
    for (;;) {
      if (!token) { token = await askToken('Enter the web token for this Augur. Run "augur web" on the computer to see it.'); saveToken(token); }
      const ctrl = new AbortController();
      let res: Response;
      try { res = await fetch('/api/watch', { headers: headers(), signal: ctrl.signal, cache: 'no-store' }); }
      catch { throw new Error('Cannot reach Augur on this computer. Trying again.'); }
      if (res.status === 401) { forgetToken(); continue; }
      if (res.status === 429) throw new Error('Too many wrong tokens. Wait a minute, then try again.');
      if (!res.ok || !res.body) throw new Error(`Augur answered ${res.status}. Trying again.`);
      stream = ctrl;
      // The stream ending is a lost link; the engine link starts it again with a growing wait.
      void readLines(res.body, onLine).catch(() => undefined).finally(() => { if (stream === ctrl) onLine(JSON.stringify({ t: 'exit' })); });
      break;
    }
    return {
      async send(line: string) {
        const msg = JSON.parse(line) as { t: string; id?: number; method?: string; args?: unknown[] };
        if (msg.t !== 'call') return;
        const result = (body: Record<string, unknown>) => onLine(JSON.stringify({ t: 'result', id: msg.id, ...body }));
        try {
          const r = await fetch('/api/call', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ method: msg.method, args: msg.args ?? [] }), cache: 'no-store' });
          if (r.status === 401) { forgetToken(); result({ error: 'The web token was refused.' }); stream?.abort(); return; }
          const out = await r.json().catch(() => ({})) as { result?: unknown; error?: string };
          if (typeof out.error === 'string') result({ error: out.error }); else result({ result: out.result ?? null });
        } catch { result({ error: 'Cannot reach Augur on this computer.' }); }
      },
    };
  };

  return { ...base, kind: 'desktop', served: true, host: { ...base.host, platform: 'browser' }, engineLink: open };
}
