// One tooltip for the whole page. A short label comes from `data-tip`; a card with a title and body comes from `data-card-title`, `data-card` and `data-card-def`.
// It shows on hover and on keyboard focus, and never traps the pointer.
let tip: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function ensure(): HTMLElement {
  if (!tip) { tip = document.createElement('div'); tip.id = 'tip'; tip.setAttribute('role', 'tooltip'); document.body.append(tip); }
  return tip;
}

function place(t: HTMLElement, at: DOMRect): void {
  const r = t.getBoundingClientRect(), pad = 8;
  let x = at.left + at.width / 2 - r.width / 2, y = at.bottom + 8;
  if (y + r.height > innerHeight - pad) y = at.top - r.height - 8;
  x = Math.max(pad, Math.min(x, innerWidth - r.width - pad));
  t.style.left = `${x}px`;
  t.style.top = `${Math.max(pad, y)}px`;
}

function show(el: HTMLElement): void {
  const t = ensure(), body = el.dataset.card, label = el.dataset.tip;
  if (!body && !label) return;
  t.replaceChildren();
  if (body) {
    t.classList.add('rich');
    if (el.dataset.cardTitle) { const b = document.createElement('b'); b.textContent = el.dataset.cardTitle; t.append(b); }
    t.append(document.createTextNode(body));
    if (el.dataset.cardDef) { const d = document.createElement('span'); d.className = 'def'; d.textContent = el.dataset.cardDef; t.append(d); }
  } else { t.classList.remove('rich'); t.textContent = label ?? ''; }
  t.style.opacity = '0';
  requestAnimationFrame(() => { place(t, el.getBoundingClientRect()); t.style.opacity = '1'; });
}

const hide = (): void => { clearTimeout(timer); if (tip) tip.style.opacity = '0'; };

export function installTips(): void {
  const find = (e: Event): HTMLElement | null => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip],[data-card]') : null);
  document.addEventListener('pointerover', e => { if ((e as PointerEvent).pointerType === 'touch') return; const el = find(e); if (!el) return; clearTimeout(timer); timer = setTimeout(() => show(el), 380); });
  document.addEventListener('pointerout', e => { if (find(e)) hide(); });
  document.addEventListener('focusin', e => { const el = find(e); if (el && (e.target as HTMLElement).matches(':focus-visible')) show(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide);
  document.addEventListener('scroll', hide, true);
}
