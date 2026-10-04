// What every page of the terminal app is given and what it provides.
import type { EngineState } from '@augur/core';
import type { Key, Rect, Screen } from '@augur/terminal';
import type { Link } from './link.js';
import type { Theme } from './theme.js';

export interface Ctx {
  link: Link;
  state: EngineState;
  theme: Theme;
  now: number;
  redraw(): void;
  /** A short message in the footer that fades after a few seconds. */
  flash(text: string, bad?: boolean): void;
  overlay(o: Overlay | null): void;
  open(url: string): void;
  /** Runs an engine command and shows its error in the footer when it fails. Resolves to undefined after a failure. */
  run<T = unknown>(method: string, ...args: unknown[]): Promise<T | undefined>;
}

/** A key and what it does, for the footer and the help page. */
export type Hint = readonly [key: string, label: string];

export interface Page {
  name: string;
  /** Extra text after the tab's name, such as a count. */
  badge?(ctx: Ctx): string;
  draw(screen: Screen, r: Rect, ctx: Ctx): void;
  /** Returns true when the page used the key. */
  key(key: Key, ctx: Ctx): boolean | Promise<boolean>;
  hints(ctx: Ctx): Hint[];
  /** True while a text field has focus, so letters and digits go to it rather than to the app's own keys. */
  typing?(): boolean;
}

/** A panel drawn over the page, such as help or a chart. Escape closes it unless its key handler takes Escape itself. */
export interface Overlay {
  draw(screen: Screen, ctx: Ctx): void;
  key?(key: Key, ctx: Ctx): boolean | Promise<boolean>;
  hints?(ctx: Ctx): Hint[];
}
