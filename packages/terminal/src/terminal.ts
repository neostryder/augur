// Runs a full-screen app in the terminal: switches to the alternate screen, reads keys in raw mode, draws a frame after each key or when
// the app asks, repaints in full on resize, and puts the terminal back as it was however the app ends (quit, a signal, or an error).
import { KeyParser, type Key } from './input.js';
import { paint } from './paint.js';
import { Screen, glyphsFor, type Glyphs } from './screen.js';
import { colorDepth, type ColorDepth } from './style.js';

export interface App {
  draw(screen: Screen): void;
  /** Handles a key. Returning 'quit' ends the app. Ctrl+C quits when the app does not handle it. */
  key(key: Key): 'quit' | boolean | void | Promise<'quit' | boolean | void>;
}

/** The streams the app runs on. Tests pass fakes; the real ones are process.stdin and process.stdout. */
export interface TerminalIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(on: boolean): unknown };
  output: NodeJS.WritableStream & { columns?: number; rows?: number; on(event: 'resize', fn: () => void): unknown; off(event: 'resize', fn: () => void): unknown };
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J';
const LEAVE = '\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l';
const ESC_WAIT_MS = 25;

export class Terminal {
  readonly depth: ColorDepth;
  readonly glyphs: Glyphs;
  private readonly parser = new KeyParser();
  private prev: Screen | null = null;
  private app: App | null = null;
  private queued = false;
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private done: (() => void) | null = null;
  private fail: ((e: unknown) => void) | null = null;
  private keys: Promise<void> = Promise.resolve();
  private active = false;

  constructor(private readonly io: TerminalIo = { input: process.stdin, output: process.stdout, env: process.env }) {
    this.depth = colorDepth(io.env, io.platform);
    this.glyphs = glyphsFor(io.env, io.platform);
  }

  get width(): number { return this.io.output.columns || 80; }
  get height(): number { return this.io.output.rows || 24; }

  /** Runs the app until it quits. Resolves after the terminal is restored; rejects with an error the app threw, also after restoring. */
  run(app: App): Promise<void> {
    this.app = app;
    return new Promise<void>((resolve, reject) => {
      this.done = resolve; this.fail = reject;
      this.enter();
      this.redraw();
    });
  }

  /** Asks for a frame. Several requests before the next turn of the event loop draw once. */
  redraw(): void {
    if (this.queued || !this.active) return;
    this.queued = true;
    setImmediate(() => { this.queued = false; this.frame(); });
  }

  /** Ends the app from outside, as when the data it shows has gone. */
  quit(): void {
    this.leave();
    const done = this.done;
    this.done = null; this.fail = null;
    done?.();
  }

  /** Gives the terminal back while `fn` runs, as when an editor opens a file, then takes it again and draws the whole screen. */
  async pause<T>(fn: () => T | Promise<T>): Promise<T> {
    const was = this.active;
    this.leave();
    try { return await fn(); } finally {
      if (was && this.app && this.done) { this.enter(); this.redraw(); }
    }
  }

  /** Puts text on the clipboard through the terminal's own clipboard sequence (OSC 52), which most current terminals honor, over SSH too. */
  copy(text: string): void {
    if (this.active) this.io.output.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  }

  private frame(): void {
    if (!this.active || !this.app) return;
    try {
      const screen = new Screen(this.width, this.height, this.glyphs);
      this.app.draw(screen);
      const out = paint(this.prev, screen, this.depth);
      if (out) this.io.output.write(out);
      this.prev = screen;
    } catch (e) { this.crash(e); }
  }

  private readonly onData = (chunk: Buffer | string) => {
    if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = null; }
    this.dispatch(this.parser.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    if (this.parser.pending()) this.escTimer = setTimeout(() => { this.escTimer = null; this.dispatch(this.parser.flush()); }, ESC_WAIT_MS);
  };

  private readonly onResize = () => { this.prev = null; this.redraw(); };

  private readonly onSignal = (signal: NodeJS.Signals) => {
    this.leave();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  // A crash elsewhere in the process still gets the terminal back.
  private readonly onExit = () => this.leave();

  private readonly onCont = () => { if (this.app && !this.active) { this.enter(); this.redraw(); } };

  private dispatch(keys: Key[]): void {
    // Keys run one after another, so a key whose handler waits on the service never overtakes the one before it.
    for (const key of keys) {
      this.keys = this.keys.then(async () => {
        if (!this.active || !this.app) return;
        if (key.label === 'ctrl+z' && (this.io.platform ?? process.platform) !== 'win32' && this.io.input === process.stdin) { this.suspend(); return; }
        const r = await this.app.key(key);
        if (r === 'quit' || (key.label === 'ctrl+c' && r !== true)) { this.quit(); return; }
        this.redraw();
      }).catch((e: unknown) => this.crash(e));
    }
  }

  private suspend(): void {
    this.leave();
    process.once('SIGCONT', this.onCont);
    process.kill(process.pid, 'SIGTSTP');
  }

  private crash(e: unknown): void {
    this.leave();
    const fail = this.fail;
    this.done = null; this.fail = null;
    fail?.(e);
  }

  private enter(): void {
    if (this.active) return;
    this.active = true;
    this.prev = null;
    const { input, output } = this.io;
    if (input.isTTY && input.setRawMode) input.setRawMode(true);
    input.on('data', this.onData);
    input.resume();
    output.on('resize', this.onResize);
    process.on('exit', this.onExit);
    if (this.io.input === process.stdin) for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(s, this.onSignal);
    output.write(ENTER);
  }

  private leave(): void {
    if (!this.active) return;
    this.active = false;
    if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = null; }
    const { input, output } = this.io;
    output.write(LEAVE);
    input.off('data', this.onData);
    output.off('resize', this.onResize);
    if (input.isTTY && input.setRawMode) input.setRawMode(false);
    input.pause();
    process.off('exit', this.onExit);
    for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.off(s, this.onSignal);
  }
}
