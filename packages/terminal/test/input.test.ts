import { describe, expect, it } from 'vitest';
import { KeyParser } from '../src/input.js';

const labels = (data: string | string[], flush = false) => {
  const p = new KeyParser();
  const keys = (Array.isArray(data) ? data : [data]).flatMap((d) => p.feed(d));
  if (flush) keys.push(...p.flush());
  return keys.map((k) => k.label);
};

describe('reading keys', () => {
  it('reads text, control keys and Ctrl with a letter', () => {
    expect(labels('aA é\u{1f44d}')).toEqual(['a', 'A', ' ', 'é', '\u{1f44d}']);
    expect(labels('\r\n\t\x7f\b')).toEqual(['enter', 'enter', 'tab', 'backspace', 'backspace']);
    expect(labels('\x03\x01\x00\x1c')).toEqual(['ctrl+c', 'ctrl+a', 'ctrl+ ', 'ctrl+\\']);
  });

  it('reads cursor keys, function keys and their modifiers', () => {
    expect(labels('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F')).toEqual(['up', 'down', 'right', 'left', 'home', 'end']);
    expect(labels('\x1bOA\x1bOP\x1bOQ\x1bOR\x1bOS')).toEqual(['up', 'f1', 'f2', 'f3', 'f4']);
    expect(labels('\x1b[3~\x1b[5~\x1b[6~\x1b[2~\x1b[15~\x1b[24~\x1b[1~\x1b[4~')).toEqual(['delete', 'pageup', 'pagedown', 'insert', 'f5', 'f12', 'home', 'end']);
    expect(labels('\x1b[1;5C\x1b[1;3D\x1b[1;2A\x1b[5;5~\x1b[Z')).toEqual(['ctrl+right', 'alt+left', 'shift+up', 'ctrl+pageup', 'shift+tab']);
  });

  it('reads Escape followed by a key as that key with Alt', () => {
    expect(labels('\x1bx\x1b\x7f\x1b\r')).toEqual(['alt+x', 'alt+backspace', 'alt+enter']);
  });

  it('waits for the rest of a split sequence', () => {
    const p = new KeyParser();
    expect(p.feed('\x1b[')).toEqual([]);
    expect(p.pending()).toBe(true);
    expect(p.feed('1;5').map((k) => k.label)).toEqual([]);
    expect(p.feed('Ax').map((k) => k.label)).toEqual(['ctrl+up', 'x']);
    expect(p.pending()).toBe(false);
  });

  it('settles a lone Escape only when flushed', () => {
    const p = new KeyParser();
    expect(p.feed('\x1b')).toEqual([]);
    expect(p.flush().map((k) => k.label)).toEqual(['escape']);
    expect(labels('\x1b\x1b', true)).toEqual(['escape', 'escape']);
    expect(labels('\x1b[', true)).toEqual(['alt+[']);
  });

  it('reads a bracketed paste as one key, even split across reads', () => {
    const p = new KeyParser();
    const keys = [...p.feed('\x1b[200~line one\r\nline'), ...p.feed(' two\x1b[2'), ...p.feed('01~q')];
    expect(keys.map((k) => [k.label, k.text])).toEqual([['paste', 'line one\nline two'], ['q', 'q']]);
    expect(labels('\x1b[200~\x1b[A\x03\x1b[201~')).toEqual(['paste']);
  });

  it('skips sequences it does not know', () => {
    expect(labels('\x1b[?1;2c\x1b[12;40Rok')).toEqual(['o', 'k']);
  });
});
