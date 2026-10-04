// A QR code encoder for text (byte mode, versions 1 to 40, all four error correction levels), following ISO/IEC 18004. It picks the
// smallest version that holds the text and the mask with the lowest penalty. drawQr shows it with half blocks, two modules per cell.
import type { Screen } from './screen.js';
import type { Style } from './style.js';

export type QrLevel = 'L' | 'M' | 'Q' | 'H';

export interface Qr { version: number; size: number; level: QrLevel; mask: number; modules: boolean[][] }

const LEVEL_INDEX: Record<QrLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Error correction codewords per block, and the number of blocks, by level then version (index 0 unused).
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules left for data and error correction once the function patterns are placed. */
export function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const align = Math.floor(ver / 7) + 2; n -= (25 * align - 10) * align - 55; if (ver >= 7) n -= 36; }
  return n;
}

/** How the codewords split into blocks, each carrying the same number of error correction codewords. */
export function blockLayout(ver: number, level: QrLevel): { blocks: number; eccPerBlock: number } {
  const l = LEVEL_INDEX[level];
  return { blocks: BLOCKS[l]![ver]!, eccPerBlock: ECC_PER_BLOCK[l]![ver]! };
}

export function dataCodewords(ver: number, level: QrLevel): number {
  const l = LEVEL_INDEX[level];
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[l]![ver]! * BLOCKS[l]![ver]!;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// Arithmetic in GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
export function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree - 1).fill(0);
  out.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) { out[j] = gfMul(out[j]!, root); if (j + 1 < out.length) out[j]! ^= out[j + 1]!; }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    divisor.forEach((c, i) => { out[i]! ^= gfMul(c, factor); });
  }
  return out;
}

function encodeData(bytes: Uint8Array, ver: number, level: QrLevel): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver, level) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data: readonly number[], ver: number, level: QrLevel): number[] {
  const l = LEVEL_INDEX[level], blocks = BLOCKS[l]![ver]!, eccLen = ECC_PER_BLOCK[l]![ver]!;
  const raw = Math.floor(rawDataModules(ver) / 8), short = blocks - (raw % blocks), shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen), all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < short) dat.push(0);
    all.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < all[0]!.length; i++) all.forEach((b, j) => { if (i !== shortLen - eccLen || j >= short) out.push(b[i]!); });
  return out;
}

export function formatBits(level: QrLevel, mask: number): number {
  const data = (FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

export const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The data module order: two-column strips from the right edge, zigzagging up and down, skipping the vertical timing column. */
export function* zigzag(size: number, isFunction: boolean[][]): Generator<[number, number]> {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x]) yield [x, y];
      }
    }
  }
}

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  fn(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  functionPatterns(): void {
    const s = this.size;
    for (let i = 0; i < s; i++) { this.fn(6, i, i % 2 === 0); this.fn(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < s && y >= 0 && y < s) this.fn(x, y, d !== 2 && d !== 4);
      }
    }
    const pos = alignmentPositions(this.version), last = pos.length - 1;
    pos.forEach((ay, i) => pos.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.fn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    this.format('L', 0);
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1, a = s - 11 + (i % 3), b = Math.floor(i / 3);
        this.fn(a, b, dark); this.fn(b, a, dark);
      }
    }
  }

  format(level: QrLevel, mask: number): void {
    const bits = formatBits(level, mask), s = this.size, bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.fn(8, i, bit(i));
    this.fn(8, 7, bit(6)); this.fn(8, 8, bit(7)); this.fn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.fn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.fn(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.fn(8, s - 15 + i, bit(i));
    this.fn(8, s - 8, true);
  }

  codewords(data: readonly number[]): void {
    let i = 0;
    for (const [x, y] of zigzag(this.size, this.isFunction)) {
      if (i < data.length * 8) this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
      i++;
    }
  }

  applyMask(mask: number): void {
    const m = MASKS[mask]!;
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.isFunction[y]![x] && m(x, y)) this.modules[y]![x] = !this.modules[y]![x];
  }

  penalty(): number {
    const s = this.size, mod = this.modules;
    let score = 0, dark = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) { run++; continue; }
        if (run >= 5) score += run - 2;
        run = 1;
      }
      // A finder-like pattern, dark light dark dark dark light dark, with four light modules before or after it (outside counts as light).
      const at = (k: number) => k >= 0 && k < s && get(k);
      const light = (from: number) => !at(from) && !at(from + 1) && !at(from + 2) && !at(from + 3);
      for (let p = 0; p + 7 <= s; p++) {
        if (!(at(p) && !at(p + 1) && at(p + 2) && at(p + 3) && at(p + 4) && !at(p + 5) && at(p + 6))) continue;
        if (light(p - 4)) score += 40;
        if (light(p + 7)) score += 40;
      }
    };
    for (let y = 0; y < s; y++) line((x) => mod[y]![x]!);
    for (let x = 0; x < s; x++) line((y) => mod[y]![x]!);
    for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) {
      const c = mod[y]![x];
      if (c === mod[y]![x + 1] && c === mod[y + 1]![x] && c === mod[y + 1]![x + 1]) score += 3;
    }
    for (const row of mod) for (const m of row) if (m) dark++;
    const total = s * s;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** Encodes text as a QR code at the smallest version that holds it. Throws when it is too long for version 40 at this level. */
export function qrEncode(text: string, level: QrLevel = 'M', minVersion = 1): Qr {
  const bytes = new TextEncoder().encode(text);
  let ver = Math.max(1, minVersion);
  for (; ver <= 40; ver++) if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver, level) * 8) break;
  if (ver > 40) throw new Error('The text is too long for a QR code.');
  const codewords = interleave(encodeData(bytes, ver, level), ver, level);
  let best: Builder | null = null, bestMask = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const b = new Builder(ver);
    b.functionPatterns();
    b.codewords(codewords);
    b.applyMask(mask);
    b.format(level, mask);
    const score = b.penalty();
    if (score < bestScore) { best = b; bestMask = mask; bestScore = score; }
  }
  return { version: ver, size: best!.size, level, mask: bestMask, modules: best!.modules };
}

/**
 * The code as text rows, two modules per row with half blocks, inside a light border of `quiet` modules. `invert` swaps the blocks for
 * a terminal with a dark background and no color, so the light modules are the drawn ones.
 */
export function qrRows(qr: Qr, quiet = 2, invert = false): string[] {
  const n = qr.size + quiet * 2, dark = (x: number, y: number) => {
    const mx = x - quiet, my = y - quiet;
    const on = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my]![mx]!;
    return invert ? !on : on;
  };
  const rows: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let row = '';
    for (let x = 0; x < n; x++) {
      const top = dark(x, y), bottom = y + 1 < n && dark(x, y + 1);
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    rows.push(row);
  }
  return rows;
}

/** Draws the code at (x, y) in black on white, so it scans whatever the terminal's theme is. Returns the cells it covers. */
export function drawQr(screen: Screen, x: number, y: number, qr: Qr, quiet = 2): { w: number; h: number } {
  const style: Style = { fg: '#000000', bg: '#ffffff' }, rows = qrRows(qr, quiet);
  rows.forEach((row, i) => screen.put(x, y + i, row, style));
  return { w: qr.size + quiet * 2, h: rows.length };
}
