import type { Shell } from '@augur/core';

export async function pickShell(): Promise<Shell> {
  if ('__TAURI_INTERNALS__' in window) {
    const m = await import('@augur/host-tauri');
    return m.createTauriShell();
  }
  const m = await import('./browser');
  return m.createBrowserShell();
}
