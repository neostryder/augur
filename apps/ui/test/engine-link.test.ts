import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Shell } from '@augur/core';
import { LINK_TEXT, connectEngine } from '../src/engine-link';

afterEach(() => { vi.useRealTimers(); });

/** A desktop shell whose engine link is driven by the test: `emit` plays a bridge line, `sent` holds what the page wrote. */
function fakeShell() {
  const sent: Array<Record<string, unknown>> = [], notices: string[][] = [];
  let emit: (m: unknown) => void = () => {};
  let starts = 0;
  const shell = {
    kind: 'desktop',
    host: { platform: 'linux', webSession: async (site: string) => ({ site }) },
    notify: async (title: string, body: string) => { notices.push([title, body]); },
    async engineLink(onLine: (line: string) => void) {
      starts++;
      emit = (m) => onLine(JSON.stringify(m));
      return { send: async (line: string) => { sent.push(JSON.parse(line) as Record<string, unknown>); } };
    },
  } as unknown as Shell;
  return { shell, sent, notices, emit: (m: unknown) => emit(m), starts: () => starts };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the engine link', () => {
  it('waits for the whole state, then carries commands, changes and requests', async () => {
    const f = fakeShell(), downs: Array<string | null> = [];
    const connecting = connectEngine(f.shell, (m) => downs.push(m));
    await tick();
    f.emit({ t: 'down', message: 'starting' });
    f.emit({ t: 'ready', state: { busy: false, firstRun: true } });
    const api = await connecting;
    expect(api.state.firstRun).toBe(true);
    expect(downs).toEqual(['starting', null]);

    const changed: string[][] = [];
    api.onChange((keys) => changed.push(keys));
    f.emit({ t: 'change', keys: ['busy'], state: { busy: true } });
    expect(api.state.busy).toBe(true);
    expect(changed).toEqual([['busy']]);

    const refreshed = api.refresh(true);
    await tick();
    expect(f.sent.at(-1)).toEqual({ t: 'call', id: 1, method: 'refresh', args: [true] });
    f.emit({ t: 'result', id: 1, result: null });
    await expect(refreshed).resolves.toBeNull();

    const failed = api.pair();
    await tick();
    f.emit({ t: 'result', id: 2, error: 'No relay' });
    await expect(failed).rejects.toThrow('No relay');

    f.emit({ t: 'request', rid: 'r1', method: 'notify', params: { title: 'Codex', body: '80% used' } });
    f.emit({ t: 'request', rid: 'r2', method: 'webSession', params: { site: 'jev' } });
    f.emit({ t: 'request', rid: 'r3', method: 'format', params: {} });
    await tick(); await tick();
    expect(f.notices).toEqual([['Codex', '80% used']]);
    expect(f.sent.filter((m) => m.t === 'reply').sort((a, b) => String(a.rid).localeCompare(String(b.rid)))).toEqual([
      { t: 'reply', rid: 'r1', result: null },
      { t: 'reply', rid: 'r2', result: { site: 'jev' } },
      { t: 'reply', rid: 'r3', error: 'This window does not answer format' },
    ]);
  });

  it('starts the bridge again when it ends, and hands the page the whole state once it is back', async () => {
    const f = fakeShell(), downs: Array<string | null> = [];
    const connecting = connectEngine(f.shell, (m) => downs.push(m));
    await tick();
    f.emit({ t: 'ready', state: { busy: false } });
    const api = await connecting;
    const changed: string[][] = [];
    api.onChange((keys) => changed.push(keys));
    const pending = api.refresh();
    await tick();
    vi.useFakeTimers();
    f.emit({ t: 'exit' });
    await expect(pending).rejects.toThrow(LINK_TEXT.restarting);
    expect(downs.at(-1)).toBe(LINK_TEXT.restarting);
    await expect(api.viewShown()).rejects.toThrow(LINK_TEXT.restarting);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.starts()).toBe(2);
    f.emit({ t: 'ready', state: { busy: true, firstRun: false } });
    expect(downs.at(-1)).toBeNull();
    expect(api.state).toEqual({ busy: true, firstRun: false });
    expect(changed).toEqual([['busy', 'firstRun']]);
  });

  it('refuses a shell with no engine link', async () => {
    await expect(connectEngine({ kind: 'desktop' } as unknown as Shell, () => {})).rejects.toThrow(LINK_TEXT.noLink);
  });
});
