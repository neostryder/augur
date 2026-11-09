import type { Adapter } from '@augur/dispatch-protocol';
import { anthropicApi, openaiApi } from './api.js';
import { claudeExec } from './claude-exec.js';
import { codexExec } from './codex-exec.js';
import { copilotExec } from './copilot-exec.js';
import { falApi } from './fal.js';
import { genericExec } from './exec.js';
import { grokExec } from './grok-exec.js';
import { hermesExec } from './hermes-exec.js';
import { mcodeExec } from './mcode-exec.js';

export const ALL_ADAPTERS: readonly Adapter[] = [claudeExec, codexExec, hermesExec, copilotExec, grokExec, mcodeExec, openaiApi, anthropicApi, falApi, genericExec];

/** The adapters a service config allows. */
export function enabledAdapters(ids: readonly string[], local: readonly Adapter[] = []): Map<string, Adapter> {
  return new Map([...ALL_ADAPTERS, ...local].filter(a => ids.includes(a.id)).map(a => [a.id, a]));
}
export { loadLocalAdapters } from './local.js';
export { anthropicApi, claudeExec, codexExec, copilotExec, falApi, genericExec, grokExec, hermesExec, mcodeExec, openaiApi };
