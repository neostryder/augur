import { describe, expect, it } from 'vitest';
import { clusterWidth, fit, graphemes, textWidth, truncate, wrap } from '../src/width.js';
import { ASCII, Screen, UNICODE, glyphsFor } from '../src/screen.js';
import { colorDepth, merge, sgr, styleId, styleOf, to16, to256 } from '../src/style.js';

describe('text width', () => {
  it('counts cells for ASCII, wide characters, emoji, combining marks and controls', () => {
    expect(textWidth('Codex 5h')).toBe(8);
    expect(textWidth('日本')).toBe(4);
    expect(textWidth('é')).toBe(1);
    expect(textWidth('\u{1f44d}')).toBe(2);
    expect(textWidth('\u{1f468}‍\u{1f469}‍\u{1f467}')).toBe(2);
    expect(textWidth('\u{1f1fa}\u{1f1f8}')).toBe(2);
    expect(textWidth('❤')).toBe(1);
    expect(textWidth('❤️')).toBe(2);
    expect(textWidth('a\x1bb')).toBe(2);
    expect(clusterWidth('')).toBe(0);
    expect(graphemes('éx')).toEqual(['é', 'x']);
  });

  it('cuts and pads to a width', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
    expect(truncate('hello world', 8, '…')).toBe('hello w…');
    expect(truncate('short', 8)).toBe('short');
    expect(truncate('日本語', 5)).toBe('日...');
    expect(truncate('anything', 2)).toBe('..');
    expect(fit('ab', 5, 'right')).toBe('   ab');
    expect(fit('ab', 5, 'center')).toBe(' ab  ');
    expect(fit('abcdefgh', 5)).toBe('ab...');
  });

  it('wraps at spaces, splits only words longer than a line, and keeps newlines', () => {
    expect(wrap('the quick brown fox', 9)).toEqual(['the quick', 'brown fox']);
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap('one\n\ntwo', 10)).toEqual(['one', '', 'two']);
    expect(wrap('日本語日', 5)).toEqual(['日本', '語日']);
    expect(wrap('x', 0)).toEqual([]);
  });
});

describe('styles', () => {
  it('reads the color depth from the environment', () => {
    expect(colorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }, 'linux')).toBe('none');
    expect(colorDepth({ TERM: 'dumb' }, 'linux')).toBe('none');
    expect(colorDepth({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, 'linux')).toBe('truecolor');
    expect(colorDepth({ TERM: 'xterm-256color' }, 'darwin')).toBe('256');
    expect(colorDepth({ TERM: 'linux' }, 'linux')).toBe('16');
    expect(colorDepth({}, 'linux')).toBe('none');
    expect(colorDepth({}, 'win32')).toBe('truecolor');
  });

  it('writes SGR for each depth', () => {
    const s = { fg: '#ff8000' as const, bg: 4, bold: true };
    expect(sgr(s, 'truecolor')).toBe('\x1b[0;1;38;2;255;128;0;44m');
    expect(sgr(s, '256')).toBe('\x1b[0;1;38;5;208;44m');
    expect(sgr(s, '16')).toBe('\x1b[0;1;33;44m');
    expect(sgr(s, 'none')).toBe('\x1b[0;1m');
    expect(sgr({ fg: 12, inverse: true, underline: true }, '256')).toBe('\x1b[0;4;7;94m');
    expect(sgr({ fg: 200 }, '256')).toBe('\x1b[0;38;5;200m');
  });

  it('maps colors down to smaller palettes', () => {
    expect(to256('#000000')).toBe(16);
    expect(to256('#ffffff')).toBe(231);
    expect(to256('#808080')).toBe(244);
    expect(to16('#00cd00')).toBe(2);
    expect(to16(196)).toBe(9);
  });

  it('interns styles and merges them', () => {
    expect(styleId(undefined)).toBe(0);
    expect(styleId({ bold: false })).toBe(0);
    const id = styleId({ fg: 1, bold: true });
    expect(styleId({ bold: true, fg: 1 })).toBe(id);
    expect(styleOf(id)).toEqual({ fg: 1, bold: true });
    expect(merge({ fg: 1, bold: true }, { fg: 2, bg: undefined })).toEqual({ fg: 2, bold: true });
  });
});

describe('the screen', () => {
  it('clips text at the edge and at a maximum width', () => {
    const s = new Screen(10, 2);
    expect(s.put(6, 0, 'abcdef')).toBe(10);
    expect(s.row(0)).toBe('      abcd');
    expect(s.put(0, 1, 'abcdef', undefined, 3)).toBe(3);
    expect(s.row(1)).toBe('abc       ');
    expect(s.put(0, 5, 'off screen')).toBe(0);
    expect(s.put(-2, 1, 'xyz')).toBe(1);
    expect(s.row(1)).toBe('zbc       ');
  });

  it('keeps wide characters whole', () => {
    const s = new Screen(5, 1);
    s.put(0, 0, '日本語');
    expect(s.chars).toEqual(['日', '', '本', '', ' ']);
    s.put(1, 0, 'x');
    expect(s.chars.slice(0, 3)).toEqual([' ', 'x', '本']);
    s.put(2, 0, 'y');
    expect(s.chars.slice(0, 4)).toEqual([' ', 'x', 'y', ' ']);
    s.put(4, 0, '日');
    expect(s.chars[4]).toBe(' ');
  });

  it('drops control characters and turns tabs into spaces', () => {
    const s = new Screen(8, 1);
    s.put(0, 0, 'a\x1b[2Jb\tc');
    expect(s.row(0)).toBe('a[2Jb c ');
  });

  it('fills and restyles cells', () => {
    const s = new Screen(4, 2);
    s.put(0, 0, 'ab', { fg: 1 });
    s.fill(0, 1, 9, 9, { bg: 2 }, '.');
    expect(s.row(1)).toBe('....');
    s.restyle(0, 0, 2, { bold: true }, (old) => merge(old, { bold: true }));
    expect(s.cell(1, 0)).toEqual({ ch: 'b', style: { fg: 1, bold: true } });
    expect(s.text()).toBe('ab\n....');
  });

  it('picks ASCII glyphs only for a locale that is not UTF-8', () => {
    expect(glyphsFor({ LANG: 'en_US.UTF-8' }, 'linux')).toBe(UNICODE);
    expect(glyphsFor({ LANG: 'C' }, 'linux')).toBe(ASCII);
    expect(glyphsFor({ LC_ALL: 'POSIX', LANG: 'en_US.utf8' }, 'linux')).toBe(ASCII);
    expect(glyphsFor({}, 'linux')).toBe(UNICODE);
    expect(glyphsFor({ LANG: 'C' }, 'win32')).toBe(UNICODE);
  });
});
