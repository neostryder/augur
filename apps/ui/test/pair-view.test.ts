import { describe, expect, it } from 'vitest';
import { PAIR_TEXT, renderPair } from '../src/views/pair';

describe('the phone pairing screen', () => {
  it('offers scanning first and setup without a desktop second', () => {
    const html = renderPair({ scanError: '', iosBrowser: false, iosApp: false });
    expect(html).toContain('data-action="sync-scan"');
    expect(html).toContain('data-action="pair-alone"');
    expect(html.indexOf('sync-scan')).toBeLessThan(html.indexOf('pair-alone'));
    expect(html).not.toContain('Camera app');
    expect(html).not.toContain('Add to Home Screen');
  });

  it('tells an iPhone in Safari to add the home-screen app and scan there', () => {
    const html = renderPair({ scanError: '', iosBrowser: true, iosApp: false });
    expect(html).toContain('Add to Home Screen');
    expect(html).toContain('keeps its own storage');
  });

  it('tells the home-screen app to scan in the app, not with the Camera app', () => {
    const html = renderPair({ scanError: '', iosBrowser: false, iosApp: true });
    expect(html).toContain('rather than with the Camera app');
    expect(html).not.toContain('Add to Home Screen');
  });

  it('shows a scan error and escapes it', () => {
    const html = renderPair({ scanError: '<b>bad</b>', iosBrowser: false, iosApp: false });
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
    expect(html).not.toContain('<b>bad</b>');
  });

  it('keeps every string plain ASCII', () => {
    for (const text of Object.values(PAIR_TEXT)) expect(text).toMatch(/^[\x20-\x7e]*$/);
  });
});
