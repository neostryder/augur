import type { Shell } from '@augur/core';

export async function pickShell(): Promise<Shell> {
  if ('__TAURI_INTERNALS__' in window) {
    const m = await import('@augur/host-tauri');
    return m.createTauriShell();
  }
  if (document.querySelector('meta[name="augur-served"]')) {
    const m = await import('./served');
    return m.createServedShell();
  }
  const m = await import('./browser');
  return m.createBrowserShell();
}
