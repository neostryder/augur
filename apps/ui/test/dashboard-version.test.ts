import { describe, expect, it } from 'vitest';
import { defaultConfig } from '@augur/core';
import { renderDashboard } from '../src/views/dashboard';

const render = (version: string | null | undefined) => {
  const config = defaultConfig();
  config.providers = [{ id: 'claude', enabled: true, settings: {} }];
  const snapshot = { generatedAt: '2026-10-04T12:00:00Z', providers: {} } as never;
  const update = version === undefined ? undefined : { version, status: 'idle' as const, available: null, changes: null };
  return renderDashboard({ config, snapshot, history: [], plugins: new Map(), busy: false, twoColumns: false, expanded: null, dark: false, shellKind: 'desktop', update });
};

describe('the dashboard title', () => {
  it('shows the running version beside the title, with the full version as its tooltip', () => {
    const html = render('1.21.0-edge.119');
    expect(html).toContain('<h1>Usage<span class="build" title="Version 1.21.0-edge.119">1.21.0-edge.119</span></h1>');
  });

  it('escapes the version and shows nothing when the host cannot report one', () => {
    expect(render('<b>1</b>')).toContain('&lt;b&gt;1&lt;/b&gt;');
    expect(render(null)).toContain('<h1>Usage</h1>');
    expect(render(undefined)).toContain('<h1>Usage</h1>');
    expect(render('  ')).toContain('<h1>Usage</h1>');
  });
});
