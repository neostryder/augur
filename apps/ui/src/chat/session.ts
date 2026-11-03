import type { ChatMeResponse } from '@augur/dispatch-protocol';
import type { DataTier } from '@augur/core';
import { api, Unauthorized, Unregistered } from './api';
import { MULTI_USER } from './copy';

export const TIERS: DataTier[] = ['public', 'internal', 'sensitive', 'regulated'];
export const tierRank = (t: DataTier): number => TIERS.indexOf(t);
export const tiersFor = (identity: ChatMeResponse | null): DataTier[] => TIERS.filter(t => identity?.kind !== 'user' || tierRank(t) <= tierRank(identity.user.tierCap));
export const cappedTier = (tier: DataTier, identity: ChatMeResponse | null): DataTier => tiersFor(identity).includes(tier) ? tier : identity?.kind === 'user' ? identity.user.tierCap : 'internal';

export type Session = { screen: 'chat'; identity: ChatMeResponse } | { screen: 'gate' | 'unregistered' | 'error'; message: string };

export async function identify(me: () => Promise<ChatMeResponse> = api.me): Promise<Session> {
  try { return { screen: 'chat', identity: await me() }; }
  catch (e) {
    if (e instanceof Unauthorized) return { screen: 'gate', message: MULTI_USER.GATE.rejected };
    if (e instanceof Unregistered) return { screen: 'unregistered', message: MULTI_USER.GATE.unregistered };
    return { screen: 'error', message: MULTI_USER.GATE.unavailable };
  }
}
