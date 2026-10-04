// A page the terminal app does not have yet. It points to the window app, which has it.
import { spans, wrap, type Rect, type Screen } from '@augur/terminal';
import type { Hint, Page } from '../page.js';

export class LaterPage implements Page {
  constructor(readonly name: string) {}

  draw(screen: Screen, r: Rect): void {
    wrap(`The ${this.name} page is not in the terminal app yet. The window app has it.`, r.w - 2).forEach((line, i) => spans(screen, r.x + 1, r.y + i, r.w - 2, line, { dim: true }));
  }

  key(): boolean { return false; }
  hints(): Hint[] { return []; }
}
