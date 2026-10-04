import { acceptPairing, parsePairing, type SyncLink, type SecretWriter } from '@augur/core';

/** Accepts a pairing link the phone opened (`#pair=...`) and clears it from the address bar. */
export async function acceptPairingFromUrl(shell: SecretWriter): Promise<SyncLink | null> {
  if (!location.hash.startsWith('#pair')) return null;
  const link = parsePairing(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  return link ? acceptPairing(shell, link) : null;
}
