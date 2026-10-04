// How many terminal cells text takes. Text is split into grapheme clusters (what a reader sees as one character), and each cluster is
// zero, one or two cells wide: East Asian wide characters and emoji take two, combining marks and control characters take none.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

// Code point ranges that terminals draw two cells wide, sorted for a binary search.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f1e6, 0x1f1ff],
  [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function isWide(cp: number): boolean {
  let lo = 0, hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [a, b] = WIDE[mid]!;
    if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return true;
  }
  return false;
}

/** Cells one code point takes on its own. */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (ZERO.test(String.fromCodePoint(cp))) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Cells one grapheme cluster takes. An emoji asked for in its picture form (U+FE0F) is wide even when its base code point is not. */
export function clusterWidth(cluster: string): 0 | 1 | 2 {
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;
  const w = codePointWidth(first);
  if (w === 1 && cluster.includes('️') && PICTOGRAPH.test(cluster)) return 2;
  return w;
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

export function textWidth(text: string): number {
  // Plain ASCII is the common case and needs no segmenting.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let w = 0;
  for (const g of graphemes(text)) w += clusterWidth(g);
  return w;
}

/** Cuts text to at most `width` cells, ending with `ellipsis` when anything was cut. */
export function truncate(text: string, width: number, ellipsis = '...'): string {
  if (width <= 0) return '';
  if (textWidth(text) <= width) return text;
  const room = width - textWidth(ellipsis);
  if (room < 0) return truncate(ellipsis, width, '');
  let out = '', w = 0;
  for (const g of graphemes(text)) {
    const cw = clusterWidth(g);
    if (w + cw > room) break;
    out += g; w += cw;
  }
  return out + ellipsis;
}

/** Pads text with spaces to exactly `width` cells, cutting it first when it is longer. */
export function fit(text: string, width: number, align: 'left' | 'right' | 'center' = 'left', ellipsis = '...'): string {
  const cut = truncate(text, width, ellipsis), pad = width - textWidth(cut);
  if (pad <= 0) return cut;
  if (align === 'right') return ' '.repeat(pad) + cut;
  if (align === 'center') return ' '.repeat(pad >> 1) + cut + ' '.repeat(pad - (pad >> 1));
  return cut + ' '.repeat(pad);
}

/** Breaks text into lines of at most `width` cells at spaces, splitting a word only when it is longer than a line. Newlines are kept. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '', lw = 0;
    for (const word of para.split(/ +/).filter(Boolean)) {
      let ww = textWidth(word);
      if (lw && lw + 1 + ww <= width) { line += ' ' + word; lw += 1 + ww; continue; }
      if (lw) { lines.push(line); line = ''; lw = 0; }
      let rest = word;
      while (ww > width) {
        let head = '', hw = 0;
        const parts = graphemes(rest);
        let i = 0;
        for (; i < parts.length; i++) {
          const cw = clusterWidth(parts[i]!);
          if (hw + cw > width) break;
          head += parts[i]; hw += cw;
        }
        if (!head) { head = parts[0]!; i = 1; }
        lines.push(head);
        rest = parts.slice(i).join(''); ww = textWidth(rest);
      }
      line = rest; lw = ww;
    }
    lines.push(line);
  }
  return lines;
}
