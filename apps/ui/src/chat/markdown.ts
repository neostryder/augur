// A small Markdown renderer that builds DOM nodes, so what a model writes is only ever text and never markup.
// It reads what chat models actually write: paragraphs, headings, lists, quotes, tables, fenced code and the usual inline marks.
// A fence that is still open (a reply that is streaming) renders as code so far, and the text re-renders cleanly as it grows.
import { h, icon } from './dom';

const SAFE = /^(https?:|mailto:)/i;

interface Inline { re: RegExp; make(m: RegExpExecArray): Node }

function inline(text: string): Node[] {
  const out: Node[] = [];
  const rules: Inline[] = [
    { re: /`([^`\n]+)`/, make: m => h('code', { class: 'ic' }, m[1]) },
    { re: /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/, make: m => h('strong', {}, ...inline((m[1] ?? m[2])!)) },
    { re: /~~([^~\n]+?)~~/, make: m => h('del', {}, ...inline(m[1]!)) },
    { re: /(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])/, make: m => h('em', {}, ...inline((m[1] ?? m[2])!)) },
    { re: /!?\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, make: m => link(m[2]!, m[1]!) },
    { re: /https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"]/, make: m => link(m[0], m[0]) },
  ];
  let rest = text;
  while (rest) {
    let best: { at: number; len: number; node: Node } | null = null;
    for (const r of rules) {
      const m = r.re.exec(rest);
      if (m && (best === null || m.index < best.at)) best = { at: m.index, len: m[0].length, node: r.make(m) };
    }
    if (!best) { out.push(document.createTextNode(rest)); break; }
    if (best.at > 0) out.push(document.createTextNode(rest.slice(0, best.at)));
    out.push(best.node);
    rest = rest.slice(best.at + best.len);
  }
  return out;
}

function link(href: string, label: string): Node {
  if (!SAFE.test(href)) return document.createTextNode(`${label} (${href})`);
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, label);
}

function lines(text: string): Node[] {
  const parts: Node[] = [];
  text.split('\n').forEach((l, i) => { if (i) parts.push(document.createElement('br')); parts.push(...inline(l)); });
  return parts;
}

const KEYWORDS = new Set(('as async await break case catch class const continue def default defer del do elif else enum except export extends false finally fn for from func function go if impl import in interface is lambda let loop match mod mut new nil none null of or package pass private protected pub public raise return self static struct super switch this throw true try type typeof use var void while with yield and not select insert update delete create table where join values into set').split(' '));

/** A light highlighter: comments, strings, numbers and keywords, which is what makes a code block readable. */
function highlight(code: string, lang: string): DocumentFragment {
  const hash = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|ini|rb|ruby|r|ps1|powershell|dockerfile|make)$/i.test(lang);
  const dash = /^(sql|lua|hs|haskell)$/i.test(lang);
  const comment = hash ? '#[^\\n]*' : dash ? '--[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)';
  const re = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\\\n])*"?|'(?:\\\\.|[^'\\\\\\n])*'?|\`(?:\\\\.|[^\`\\\\])*\`?)|(\\b\\d[\\d_.xa-fA-F]*\\b)|(\\b[A-Za-z_][\\w]*\\b)`, 'g');
  const frag = document.createDocumentFragment();
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) frag.append(code.slice(last, m.index));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : KEYWORDS.has(m[4]!.toLowerCase()) ? 'k' : '';
    if (cls) frag.append(h('span', { class: `tok-${cls}` }, m[0])); else frag.append(m[0]);
    last = m.index + m[0].length;
  }
  if (last < code.length) frag.append(code.slice(last));
  return frag;
}

function codeBlock(code: string, lang: string): HTMLElement {
  const copy = h('button', { class: 'code-copy', type: 'button', 'aria-label': 'Copy code' }, icon('copy', 14), h('span', {}, 'Copy'));
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(code).then(() => { copy.classList.add('ok'); copy.lastElementChild!.textContent = 'Copied'; setTimeout(() => { copy.classList.remove('ok'); copy.lastElementChild!.textContent = 'Copy'; }, 1400); }, () => undefined);
  });
  return h('figure', { class: 'code' }, h('figcaption', {}, h('span', { class: 'code-lang' }, lang || 'text'), copy), h('pre', {}, h('code', {}, highlight(code, lang))));
}

const isTableSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string): string[] => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

interface Item { text: string; kids: Item[] }

function listBlock(src: string[], start: number): { node: HTMLElement; next: number } {
  const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const first = bullet.exec(src[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const baseIndent = first[1]!.length;
  const items: Item[] = [];
  let i = start;
  const stack: Array<{ indent: number; items: Item[] }> = [{ indent: baseIndent, items }];
  for (; i < src.length; i++) {
    const line = src[i]!, m = bullet.exec(line);
    if (m) {
      const indent = m[1]!.length;
      if (indent < baseIndent) break;
      while (stack.length > 1 && indent < stack.at(-1)!.indent) stack.pop();
      const top = stack.at(-1)!;
      if (indent > top.indent) {
        const parent = top.items.at(-1);
        if (parent) { const sub = { indent, items: parent.kids }; stack.push(sub); sub.items.push({ text: m[3]!, kids: [] }); continue; }
      }
      top.items.push({ text: m[3]!, kids: [] });
    } else if (line.trim() === '') {
      if (i + 1 < src.length && bullet.test(src[i + 1]!) && bullet.exec(src[i + 1]!)![1]!.length >= baseIndent) continue;
      break;
    } else if (/^\s{2,}\S/.test(line) && stack.at(-1)!.items.length) {
      const last = stack.at(-1)!.items.at(-1)!;
      last.text += '\n' + line.trim();
    } else break;
  }
  const build = (list: Item[]): HTMLElement => {
    const el = document.createElement(ordered ? 'ol' : 'ul');
    for (const it of list) {
      const task = /^\[( |x|X)\]\s+(.*)$/s.exec(it.text);
      const li = h('li', {}, ...(task ? [h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' }), ' ', ...lines(task[2]!)] : lines(it.text)));
      if (it.kids.length) li.append(build(it.kids));
      el.append(li);
    }
    return el;
  };
  const node = build(items);
  if (ordered && /^\d+/.test(first[2]!) && Number.parseInt(first[2]!, 10) !== 1) (node as HTMLOListElement).start = Number.parseInt(first[2]!, 10);
  return { node, next: i };
}

export function render(text: string): DocumentFragment {
  const out = document.createDocumentFragment(), src = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < src.length) {
    const line = src[i]!;
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < src.length && !new RegExp(`^\\s*${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}\\s*$`).test(src[i]!); i++) body.push(src[i]!);
      i++;
      out.append(codeBlock(body.join('\n'), fence[2]!));
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const head = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (head) { out.append(h(`h${Math.min(6, head[1]!.length + 1)}` as 'h2', {}, ...inline(head[2]!))); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.append(document.createElement('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < src.length && /^\s*>/.test(src[i]!); i++) quote.push(src[i]!.replace(/^\s*>\s?/, ''));
      out.append(h('blockquote', {}, render(quote.join('\n'))));
      continue;
    }
    if (line.includes('|') && i + 1 < src.length && isTableSep(src[i + 1]!)) {
      const head = cells(line), aligns = cells(src[i + 1]!).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      const rows: string[][] = [];
      for (i += 2; i < src.length && src[i]!.includes('|') && src[i]!.trim() !== ''; i++) rows.push(cells(src[i]!));
      const cell = (tag: 'th' | 'td', t: string, n: number) => h(tag, { style: aligns[n] ? `text-align:${aligns[n]}` : '' }, ...inline(t));
      out.append(h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, ...head.map((t, n) => cell('th', t, n)))), h('tbody', {}, ...rows.map(r => h('tr', {}, ...head.map((_, n) => cell('td', r[n] ?? '', n))))))));
      continue;
    }
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) { const r = listBlock(src, i); out.append(r.node); i = r.next; continue; }
    const para: string[] = [];
    for (; i < src.length && src[i]!.trim() !== '' && !/^\s*(`{3,}|~{3,})/.test(src[i]!) && !/^#{1,6}\s/.test(src[i]!) && !/^\s*>/.test(src[i]!) && !(para.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(src[i]!)); i++) para.push(src[i]!);
    out.append(h('p', {}, ...lines(para.join('\n'))));
  }
  return out;
}
