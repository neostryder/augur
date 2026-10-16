import { acceptPairing, parsePairing, type SyncLink, type SecretWriter } from '@augur/core';

type Pending = SyncLink & { key: string };

/** The question put to the owner before a link they did not make in this app sets up or replaces the phone's pairing. */
export function pairingQuestion(link: SyncLink, current: SyncLink | null): string {
  let host = link.relay;
  try { host = new URL(link.relay).host; } catch { /* shown as written */ }
  const replacing = current?.channel ? ' This replaces the desktop this phone is paired with now.' : '';
  return `Pair this phone with a desktop that syncs through ${host}?${replacing} Choose OK only if you opened this link or scanned this code from your own Augur.`;
}

/** Whether a scan or a pasted code needs a question: only when it would replace a pairing that is already working. */
export function replacesPairing(link: SyncLink, current: SyncLink | null): boolean {
  return !!current?.channel && (current.channel !== link.channel || current.relay !== link.relay);
}

/** Accepts a pairing link the phone opened (`#pair=...`) and clears it from the address bar. Nothing is stored until the owner says yes. */
export async function acceptPairingFromUrl(shell: SecretWriter, current: SyncLink | null = null, ask: (question: string) => boolean = (q) => window.confirm(q)): Promise<SyncLink | null> {
  if (!location.hash.startsWith('#pair')) return null;
  const link: Pending | null = parsePairing(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  return link && ask(pairingQuestion(link, current)) ? acceptPairing(shell, link) : null;
}
