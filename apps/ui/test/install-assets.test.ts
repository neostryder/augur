import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const pub = (name: string): string => join(root, 'public', name);

describe('the web app install assets', () => {
  const page = readFileSync(join(root, 'index.html'), 'utf8');
  const manifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'));

  it('carries the favicon and the Apple touch icon inline, since a phone fetches linked icons without the page', () => {
    expect(page).toMatch(/<link rel="icon"[^>]*href="data:image\/png;base64,/);
    expect(page).toMatch(/<link rel="apple-touch-icon" href="data:image\/jpeg;base64,/);
  });

  it('links the PNG icons and has a manifest id', () => {
    expect(page).toContain('sizes="192x192" href="./icon-192.png"');
    expect(page).toContain('sizes="512x512" href="./icon-512.png"');
    expect(manifest.id).toBe('/');
    expect(manifest.icons.map((i: { purpose?: string }) => i.purpose)).toEqual(['any', 'any', 'maskable']);
  });

  it('ships every icon the manifest and the root paths name', () => {
    for (const icon of manifest.icons) expect(existsSync(pub(icon.src))).toBe(true);
    for (const name of ['apple-touch-icon.png', 'apple-touch-icon-precomposed.png', 'favicon.ico', 'favicon-32.png']) expect(existsSync(pub(name))).toBe(true);
  });
});
