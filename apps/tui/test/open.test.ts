import { describe, expect, it } from 'vitest';
import { openCommand, openUrl } from '../src/open.js';

describe('open address', () => {
  it('hands the address to the system without a shell', () => {
    expect(openCommand('https://example.com/a?b=1&c=2', 'win32')).toEqual(['rundll32', ['url.dll,FileProtocolHandler', 'https://example.com/a?b=1&c=2']]);
    expect(openCommand('https://example.com', 'darwin')[0]).toBe('open');
    expect(openCommand('https://example.com', 'linux')[0]).toBe('xdg-open');
  });

  it('refuses anything that is not a plain web address', async () => {
    for (const bad of ['file:///etc/passwd', 'https://example.com/|ver', 'https://example.com/"x', 'https://example.com/a b', 'https://example.com/<x>', 'https://example.com/\u0001', 'javascript:alert(1)']) {
      expect(await openUrl(bad, 'win32'), bad).toBe(false);
    }
  });
});
