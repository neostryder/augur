import { describe, expect, it } from 'vitest';
import { alignmentPositions, blockLayout, dataCodewords, drawQr, formatBits, gfMul, qrEncode, qrRows, rawDataModules, versionBits, type Qr, type QrLevel } from '../src/qr.js';
import { Screen } from '../src/screen.js';

// Reads a code back using only the encoder's lookup tables, which the tests below pin to the standard's published values. The format
// bits come first, since they name the mask; then the data modules are read in zigzag order and each block's error correction is checked.
function read(qr: Qr): { level: QrLevel; mask: number; text: string } {
  const s = qr.size, m = qr.modules, ver = (s - 17) / 4;
  let fmt = 0;
  for (let i = 0; i <= 5; i++) fmt |= (m[i]![8] ? 1 : 0) << i;
  fmt |= (m[7]![8] ? 1 : 0) << 6; fmt |= (m[8]![8] ? 1 : 0) << 7; fmt |= (m[8]![7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) fmt |= (m[8]![14 - i] ? 1 : 0) << i;
  let fmt2 = 0;
  for (let i = 0; i < 8; i++) fmt2 |= (m[8]![s - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i++) fmt2 |= (m[s - 15 + i]![8] ? 1 : 0) << i;
  expect(fmt2).toBe(fmt);
  let found: [QrLevel, number] | null = null;
  for (const level of ['L', 'M', 'Q', 'H'] as const) for (let mask = 0; mask < 8; mask++) if (formatBits(level, mask) === fmt) found = [level, mask];
  expect(found).not.toBeNull();
  const [level, mask] = found!;

  const fn = Array.from({ length: s }, (_, y) => Array.from({ length: s }, (_, x) =>
    (x < 9 && y < 9) || (x >= s - 8 && y < 9) || (x < 9 && y >= s - 8) || x === 6 || y === 6
    || (ver >= 7 && ((x >= s - 11 && x < s - 8 && y < 6) || (y >= s - 11 && y < s - 8 && x < 6)))));
  const pos = alignmentPositions(ver), last = pos.length - 1;
  pos.forEach((ay, i) => pos.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fn[ay + dy]![ax + dx] = true;
  }));
  const masks = [
    (x: number, y: number) => (x + y) % 2 === 0, (_: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0, (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0, (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const bits: number[] = [];
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const up = ((right + 1) & 2) === 0;
    for (let v = 0; v < s; v++) for (const x of [right, right - 1]) {
      const y = up ? s - 1 - v : v;
      if (!fn[y]![x]) bits.push((m[y]![x] !== masks[mask]!(x, y)) ? 1 : 0);
    }
  }
  const total = Math.floor(rawDataModules(ver) / 8);
  expect(bits.length).toBe(rawDataModules(ver));
  const words = Array.from({ length: total }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));

  const { blocks, eccPerBlock } = blockLayout(ver, level);
  const shortCount = blocks - (total % blocks), shortLen = Math.floor(total / blocks);
  const lens = Array.from({ length: blocks }, (_, i) => shortLen + (i < shortCount ? 0 : 1));
  const dataLens = lens.map((l) => l - eccPerBlock);
  const split: number[][] = lens.map(() => []);
  let w = 0;
  for (let i = 0; i < Math.max(...dataLens); i++) for (let b = 0; b < blocks; b++) if (i < dataLens[b]!) split[b]!.push(words[w++]!);
  for (let i = 0; i < eccPerBlock; i++) for (let b = 0; b < blocks; b++) split[b]!.push(words[w++]!);
  expect(w).toBe(total);
  // A block is a valid Reed-Solomon codeword when the polynomial is zero at each of the first eccPerBlock powers of the generator.
  for (const block of split) {
    let root = 1;
    for (let i = 0; i < eccPerBlock; i++) {
      let acc = 0;
      for (const c of block) acc = gfMul(acc, root) ^ c;
      expect(acc).toBe(0);
      root = gfMul(root, 2);
    }
  }
  const data = split.flatMap((b, i) => b.slice(0, dataLens[i]));
  expect(data.length).toBe(dataCodewords(ver, level));
  const dbits = data.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
  let at = 0;
  const take = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dbits[at++]!; return v; };
  expect(take(4)).toBe(0b0100);
  const len = take(ver <= 9 ? 8 : 16);
  const bytes = Uint8Array.from({ length: len }, () => take(8));
  return { level, mask, text: new TextDecoder().decode(bytes) };
}

describe('the QR encoder', () => {
  it('matches the standard tables', () => {
    expect([dataCodewords(1, 'L'), dataCodewords(1, 'M'), dataCodewords(1, 'H'), dataCodewords(5, 'Q'), dataCodewords(40, 'L')]).toEqual([19, 16, 9, 62, 2956]);
    expect(rawDataModules(40)).toBe(29648);
    expect([blockLayout(5, 'Q'), blockLayout(7, 'L'), blockLayout(40, 'H')]).toEqual([{ blocks: 4, eccPerBlock: 18 }, { blocks: 2, eccPerBlock: 20 }, { blocks: 81, eccPerBlock: 30 }]);
    expect(formatBits('M', 0)).toBe(0x5412);
    expect(formatBits('L', 0)).toBe(0x77c4);
    expect(versionBits(7)).toBe(0x7c94);
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });

  const link = 'https://augur.rpgm.tools/#pair?r=https%3A%2F%2Faugur-relay.rpgm.tools&c=4f6c2a9e0b1d47e8a3c5&k=Jq3v9K2xT8mWn5RzLp0YhB7cDf4GsA1eUo6iXtVwNbQ';
  const cases: Array<[string, QrLevel]> = [['Augur', 'M'], ['HELLO WORLD', 'Q'], [link, 'L'], [link, 'H'], ['日本語 and emoji \u{1f44d}', 'M'], ['x'.repeat(1200), 'M']];
  for (const [text, level] of cases) {
    it(`encodes ${text.length} characters at level ${level} so a reader gets the text back`, () => {
      const qr = qrEncode(text, level);
      expect(qr.size).toBe(qr.version * 4 + 17);
      const got = read(qr);
      expect(got).toEqual({ level, mask: qr.mask, text });
    });
  }

  it('picks the smallest version that holds the text', () => {
    expect(qrEncode('a'.repeat(17), 'L').version).toBe(1);
    expect(qrEncode('a'.repeat(18), 'L').version).toBe(2);
    expect(qrEncode(link, 'L').version).toBe(7);
    expect(() => qrEncode('x'.repeat(3000), 'L')).toThrow(/too long/);
  });

  it('draws the code with half blocks inside a quiet zone, in black on white', () => {
    const qr = qrEncode('Augur', 'L');
    const r = qrRows(qr, 2);
    expect(r.length).toBe(Math.ceil((qr.size + 4) / 2));
    expect(r[0]).toBe(' '.repeat(qr.size + 4));
    expect(r[1]!.slice(2, 9)).toBe('█▀▀▀▀▀█');
    expect(qrRows(qr, 2, true)[0]).toBe('█'.repeat(qr.size + 4));
    const s = new Screen(40, 20);
    expect(drawQr(s, 1, 1, qr)).toEqual({ w: qr.size + 4, h: r.length });
    expect(s.cell(3, 2)).toEqual({ ch: '█', style: { fg: '#000000', bg: '#ffffff' } });
  });
});
