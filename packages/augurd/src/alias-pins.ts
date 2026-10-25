export type AliasPinResult = { ok: true } | { ok: false; reason: 'pin not verifiable' | 'pinned provider does not serve model' };

/** Checks that a provider pin is present in endpoint data for the listed model. */
export function checkAliasPin(pin: string | null | undefined, slug: string, endpoints: readonly string[] | null | undefined): AliasPinResult {
  if (!pin) return { ok: true };
  if (!endpoints?.length) return { ok: false, reason: 'pin not verifiable' };
  return endpoints.some(provider => provider.toLocaleLowerCase() === pin.toLocaleLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'pinned provider does not serve model' };
}
