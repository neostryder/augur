import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Key } from '../src/input.js';
import { Terminal, type App, type TerminalIo } from '../src/terminal.js';
import type { Screen } from '../src/screen.js';

function fakeIo(columns = 30, rows = 6) {
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: false, setRawMode(on: boolean) { input.raw = on; return input; } });
  let written = '';
  const output = Object.assign(new Writable({ write(chunk, _enc, cb) { written += String(chunk); cb(); } }), { columns, rows });
  const io: TerminalIo = { input, output: output as unknown as TerminalIo['output'], env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, platform: 'linux' };
  return { io, input, output, take: () => { const w = written; written = ''; return w; } };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

class Counter implements App {
  n = 0;
  keys: Key[] = [];
  draw(s: Screen) { s.put(0, 0, `count ${this.n}`); }
  key(k: Key) {
    this.keys.push(k);
    if (k.label === '+') this.n++;
    if (k.label === 'q') return 'quit' as const;
    return undefined;
  }
}

describe('the terminal runtime', () => {
  it('enters raw mode and the alternate screen, draws after each key, and restores everything on quit', async () => {
    const f = fakeIo(), app = new Counter(), t = new Terminal(f.io);
    const running = t.run(app);
    await settle();
    expect(f.input.raw).toBe(true);
    const first = f.take();
    expect(first.startsWith('\x1b[?1049h')).toBe(true);
    expect(first).toContain('count 0');
    f.input.write('++');
    await settle();
    expect(f.take()).toContain('2');
    f.input.write('q');
    await running;
    expect(f.take()).toContain('\x1b[?1049l');
    expect(f.input.raw).toBe(false);
    expect(app.keys.map((k) => k.label)).toEqual(['+', '+', 'q']);
  });

  it('quits on Ctrl+C unless the app takes it', async () => {
    const f = fakeIo(), t = new Terminal(f.io);
    const running = t.run(new Counter());
    await settle();
    f.input.write('\x03');
    await expect(running).resolves.toBeUndefined();

    const g = fakeIo(), keeper: App = { draw() {}, key: (k) => k.label === 'ctrl+c' };
    const t2 = new Terminal(g.io), r2 = t2.run(keeper);
    await settle();
    g.input.write('\x03');
    await settle();
    t2.quit();
    await r2;
  });

  it('hands over a lone Escape after a short wait', async () => {
    const f = fakeIo(), app = new Counter(), t = new Terminal(f.io);
    const running = t.run(app);
    await settle();
    f.input.write('\x1b');
    await new Promise((r) => setTimeout(r, 60));
    expect(app.keys.map((k) => k.label)).toEqual(['escape']);
    f.input.write('q');
    await running;
  });

  it('repaints in full on resize', async () => {
    const f = fakeIo(), t = new Terminal(f.io);
    const running = t.run(new Counter());
    await settle();
    f.take();
    f.output.columns = 40;
    (f.output as unknown as EventEmitter).emit('resize');
    await settle();
    const out = f.take();
    expect(out).toContain('\x1b[2J');
    expect(out).toContain('count 0');
    f.input.write('q');
    await running;
  });

  it('restores the terminal and rejects when the app throws', async () => {
    const f = fakeIo(), t = new Terminal(f.io);
    let fail = false;
    const app: App = { draw: () => { if (fail) throw new Error('draw broke'); }, key: () => { fail = true; } };
    const running = t.run(app);
    await settle();
    f.input.write('x');
    await expect(running).rejects.toThrow('draw broke');
    expect(f.input.raw).toBe(false);
    expect(f.take()).toContain('\x1b[?1049l');
  });

  it('runs keys in order even when a handler waits', async () => {
    const f = fakeIo(), seen: string[] = [], t = new Terminal(f.io);
    const app: App = {
      draw() {},
      async key(k) {
        if (k.label === 'a') await new Promise((r) => setTimeout(r, 30));
        seen.push(k.label);
        return k.label === 'q' ? 'quit' : undefined;
      },
    };
    const running = t.run(app);
    await settle();
    f.input.write('abq');
    await running;
    expect(seen).toEqual(['a', 'b', 'q']);
  });
});
