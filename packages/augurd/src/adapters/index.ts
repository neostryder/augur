import type { Adapter } from '@augur/dispatch-protocol';
import { codexExec } from './codex-exec.js';
import { genericExec } from './exec.js';

export const ALL_ADAPTERS: readonly Adapter[] = [codexExec, genericExec];

/** The adapters a service config allows. */
export function enabledAdapters(ids: readonly string[]): Map<string, Adapter> {
  return new Map(ALL_ADAPTERS.filter(a => ids.includes(a.id)).map(a => [a.id, a]));
}
export { codexExec, genericExec };
