// The first screen of a phone web app with nothing saved: pair with the desktop, or set up on the phone alone.
import { esc } from '../util';

export const PAIR_TEXT = {
  title: 'Pair with your desktop',
  intro: "Pairing makes this phone show everything your desktop tracks and gives it the desktop's API keys, so there is nothing to type. To get the code, open Pair a phone in the desktop app's settings.",
  scan: 'Scan pairing code',
  iosAdd: 'Before you scan, add Augur to your home screen. Tap Share in Safari (on newer iPhones it is in the menu at the bottom), then tap Add to Home Screen. Open Augur from the home screen and scan there, because the home-screen app keeps its own storage and never sees a pairing made in Safari.',
  iosScan: 'Scan the code here rather than with the Camera app, which would pair the Safari copy of Augur.',
  alone: 'Set up without a desktop',
  aloneHelp: 'You add API keys by hand, and this phone cannot show plan limits for Claude, Codex, or Grok.',
};

export interface PairModel {
  scanError: string;
  /** An iPhone or iPad in Safari, where the home-screen app has separate storage. */
  iosBrowser: boolean;
  /** An iPhone or iPad running as the home-screen app. */
  iosApp: boolean;
}

export function renderPair(m: PairModel): string {
  const hint = m.iosBrowser ? PAIR_TEXT.iosAdd : m.iosApp ? PAIR_TEXT.iosScan : '';
  return `<h2 class="sec">${PAIR_TEXT.title}</h2><div class="card pair-card">
    <p class="help">${esc(PAIR_TEXT.intro)}</p>
    ${hint ? `<p class="help pair-ios">${esc(hint)}</p>` : ''}
    <div class="actions pair-actions"><button type="button" class="btn primary" data-action="sync-scan">${PAIR_TEXT.scan}</button></div>
    ${m.scanError ? `<span class="bad-json">${esc(m.scanError)}</span>` : ''}
  </div>
  <div class="card pair-card"><p class="help">${esc(PAIR_TEXT.aloneHelp)}</p>
    <div class="actions pair-actions"><button type="button" class="btn" data-action="pair-alone">${PAIR_TEXT.alone}</button></div></div>`;
}
