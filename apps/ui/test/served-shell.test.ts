import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServedShell } from '../src/shells/served';

const TOKEN = 'f'.repeat(64);
afterEach(() => { vi.unstubAllGlobals(); });

/** Page globals the served shell touches: the address, its history, local storage and a document that only listens. */
function page(hash = '', saved = '') {
  const store = new Map<string, string>(saved ? [['augur.webToken', saved]] : []);
  const replaced: string[] = [];
  vi.stubGlobal('location', { hash, pathname: '/', search: '' });
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); } });
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  vi.stubGlobal('document', { addEventListener: () => undefined });
  return { store, replaced };
}

/** A response whose body the test feeds line by line and can end. */
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const enc = new TextEncoder();
  return { body, push: (m: unknown) => controller.enqueue(enc.encode(JSON.stringify(m) + '\n')), end: () => controller.close(), fail: () => controller.error(new Error('aborted')) };
}

describe('the served shell', () => {
  it('keeps the token from the link, removes it from the address, and sends it only as a header', async () => {
    const { store, replaced } = page(`#token=${TOKEN}`);
    const s = stream(), seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url === '/api/watch') return new Response(s.body, { status: 200 });
      return Response.json({ result: 'dismissed' });
    });
    const shell = createServedShell();
    expect(shell.served).toBe(true);
    expect(shell.kind).toBe('desktop');
    expect(store.get('augur.webToken')).toBe(TOKEN);
    expect(replaced).toEqual(['/']);
    const lines: Array<Record<string, unknown>> = [];
    const link = await shell.engineLink!((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
    expect(seen[0]!.url).toBe('/api/watch');
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    s.push({ t: 'ready', state: { config: {} } });
    await vi.waitFor(() => expect(lines).toContainEqual({ t: 'ready', state: { config: {} } }));
    await link.send(JSON.stringify({ t: 'call', id: 7, method: 'dismiss', args: [['a']] }));
    expect(seen[1]!.url).toBe('/api/call');
    expect(JSON.parse(seen[1]!.init.body as string)).toEqual({ method: 'dismiss', args: [['a']] });
    expect(lines).toContainEqual({ t: 'result', id: 7, result: 'dismissed' });
    s.end();
    await vi.waitFor(() => expect(lines).toContainEqual({ t: 'exit' }));
  });

  it('turns an error answer into a failed call, and a refused token into a cleared token and a restart', async () => {
    const { store } = page('', TOKEN);
    const s = stream();
    let callStatus = 400;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      // A real fetch ends its body when the page aborts it.
      if (url === '/api/watch') { init.signal?.addEventListener('abort', () => s.fail()); return new Response(s.body, { status: 200 }); }
      return callStatus === 401 ? new Response('{}', { status: 401 }) : Response.json({ error: 'Unknown engine command start' }, { status: 400 });
    });
    const lines: Array<Record<string, unknown>> = [];
    const link = await createServedShell().engineLink!((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
    await link.send(JSON.stringify({ t: 'call', id: 1, method: 'start', args: [] }));
    expect(lines).toContainEqual({ t: 'result', id: 1, error: 'Unknown engine command start' });
    callStatus = 401;
    await link.send(JSON.stringify({ t: 'call', id: 2, method: 'dismiss', args: [] }));
    expect(lines).toContainEqual({ t: 'result', id: 2, error: 'The web token was refused.' });
    expect(store.has('augur.webToken')).toBe(false);
    await vi.waitFor(() => expect(lines.filter((l) => l.t === 'exit')).toHaveLength(1));
  });

  it('says to wait when too many wrong tokens were tried', async () => {
    page('', TOKEN);
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }));
    await expect(createServedShell().engineLink!(() => undefined)).rejects.toThrow(/Too many wrong tokens/);
  });
});
