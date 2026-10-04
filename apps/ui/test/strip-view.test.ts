import { describe, expect, it } from 'vitest';
import { STRIP_TEXT, renderStrip } from '../src/views/strip';

describe('the title strip', () => {
  it('offers to pin, with no drag hint, while unpinned', () => {
    const html = renderStrip({ pinned: false });
    expect(html).toContain('data-action="pin"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(STRIP_TEXT.pin);
    expect(html).not.toContain(STRIP_TEXT.hint);
    expect(html).not.toContain('class="grip"');
  });

  it('shows the grip and the drag hint, and offers to unpin, while pinned', () => {
    const html = renderStrip({ pinned: true });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('strip-btn pin on');
    expect(html).toContain(STRIP_TEXT.unpin);
    expect(html).toContain(STRIP_TEXT.hint);
    expect(html).toContain('class="grip"');
  });
});
