// Reads what the terminal sends in raw mode and turns it into key presses. Escape sequences can arrive split across reads, so an
// unfinished one waits for the rest; a lone Escape is only an Escape once nothing follows it for a moment (the caller calls flush()).
// Pasted text arrives in one piece when the terminal brackets pastes (mode 2004).

export interface Key {
  /** 'char' for text, 'paste' for pasted text, or a named key: enter, tab, backspace, escape, up, down, left, right, home, end,
   * pageup, pagedown, insert, delete, f1 to f12. */
  name: string;
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The key as one string, for a switch: 'a', 'A', 'ctrl+c', 'alt+x', 'shift+tab', 'ctrl+up', 'enter', 'paste'. */
  label: string;
}

export function makeKey(name: string, mods: { text?: string; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): Key {
  const ctrl = !!mods.ctrl, alt = !!mods.alt, shift = !!mods.shift;
  const base = name === 'char' ? (ctrl ? mods.text!.toLowerCase() : mods.text!) : name;
  const label = [ctrl && 'ctrl', alt && 'alt', shift && name !== 'char' && 'shift', base].filter(Boolean).join('+');
  return { name, ...(mods.text !== undefined ? { text: mods.text } : {}), ctrl, alt, shift, label };
}

const TILDE: Record<number, string> = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
};
const LETTER: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', S: 'f4' };
const PASTE_END = '\x1b[201~';

function modifiers(param: string | undefined): { ctrl: boolean; alt: boolean; shift: boolean } {
  const m = Math.max(0, (parseInt(param ?? '1', 10) || 1) - 1);
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
}

/** One key from a single control or text character, or null for a character that means nothing here. */
function single(ch: string, alt: boolean): Key | null {
  const c = ch.codePointAt(0)!;
  if (ch === '\r' || ch === '\n') return makeKey('enter', { alt });
  if (ch === '\t') return makeKey('tab', { alt });
  if (ch === '\x7f' || ch === '\b') return makeKey('backspace', { alt });
  if (c === 0) return makeKey('char', { text: ' ', ctrl: true, alt });
  if (c >= 1 && c <= 26) return makeKey('char', { text: String.fromCharCode(c + 96), ctrl: true, alt });
  if (c >= 28 && c <= 31) return makeKey('char', { text: String.fromCharCode(c + 64), ctrl: true, alt });
  if (c < 32 || (c >= 0x80 && c < 0xa0)) return null;
  return makeKey('char', { text: ch, alt });
}

export class KeyParser {
  private buf = '';
  private paste: string | null = null;

  feed(data: string): Key[] {
    this.buf += data;
    return this.drain(false);
  }

  /** True while the input ends in something that may still be the start of an escape sequence. */
  pending(): boolean {
    return this.paste === null && this.buf.startsWith('\x1b');
  }

  /** Settles a waiting Escape (or unfinished sequence) as typed keys. Call it when no more input came for about 25 ms. */
  flush(): Key[] {
    return this.drain(true);
  }

  private drain(final: boolean): Key[] {
    const out: Key[] = [];
    while (this.buf) {
      if (this.paste !== null) {
        const end = this.buf.indexOf(PASTE_END);
        if (end < 0) {
          // Keep anything that could be the start of the end marker for the next read.
          let keep = 0;
          for (let n = Math.min(PASTE_END.length - 1, this.buf.length); n > 0; n--) if (PASTE_END.startsWith(this.buf.slice(-n))) { keep = n; break; }
          this.paste += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        out.push(makeKey('paste', { text: (this.paste + this.buf.slice(0, end)).replace(/\r\n?/g, '\n') }));
        this.paste = null;
        this.buf = this.buf.slice(end + PASTE_END.length);
        continue;
      }
      if (this.buf[0] !== '\x1b') {
        const cp = this.buf.codePointAt(0)!, ch = String.fromCodePoint(cp);
        this.buf = this.buf.slice(ch.length);
        const k = single(ch, false);
        if (k) out.push(k);
        continue;
      }
      const used = this.escape(out, final);
      if (used === 0) break;
      this.buf = this.buf.slice(used);
    }
    return out;
  }

  /** Reads one escape sequence at the start of the buffer. Returns how many characters it used, or 0 to wait for more input. */
  private escape(out: Key[], final: boolean): number {
    const b = this.buf;
    if (b.length === 1) { if (!final) return 0; out.push(makeKey('escape')); return 1; }
    const next = b[1]!;
    if (next === '[') {
      const m = /^\x1b\[([0-9;:<=>?]*)[\x20-\x2f]*([\x40-\x7e])/.exec(b);
      if (!m) {
        if (!final && /^\x1b\[[0-9;:<=>?\x20-\x2f]*$/.test(b)) return 0;
        out.push(makeKey('char', { text: '[', alt: true }));
        return 2;
      }
      const [seq, params, fin] = m as unknown as [string, string, string];
      const parts = params.split(';');
      if (fin === '~') {
        const n = parseInt(parts[0] ?? '', 10);
        if (n === 200) { this.paste = ''; return seq.length; }
        const name = TILDE[n];
        if (name) out.push(makeKey(name, modifiers(parts[1])));
      } else if (fin === 'Z') {
        out.push(makeKey('tab', { shift: true }));
      } else if (LETTER[fin] && !params.startsWith('?')) {
        out.push(makeKey(LETTER[fin], modifiers(parts[1])));
      }
      return seq.length;
    }
    if (next === 'O') {
      if (b.length === 2) { if (!final) return 0; out.push(makeKey('char', { text: 'O', alt: true })); return 2; }
      const name = LETTER[b[2]!] ?? (b[2] === 'R' ? 'f3' : undefined);
      if (name) { out.push(makeKey(name)); return 3; }
      out.push(makeKey('char', { text: 'O', alt: true }));
      return 2;
    }
    if (next === '\x1b') { out.push(makeKey('escape')); return 1; }
    // Escape followed by a character is that character with Alt held.
    const cp = b.codePointAt(1)!, ch = String.fromCodePoint(cp);
    const k = single(ch, true);
    if (k) out.push(k);
    return 1 + ch.length;
  }
}
