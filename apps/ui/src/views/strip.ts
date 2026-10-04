import type { FeedAlert } from '@augur/core';
import { ALERTS_TEXT, shortAgo } from '@augur/view-model';
import { esc, ICON } from '../util';

export interface StripModel {
  pinned: boolean;
  /** The desktop panel can be pinned; the phone's strip carries only the bell. */
  canPin: boolean;
  alerts: FeedAlert[];
  open: boolean;
  now?: Date;
}

export const STRIP_TEXT = {
  hint: 'Pinned. Drag here to move.',
  pin: 'Pin Augur on top until you hide it',
  unpin: 'Unpin. Augur hides again when you click elsewhere.',
  bell: ALERTS_TEXT.heading,
  ...ALERTS_TEXT,
};

function alertRow(a: FeedAlert, now: Date): string {
  return `<li class="alert-row ${a.severity}"><span class="sev" aria-hidden="true"></span>
    <div class="alert-text"><div class="alert-title">${esc(a.title)}<span class="alert-age">${shortAgo(a.raisedAt, now)}</span></div><div class="alert-body">${esc(a.body)}</div></div>
    <button class="strip-btn small" data-action="dismiss-alert" data-value="${esc(a.id)}" title="${STRIP_TEXT.dismiss}" aria-label="${STRIP_TEXT.dismiss}: ${esc(a.title)}">${ICON.close}</button></li>`;
}

/** The title strip above every page. While pinned, the strip's row is the handle that moves the window. The bell opens the alert list under it. */
export function renderStrip(m: StripModel): string {
  const now = m.now ?? new Date();
  const label = m.pinned ? STRIP_TEXT.unpin : STRIP_TEXT.pin;
  const n = m.alerts.length;
  const bellLabel = n ? `${STRIP_TEXT.bell}: ${n}` : STRIP_TEXT.bell;
  const row = `<div class="strip-row">${m.pinned ? `<span class="grip">${ICON.grip}</span>` : ''}<span class="name">Augur</span>
    ${m.pinned ? `<span class="hint">${STRIP_TEXT.hint}</span>` : ''}<span class="grow"></span>
    <button class="strip-btn bell${m.open ? ' on' : ''}" data-action="bell" aria-expanded="${m.open}" title="${bellLabel}" aria-label="${bellLabel}">${ICON.bell}${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}</button>
    ${m.canPin ? `<button class="strip-btn pin${m.pinned ? ' on' : ''}" data-action="pin" aria-pressed="${m.pinned}" title="${label}" aria-label="${label}">${ICON.pin}</button>` : ''}</div>`;
  if (!m.open) return row;
  const list = n
    ? `<ul class="alert-list">${m.alerts.map((a) => alertRow(a, now)).join('')}</ul>`
    : `<p class="alert-empty">${STRIP_TEXT.empty}</p>`;
  return `${row}<div class="alerts-panel" role="region" aria-label="${STRIP_TEXT.heading}">
    <div class="alerts-head"><span>${STRIP_TEXT.heading}</span><span class="grow"></span>${n > 1 ? `<button class="text-btn" data-action="dismiss-all">${STRIP_TEXT.dismissAll}</button>` : ''}</div>
    ${list}${n ? `<p class="alerts-foot">${STRIP_TEXT.foot}</p>` : ''}</div>`;
}
