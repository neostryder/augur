// A small terminal for tests: it applies the escape sequences the painter writes to a grid of cells, recording each cell's character
// and the SGR sequence active when it was written, so a test can compare what a real terminal would show with the frame.
import { clusterWidth, graphemes } from '../src/width.js';

export class Vt {
  chars: string[][];
  sgrs: string[][];
  x = 0;
  y = 0;
  sgr = '\x1b[0m';
  cursorShown = true;
  modes = new Set<string>();

  constructor(readonly width: number, readonly height: number) {
    this.chars = Array.from({ length: height }, () => new Array<string>(width).fill(' '));
    this.sgrs = Array.from({ length: height }, () => new Array<string>(width).fill('\x1b[0m'));
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      if (data[i] === '\x1b') {
        const m = /^\x1b\[(\??)([0-9;]*)([A-Za-z])/.exec(data.slice(i));
        if (!m) throw new Error(`Unknown escape at ${JSON.stringify(data.slice(i, i + 12))}`);
        this.control(m[1]!, m[2]!, m[3]!, m[0]);
        i += m[0].length;
        continue;
      }
      let end = data.indexOf('\x1b', i);
      if (end < 0) end = data.length;
      for (const g of graphemes(data.slice(i, end))) this.print(g);
      i = end;
    }
  }

  private control(priv: string, params: string, fin: string, seq: string): void {
    if (priv) {
      if (fin === 'h') this.modes.add(params); else if (fin === 'l') this.modes.delete(params);
      if (params === '25') this.cursorShown = fin === 'h';
      return;
    }
    if (fin === 'H') { const [r, c] = params.split(';').map(Number); this.y = (r || 1) - 1; this.x = (c || 1) - 1; return; }
    if (fin === 'J' && params === '2') { for (const row of this.chars) row.fill(' '); for (const row of this.sgrs) row.fill('\x1b[0m'); return; }
    if (fin === 'm') { this.sgr = seq; return; }
    throw new Error(`Unhandled sequence ${JSON.stringify(seq)}`);
  }

  private print(g: string): void {
    const w = clusterWidth(g);
    if (w === 0) throw new Error(`Zero-width text written: ${JSON.stringify(g)}`);
    if (this.x + w > this.width || this.y >= this.height) throw new Error(`Text written past the edge at ${this.x},${this.y}: ${JSON.stringify(g)}`);
    const row = this.chars[this.y]!, sg = this.sgrs[this.y]!;
    if (row[this.x] === '' && this.x > 0) row[this.x - 1] = ' ';
    if (this.x + w < this.width && row[this.x + w] === '') row[this.x + w] = ' ';
    row[this.x] = g; sg[this.x] = this.sgr;
    if (w === 2) { row[this.x + 1] = ''; sg[this.x + 1] = this.sgr; }
    this.x += w;
  }

  row(y: number): string {
    return this.chars[y]!.join('');
  }
}
