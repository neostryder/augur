import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../../../apps/desktop/src-tauri/src/readers/openai-usage.js', import.meta.url), 'utf8');
const endpoint = (kind: string, project = 'proj-1', range = 'week') => {
  const url = new URL('https://api.openai.com/v1/dashboard/organization/' + kind);
  url.search = new URLSearchParams({ bucket_width: '1d', start_time: range, end_time: 'end', ...(project ? { project_ids: project } : {}) }).toString();
  return url.href;
};
const start = Date.parse('2026-11-02T00:00:00Z') / 1000;
const buckets = (results: (day: number) => unknown[], length = 7) => ({ object: 'page', has_more: false, next_page: null,
  data: Array.from({ length }, (_, day) => ({ object: 'bucket', start_time: start + day * 86400, end_time: start + (day + 1) * 86400, results: results(day) })) });
const costs = buckets(day => day === 0 ? [] : [
  { amount: { currency: 'usd', value: day / 10 }, project_id: 'proj-1', project_name: 'Personal', line_item: 'discarded' },
  { amount: { currency: 'usd', value: 0.25 }, project_id: 'proj-1', project_name: 'Personal', unrelated: 'discarded' },
]);
const completions = buckets(day => day === 0 ? [] : [{ num_model_requests: day, input_tokens: day * 100, output_tokens: day * 10, input_cached_tokens: day * 20, unrelated: 'discarded' }]);
type Answer = { url: string; body: unknown; ok?: boolean; request?: boolean; afterMs?: number };

async function read(answers: Answer[] = [], page: { hostname?: string; pathname?: string; title?: string; text?: string; challenge?: boolean; all?: boolean; filters?: boolean; refresh?: boolean; icon?: boolean; adjacent?: boolean } = {}) {
  let reported: unknown = null, ready = () => {};
  const responses: Array<{ ok: boolean; clone: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }> = [];
  const fetcher = vi.fn(async () => responses.shift()!);
  const window = { fetch: fetcher } as { top?: unknown; fetch: (...args: unknown[]) => Promise<unknown> };
  window.top = window;
  const sendOne = async (answer: Answer) => {
    const response = { ok: answer.ok !== false, clone: vi.fn(() => ({ json: async () => answer.body })), json: vi.fn(() => { throw new Error('The page owns the response body'); }) };
    responses.push(response);
    const request = answer.request ? { url: answer.url, get headers() { throw new Error('The page owns its headers'); } } : answer.url;
    expect(await window.fetch(request)).toBe(response);
    expect(response.json).not.toHaveBeenCalled();
  };
  const send = async () => {
    for (const answer of answers) {
      if (answer.afterMs) setTimeout(() => { void sendOne(answer); }, answer.afterMs);
      else await sendOne(answer);
    }
  };
  const refresh = vi.fn(() => { void send(); });
  const chip = (innerText: string) => ({ innerText, getAttribute: () => null, closest: () => ({}) });
  const filters = [chip('All API sources'), chip('Data Analytics'), chip('All API keys'), chip('Last 7 days')];
  const project = { innerText: page.all ? 'All projects' : 'Personal', getAttribute: () => 'Project' };
  const button = { innerText: '', disabled: false, getAttribute: () => page.icon || page.adjacent ? null : 'Refresh',
    querySelector: (selector: string) => page.adjacent ? selector === 'svg' ? {} : null : page.icon ? {} : null, matches: (selector: string) => selector === 'button', click: refresh };
  const dateButton = { innerText: 'Last 7 days', getAttribute: () => 'Date range', querySelector: () => null, nextElementSibling: button };
  const document = { title: page.title ?? 'Usage', readyState: 'loading', body: { innerText: page.text ?? 'Usage' },
    querySelector: (selector: string) => page.challenge && selector.includes('cf-turnstile') ? {} : null,
    querySelectorAll: (selector: string) => selector === 'button' ? page.adjacent ? [dateButton, button] : [button] : page.filters ? filters : [project],
    addEventListener: (_event: string, callback: () => void) => { ready = callback; } };
  const location = { hostname: page.hostname ?? 'platform.openai.com', pathname: page.pathname ?? '/usage',
    set href(value: string) { reported = JSON.parse(decodeURIComponent(value.split('data=')[1]!)); } };
  new Function('window', 'document', 'location', 'URL', script)(window, document, location, URL);
  if (!page.refresh) await send();
  ready();
  await vi.advanceTimersByTimeAsync(26000);
  return { reported, fetcher, refresh };
}

