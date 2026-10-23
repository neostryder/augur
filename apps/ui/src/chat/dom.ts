// Small DOM helpers. Text always goes in as text, never as markup, so nothing a model writes can run in the page.

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string; on?: Record<string, (e: Event) => void>; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
    else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

export const clear = (el: Element): void => { while (el.firstChild) el.firstChild.remove(); };
export const replace = (el: Element, ...kids: Child[]): void => { clear(el); for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k); };

/** Icons are fixed strings written here, never anything from a model or the network. */
const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12l14-7-5 14-2-6-7-1z',
  stop: 'M7 7h10v10H7z',
  clip: 'M8 12.5l6.2-6.2a3.2 3.2 0 014.5 4.5l-8 8a5 5 0 01-7-7l7.5-7.5',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  retry: 'M4 12a8 8 0 0114-5l2-2v6h-6l2-2a5 5 0 10-1 7',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 5v4M7 15v4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14A8 8 0 019.5 4 8 8 0 1020 14z',
  auto: 'M12 3a9 9 0 100 18V3z M12 3a9 9 0 010 18',
  ghost: 'M6 20V11a6 6 0 0112 0v9l-2-2-2 2-2-2-2 2-2-2zM10 11h.01M14 11h.01',
  home: 'M4 11l8-7 8 7M6 10v10h12V10',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  cloud: 'M7 18a4 4 0 010-8 5 5 0 019.5-1A4.5 4.5 0 0117 18z',
  brain: 'M9 5a3 3 0 00-3 3 3 3 0 00-1 5 3 3 0 004 3 3 3 0 005 0 3 3 0 004-3 3 3 0 00-1-5 3 3 0 00-3-3 3 3 0 00-3 1 3 3 0 00-2-1M12 6v12',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5v.01',
  command: 'M9 9V6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 103 3z',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  audio: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2',
  check: 'M5 12l5 5 9-10',
  branch: 'M7 4v10M7 14a3 3 0 100 6 3 3 0 000-6zM17 4a3 3 0 100 6 3 3 0 000-6zM17 10c0 4-10 2-10 4',
  warn: 'M12 4l9 16H3zM12 10v4M12 17v.01',
  mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM6 11a6 6 0 0012 0M12 17v4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01',
};

export function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.info!);
  svg.append(path);
  return svg;
}

export function iconButton(name: string, label: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `ib ${cls}`.trim(), type: 'button', 'aria-label': label, 'data-tip': label, on: { click: onClick as (e: Event) => void } }, icon(name));
}

export const ago = (t: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const bytesLabel = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
