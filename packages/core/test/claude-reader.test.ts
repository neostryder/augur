import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Host } from '../src/types.js';
import { claude } from '../src/providers/index.js';

const script = readFileSync(new URL('../../../apps/desktop/src-tauri/src/readers/claude.js', import.meta.url), 'utf8');

type Answer = { ok: boolean; body?: unknown };
/** Fakes window, document, location and fetch for the script, then collects the payload it would send to augur.invalid. */
async function read(answers: Record<string, Answer>, page: { hostname?: string; title?: string; challenge?: boolean } = {}): Promise<Record<string, unknown> | null> {
  let reported: Record<string, unknown> | null = null;
  const document = {
    title: page.title ?? 'Usage', readyState: 'complete',
    querySelector: (sel: string) => (page.challenge && sel.includes('cf-turnstile') ? {} : null),
  };
  const location = { hostname: page.hostname ?? 'claude.ai', set href(v: string) { reported = JSON.parse(decodeURIComponent(v.split('data=')[1]!)); } };
  const fetcher = async (url: string) => {
    const hit = answers[url.split('?')[0]!];
    return { ok: hit?.ok ?? false, json: async () => hit?.body };
  };
  const window = {} as { top?: unknown };
  window.top = window;
  new Function('window', 'document', 'location', 'fetch', script)(window, document, location, fetcher);
  await vi.advanceTimersByTimeAsync(26000);
  return reported;
}

const grant = { id: 'g1', label: 'Launch reset', resets_total: 1, resets_left: 1, ends_at: '2026-10-22T16:00:00+00:00', paused: false, usable_now: true, clears: ['five_hour', 'seven_day'], percent_used: { seven_day: 81 } };

describe('claude.ai reset reader', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reports the grants of every organization that can chat, and only the fields Augur uses', async () => {
    vi.useFakeTimers();
    const r = await read({
      '/api/organizations': { ok: true, body: [{ uuid: 'a-team', capabilities: ['raven', 'chat'] }, { uuid: 'b-api', capabilities: ['api'] }] },
      '/api/organizations/a-team/usage': { ok: true, body: { cedar_ember: { eligible: true, grants: [grant] } } },
      '/api/organizations/b-api/usage': { ok: true, body: { cedar_ember: { grants: [{ ...grant, id: 'never-read' }] } } },
    });
    expect(r).toEqual({ signedIn: true, grants: [{ id: 'g1', label: 'Launch reset', resetsLeft: 1, resetsTotal: 1, endsAt: '2026-10-22T16:00:00+00:00', paused: false, usableNow: true, clears: ['five_hour', 'seven_day'] }] });
  });

  it('reports no grants for an account that has none, and skips an organization whose usage call fails', async () => {
    vi.useFakeTimers();
    const r = await read({
      '/api/organizations': { ok: true, body: [{ uuid: 'a', capabilities: ['chat'] }, { uuid: 'b', capabilities: ['chat'] }] },
      '/api/organizations/a/usage': { ok: false },
      '/api/organizations/b/usage': { ok: true, body: { cedar_ember: null } },
    });
    expect(r).toEqual({ signedIn: true, grants: [] });
  });

  it('says signed out when the organizations call is refused or the page is not claude.ai, and a challenge when Cloudflare holds the page', async () => {
    vi.useFakeTimers();
    expect(await read({ '/api/organizations': { ok: false } })).toEqual({ signedIn: false, reason: 'signin' });
    expect(await read({}, { hostname: 'accounts.google.com' })).toEqual({ signedIn: false, reason: 'signin' });
    expect(await read({}, { title: 'Just a moment...', challenge: true })).toEqual({ signedIn: false, reason: 'challenge' });
  });
});

describe('Claude limit resets', () => {
  const now = new Date('2026-09-30T18:00:00Z');
  const session = (web: Record<string, unknown> | null | 'fail') => {
    const host: Host = {
      platform: 'windows', now: () => now, secret: async () => null,
      readHomeFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'test-only', expiresAt: now.getTime() + 9999999 } }),
      http: async () => ({ status: 200, headers: {}, body: JSON.stringify({ limits: [] }) }),
      webSession: async () => { if (web === 'fail') throw new Error('no window'); return web; },
    };
    return host;
  };
  const notes = async (host: Host, settings: Record<string, string | boolean | undefined>) => (await claude.fetch(host, settings)).notes as Record<string, unknown>;
  const row = (over: Record<string, unknown>) => ({ ...{ id: 'g', resetsLeft: 1, resetsTotal: 1, endsAt: '2026-10-22T16:00:00Z', paused: false, usableNow: true, clears: [] }, ...over });

  it('counts the resets still usable from the claude.ai reading and says when the first ends', async () => {
    const n = await notes(session({ signedIn: true, grants: [row({}), row({ id: 'h', resetsLeft: 2, endsAt: '2026-10-10T00:00:00Z' }), row({ id: 'old', endsAt: '2026-09-01T00:00:00Z' }), row({ id: 'paused', paused: true }), row({ id: 'used', resetsLeft: 0 })] }), { web: true });
    expect(n.resets_available).toBe(3);
    expect(n.resetsEndsAt).toBe('2026-10-10T00:00:00.000Z');
    expect(n.webSessions).toEqual({ claude: true });
  });

  it('uses the entered count when the reading is off, signed out or fails, and says what is missing', async () => {
    expect((await notes(session({ signedIn: true, grants: [row({})] }), { resets: '2' })).resets_available).toBe(2);
    const out = await notes(session({ signedIn: false, reason: 'signin' }), { web: true, resets: '1' });
    expect(out).toMatchObject({ resets_available: 1, resetsSignIn: true });
    expect(await notes(session({ signedIn: false, reason: 'challenge' }), { web: true })).toMatchObject({ resetsChallenge: true });
    expect((await notes(session('fail'), { web: true, resets: '1' })).resets_available).toBe(1);
    expect((await notes(session(null), { web: true })).resets_available).toBeUndefined();
  });
});
