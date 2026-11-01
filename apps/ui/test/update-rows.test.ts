import { describe, expect, it } from 'vitest';
import { updateRows } from '../src/views/settings';

const model = (available: { version: string; managedBy?: string } | null) => ({
  update: { status: available ? 'available' : 'current', version: '1.5.0', available, changes: null },
  config: { autoUpdate: true, updateChannel: 'stable' },
}) as never;

describe('the update rows', () => {
  it('offer to install an update the app can install itself', () => {
    const html = updateRows(model({ version: '1.6.0' }));
    expect(html).toContain('TODO_PROSE_UPDATE_CHANNEL_STATUS stable 1.6.0');
    expect(html).toContain('data-update-channel');
    expect(html).toContain('TODO_PROSE_UPDATE_CHANNEL_HELP');
    expect(html).toContain('TODO_PROSE_UPDATE_CHANNEL');
    expect(html).toContain('TODO_PROSE_STABLE_CHANNEL');
    expect(html).toContain('TODO_PROSE_EARLY_CHANNEL');
    expect(html).toContain('data-action="update-install"');
  });

  it('name the package manager and offer no install when one owns the app', () => {
    const html = updateRows(model({ version: '1.6.0', managedBy: 'pacman' }));
    expect(html).toContain('TODO_PROSE_UPDATE_CHANNEL_STATUS stable 1.6.0');
    expect(html).toContain('pacman installed Augur');
    expect(html).toContain('makepkg -si');
    expect(html).not.toContain('update-install');
  });
});
