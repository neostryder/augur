import type { PolicyFile } from './policy.js';

export interface AliasListedModel { id: string; name?: string; created?: string }
export interface AliasOffer { id: string; label: string; from: string; to: string; createdAt: string; status: 'pending' | 'failed' | 'superseded' | 'stale'; tested?: boolean; reason?: string; notes?: string[] }
export interface AliasRefreshState { newestSeenId: string; lastRefreshAt: string }
export interface AliasFlag { label: string; id: string; message: string; createdAt: string }
export interface AliasRefreshResult { offers: AliasOffer[]; flags: AliasFlag[]; state: Record<string, AliasRefreshState>; noListing: string[] }

export function newestMatching(listing: readonly AliasListedModel[], pattern: string): AliasListedModel | null {
  const escaped = [...pattern].map(char => char === '*' ? '.*' : char === '?' ? '.' : /[\\^$+{}()[\]|.]/.test(char) ? `\\${char}` : char).join('');
  const re = new RegExp(`^${escaped}$`, 'i');
  return listing.filter(item => item.id.length <= 200 && !item.id.split('/').some(part => part === '.' || part === '..') && re.test(item.id) && item.created && Number.isFinite(Date.parse(item.created)))
    .sort((a, b) => Date.parse(b.created!) - Date.parse(a.created!) || a.id.localeCompare(b.id))[0] ?? null;
}

export function refreshAliases(policy: PolicyFile, listings: Record<string, readonly AliasListedModel[] | null>, previous: Record<string, AliasRefreshState> = {}, now = new Date(), onlyLabel?: string): AliasRefreshResult {
  const offers: AliasOffer[] = [], flags: AliasFlag[] = [], state = { ...previous }, noListing = new Set<string>();
  for (const [provider, config] of Object.entries(policy.providers)) for (const [label, model] of Object.entries(config.models)) {
    if (!model.series || (onlyLabel && onlyLabel !== label)) continue;
    const listing = listings[provider];
    const at = now.toISOString(), oldState = previous[label];
    if (!listing) { noListing.add(provider); state[label] = { newestSeenId: oldState?.newestSeenId ?? '', lastRefreshAt: at }; continue; }
    const newest = newestMatching(listing, model.series.pattern);
    if (!newest) { state[label] = { newestSeenId: oldState?.newestSeenId ?? '', lastRefreshAt: at }; continue; }
    state[label] = { newestSeenId: newest.id, lastRefreshAt: at };
    if (newest.id === model.id) continue;
    if (model.series.kind === 'embed') {
      flags.push({ label, id: newest.id, message: `newer embedding model available: ${newest.id}; swapping means re-making stored vectors`, createdAt: at });
      continue;
    }
    offers.push({ id: `${at}-${label}-${newest.id}`, label, from: model.id, to: newest.id, createdAt: at, status: 'pending' });
  }
  return { offers, flags, state, noListing: [...noListing].sort() };
}