describe('OpenAI project usage reader', () => {
  afterEach(() => vi.useRealTimers());

  it('captures the page responses before DOM ready and reports only daily spend, requests and tokens', async () => {
    vi.useFakeTimers();
    const out = await read([{ url: endpoint('costs'), body: costs, request: true }, { url: endpoint('usage/completions'), body: completions }]);
    expect(out.reported).toEqual({ signedIn: true, project: { name: 'Personal', id: 'proj-1', days: Array.from({ length: 7 }, (_, day) => ({
      start: new Date((start + day * 86400) * 1000).toISOString().slice(0, 10), spend: day === 0 ? 0 : day / 10 + 0.25, requests: day, tokens: day * 110,
    })) }, organization: { days: [] } });
    expect(out.fetcher).toHaveBeenCalledTimes(2);
    expect(out.refresh).not.toHaveBeenCalled();
  });

  it('keeps the organization total separate from the selected project', async () => {
    vi.useFakeTimers();
    const out = await read([{ url: endpoint('costs'), body: costs }, { url: endpoint('costs', ''), body: buckets(() => [{ amount: { currency: 'usd', value: 5 } }]), afterMs: 1800 },
      { url: endpoint('usage/completions'), body: completions }]);
    expect(out.reported).toMatchObject({ project: { id: 'proj-1', days: [{ spend: 0 }, { spend: 0.35 }, {}, {}, {}, {}, {}] },
      organization: { days: Array.from({ length: 7 }, () => ({ spend: 5 })) } });
  });

  it.each(['name', 'icon', 'adjacent'])('clicks the refresh button after six seconds when initial responses are absent (%s)', async (kind) => {
    vi.useFakeTimers();
    const out = await read([{ url: endpoint('costs'), body: costs }, { url: endpoint('usage/completions'), body: completions }], { refresh: true, icon: kind === 'icon', adjacent: kind === 'adjacent' });
    expect(out.refresh).toHaveBeenCalledTimes(1);
    expect(out.fetcher).toHaveBeenCalledTimes(2);
    expect(out.reported).toMatchObject({ signedIn: true, project: { id: 'proj-1' } });
  });

  it('names the project from the filter buttons when the cost rows carry no name, and reports quickly', async () => {
    vi.useFakeTimers();
    const unnamed = buckets(day => day === 0 ? [] : [{ amount: { currency: 'usd', value: 0.5 }, project_id: 'proj-1' }]);
    const out = await read([{ url: endpoint('costs'), body: unnamed }, { url: endpoint('usage/completions'), body: completions }], { filters: true });
    expect(out.reported).toMatchObject({ signedIn: true, project: { name: 'Data Analytics', id: 'proj-1' } });
  });

  it('reports no project when the selector says All projects', async () => {
    vi.useFakeTimers();
    const out = await read([{ url: endpoint('costs'), body: costs }, { url: endpoint('usage/completions'), body: completions },
      { url: endpoint('costs', ''), body: costs }], { all: true });
    expect(out.reported).toMatchObject({ signedIn: true, project: null, organization: { days: Array.from({ length: 7 }, () => ({})) } });
  });

  it('uses the billing reader sign-in and challenge outcomes', async () => {
    vi.useFakeTimers();
    for (const page of [{ hostname: 'auth.openai.com' }, { pathname: '/login' }, { text: 'Sign in to continue' }]) {
      expect((await read([], page)).reported).toEqual({ signedIn: false, reason: 'signin' });
    }
    expect((await read([], { title: 'Just a moment...', challenge: true })).reported).toEqual({ signedIn: false, reason: 'challenge' });
  });

  it('reports no project without matching completions and does not issue its own requests', async () => {
    vi.useFakeTimers();
    const out = await read([{ url: endpoint('costs'), body: costs }, { url: endpoint('usage/completions', 'proj-2'), body: completions },
      { url: endpoint('usage/completions', 'proj-1', 'other'), body: completions }]);
    expect(out.reported).toEqual({ signedIn: true, project: null, organization: { days: [] } });
    expect(out.refresh).toHaveBeenCalledTimes(1);
    expect(out.fetcher).toHaveBeenCalledTimes(6);
  });

  it('caps the report at 31 dates and discards foreign currency and invalid numbers', async () => {
    vi.useFakeTimers();
    const longCosts = buckets(day => [{ amount: { currency: day === 2 ? 'eur' : 'usd', value: day === 3 ? '2' : 1 }, project_name: 'Personal' }], 36);
    const out = await read([{ url: endpoint('costs'), body: longCosts }, { url: endpoint('usage/completions'), body: buckets(() => [{ num_model_requests: 1, input_tokens: 2, output_tokens: 3 }], 36) }]);
    const project = (out.reported as { project: { days: Array<{ start: string }> } }).project;
    expect(project.days).toHaveLength(31);
    expect(project.days[0]!.start).toBe('2026-11-07');
    const invalid = await read([{ url: endpoint('costs'), body: buckets(() => [{ amount: { currency: 'eur', value: 2 } }]) }, { url: endpoint('usage/completions'), body: completions }]);
    expect(invalid.reported).toMatchObject({ project: null });
  });
});
