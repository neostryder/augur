import { ICON } from '../util';

export interface StripModel {
  pinned: boolean;
}

export const STRIP_TEXT = {
  hint: 'Pinned. Drag here to move.',
  pin: 'Pin Augur on top until you hide it',
  unpin: 'Unpin. Augur hides again when you click elsewhere.',
};

/** The desktop title strip above every page. While pinned, the strip itself is the handle that moves the window. */
export function renderStrip(m: StripModel): string {
  const label = m.pinned ? STRIP_TEXT.unpin : STRIP_TEXT.pin;
  return `${m.pinned ? `<span class="grip">${ICON.grip}</span>` : ''}<span class="name">Augur</span>
    ${m.pinned ? `<span class="hint">${STRIP_TEXT.hint}</span>` : ''}<span class="grow"></span>
    <button class="strip-btn pin${m.pinned ? ' on' : ''}" data-action="pin" aria-pressed="${m.pinned}" title="${label}" aria-label="${label}">${ICON.pin}</button>`;
}
