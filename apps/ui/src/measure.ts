/** Height the element takes at the given width, whatever width the window has now. The width is put back before returning. */
export function heightAtWidth(el: HTMLElement, width: number): number {
  const before = el.style.width;
  el.style.width = `${width}px`;
  try { return el.getBoundingClientRect().height; } finally { el.style.width = before; }
}
