import { describe, expect, it } from 'vitest';
import { updateRows } from '../src/views/settings';

const model = (available: { version: string; managedBy?: string } | null) => ({
  update: { status: available ? 'available' : 'current', version: '1.5.0', available, changes: null },
  config: { autoUpdate: true },
}) as never;

describe('the update rows', () => {
  it('offer to install an update the app can install itself', () => {
    const html = updateRows(model({ version: '1.6.0' }));
    expect(html).toContain('Version 1.6.0 is available.');
    expect(html).toContain('data-action="update-install"');
  });

  it('name the package manager and offer no install when one owns the app', () => {
    const html = updateRows(model({ version: '1.6.0', managedBy: 'pacman' }));
    expect(html).toContain('Version 1.6.0 is available.');
    expect(html).toContain('pacman installed Augur');
    expect(html).toContain('makepkg -si');
    expect(html).not.toContain('update-install');
  });
});
