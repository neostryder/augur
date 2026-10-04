import { describe, expect, it } from 'vitest';
import type { FeedAlert } from '@augur/core';
import { STRIP_TEXT, renderStrip } from '../src/views/strip';

const now = new Date('2026-10-03T12:00:00Z');
const alert = (id: string, severity: FeedAlert['severity'] = 'warn'): FeedAlert =>
  ({ id, kind: 'percent', severity, title: 'Claude', body: `Claude: <Session> ${id}`, raisedAt: '2026-10-03T11:15:00Z', outlets: ['augur'], clears: { when: 'never' } });
const base = { pinned: false, canPin: true, alerts: [] as FeedAlert[], open: false, now };

describe('the title strip', () => {
  it('offers to pin, with no drag hint, while unpinned', () => {
    const html = renderStrip(base);
    expect(html).toContain('data-action="pin"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(STRIP_TEXT.pin);
    expect(html).not.toContain(STRIP_TEXT.hint);
    expect(html).not.toContain('class="grip"');
  });

  it('shows the grip and the drag hint, and offers to unpin, while pinned', () => {
    const html = renderStrip({ ...base, pinned: true });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('strip-btn pin on');
    expect(html).toContain(STRIP_TEXT.unpin);
    expect(html).toContain(STRIP_TEXT.hint);
    expect(html).toContain('class="grip"');
  });

  it('leaves the pin off the phone', () => {
    expect(renderStrip({ ...base, canPin: false })).not.toContain('data-action="pin"');
  });

  it('badges the bell with the alert count and keeps the list closed until asked', () => {
    const html = renderStrip({ ...base, alerts: [alert('a'), alert('b')] });
    expect(html).toContain('<span class="badge">2</span>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('alerts-panel');
    expect(renderStrip(base)).not.toContain('class="badge"');
  });

  it('lists alerts with a dismiss button each, escapes their text, and offers Dismiss all for more than one', () => {
    const html = renderStrip({ ...base, open: true, alerts: [alert('a', 'crit'), alert('b')] });
    expect(html).toContain('alert-row crit');
    expect(html).toContain('data-action="dismiss-alert" data-value="a"');
    expect(html).toContain('&lt;Session&gt;');
    expect(html).toContain('45m');
    expect(html).toContain(STRIP_TEXT.dismissAll);
    expect(html).toContain(STRIP_TEXT.foot);
    expect(renderStrip({ ...base, open: true, alerts: [alert('a')] })).not.toContain(STRIP_TEXT.dismissAll);
  });

  it('says so when there is nothing to show', () => {
    expect(renderStrip({ ...base, open: true })).toContain(STRIP_TEXT.empty);
  });
});
