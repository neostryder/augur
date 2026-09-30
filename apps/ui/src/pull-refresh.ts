// Pull down from the top of the page to refresh, for the phone web app, which has no browser refresh button once it is saved to the home screen.

/** How far the page follows a finger that has moved `dy` pixels, easing off so a long pull still feels bounded. */
export function pullOffset(dy: number): number {
  return dy <= 0 ? 0 : Math.min(120, dy * 0.5);
}

/** A pull counts once the page has followed the finger this far. */
export const PULL_TRIGGER = 56;

/** Whether the touch began where a pull should be ignored: the page is scrolled, or something under the finger is. */
function scrolledAway(target: EventTarget | null): boolean {
  if (window.scrollY > 0) return true;
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return true;
  }
  return false;
}

/** Shows a small label at the top while the page is pulled and while `onRefresh` runs. Returns a function that removes the listeners. */
export function attachPullToRefresh(onRefresh: () => Promise<void>): () => void {
  const label = document.createElement('div');
  label.className = 'ptr';
  label.setAttribute('role', 'status');
  document.body.append(label);
  let startY: number | null = null, offset = 0, busy = false;

  const show = (text: string, y: number) => { label.textContent = text; label.style.transform = `translate(-50%, ${y}px)`; label.style.opacity = y > 0 ? '1' : '0'; };
  const start = (e: TouchEvent) => { startY = !busy && e.touches.length === 1 && !scrolledAway(e.target) ? (e.touches[0] as Touch).clientY : null; offset = 0; };
  const move = (e: TouchEvent) => {
    if (startY === null) return;
    offset = pullOffset((e.touches[0] as Touch).clientY - startY);
    if (offset > 0 && e.cancelable) e.preventDefault();
    show(offset >= PULL_TRIGGER ? 'Release to refresh usage' : 'Pull down to refresh usage', offset);
  };
  const end = async () => {
    const pulled = startY !== null && offset >= PULL_TRIGGER;
    startY = null;
    if (!pulled) { show('', 0); return; }
    busy = true;
    show('Refreshing usage and syncing with the desktop', PULL_TRIGGER);
    try { await onRefresh(); } finally { busy = false; show('', 0); }
  };

  const finish = () => void end();
  const cancel = () => { startY = null; show('', 0); };
  document.addEventListener('touchstart', start, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', finish, { passive: true });
  document.addEventListener('touchcancel', cancel, { passive: true });
  return () => {
    document.removeEventListener('touchstart', start);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', finish);
    document.removeEventListener('touchcancel', cancel);
    label.remove();
  };
}
