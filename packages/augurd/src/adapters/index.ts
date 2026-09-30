import type { Adapter } from '@augur/dispatch-protocol';
import { anthropicApi, openaiApi } from './api.js';
import { codexExec } from './codex-exec.js';
import { copilotExec } from './copilot-exec.js';
import { genericExec } from './exec.js';
import { grokExec } from './grok-exec.js';
import { hermesExec } from './hermes-exec.js';
import { mcodeSbx } from './mcode-sbx.js';
import { opencodeSbx } from './opencode-sbx.js';

export const ALL_ADAPTERS: readonly Adapter[] = [codexExec, hermesExec, copilotExec, grokExec, mcodeSbx, opencodeSbx, openaiApi, anthropicApi, genericExec];

/** The adapters a service config allows. */
export function enabledAdapters(ids: readonly string[], local: readonly Adapter[] = []): Map<string, Adapter> {
  return new Map([...ALL_ADAPTERS, ...local].filter(a => ids.includes(a.id)).map(a => [a.id, a]));
}
export { loadLocalAdapters } from './local.js';
export { anthropicApi, codexExec, copilotExec, genericExec, grokExec, hermesExec, mcodeSbx, openaiApi, opencodeSbx };
