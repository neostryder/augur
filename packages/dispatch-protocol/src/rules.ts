// Decides whether a job may launch. Pure: the service supplies policy.json, the usage snapshot and the adapter's capabilities.
import { DATA_TIERS, pauseActive } from '@augur/core';
import type { PolicyFile, ResolvedModel } from '@augur/core';
import type { AdapterCapabilities, RouteConfig } from './adapter.js';
import type { JobRequest, Rejection } from './spec.js';

/** The part of usage.json the rules read. */
export interface UsageSnapshot {
  providers: Record<string, {
    meters?: Array<{ id: string; usedPct: number | null }>;
    money?: Array<{ id: string; amount: number; currency?: string }>;
    stale?: boolean;
  }>;
}

export interface RuleInput {
  policy: PolicyFile | null;
  usage: UsageSnapshot | null;
  route: RouteConfig;
  capabilities: AdapterCapabilities;
  now?: Date;
}

export type Decision = { allow: true; model: ResolvedModel; provider: string; warnings: string[] } | { allow: false; rejection: Rejection };

const no = (code: Rejection['code'], reason: string): Decision => ({ allow: false, rejection: { code, reason } });

export function findModel(policy: PolicyFile, label: string): { provider: string; model: ResolvedModel } | null {
  for (const [provider, p] of Object.entries(policy.providers)) { const model = p.models[label]; if (model) return { provider, model }; }
  return null;
}

export function evaluate(request: JobRequest, input: RuleInput): Decision {
  const { policy, route, capabilities } = input, now = input.now ?? new Date(), warnings: string[] = [];
  if (!policy) return no('no_policy', 'policy.json was not found. Augur writes it when a rule is saved.');
  const found = findModel(policy, route.model);
  if (!found) return no('unknown_model', `${route.model} is not in policy.json.`);
  const { provider, model } = found;
  if (model.status !== 'confirmed') return no('model_unreviewed', `${route.model} has status ${model.status}. Confirm its rules before use.`);
  let level = model.activities[request.activity];
  if (model.pause && pauseActive(model.pause, now)) {
    const paused = model.pause.weights;
    if (paused === null || paused === undefined) return no('model_paused', `${route.model} is paused until ${model.pause.until}.`);
    const override = paused[request.activity];
    if (override === null) return no('model_paused', `${route.model} is paused for ${request.activity} until ${model.pause.until}.`);
    if (override) level = override;
  }
  if (model.askFirst && !request.named) return no('ask_first', `${route.model} runs only when it is named for the task.`);
  if (!level) return no('activity_not_permitted', `${route.model} is not permitted to ${request.activity}.`);
  if (DATA_TIERS.indexOf(request.dataTier) > DATA_TIERS.indexOf(model.dataTier)) {
    return no('data_tier_too_high', `${route.model} may see ${model.dataTier} data at most, and the task is ${request.dataTier}.`);
  }
  if (model.sandbox && !capabilities.sandboxed) return no('sandbox_required', `${route.model} must run inside a sandbox, and this adapter runs on the host.`);
  // The stricter of the rule's output mode and the request's applies.
  if (model.output === 'text_only' && (request.output !== 'text_only' || request.tools !== 'read')) {
    return no('text_only', `${route.model} may return text only, with read tools.`);
  }
  if (model.output === 'patch_only' && request.output === 'write_files') return no('isolation_required', `${route.model} may return a patch only.`);
  if ((model.output === 'patch_only' || request.output === 'patch_only') && !capabilities.isolatesWorkspace) {
    return no('isolation_required', 'A patch-only job needs an adapter that works on a copy of the workspace.');
  }
  const provided = policy.providers[provider], usage = input.usage?.providers[provider];
  if (provided && usage) {
    const { warnPct, denyPct, minBalance } = provided.thresholds;
    for (const meter of usage.meters ?? []) {
      if (meter.usedPct === null) continue;
      if (meter.usedPct >= denyPct) return no('quota_denied', `${provider} ${meter.id} is at ${meter.usedPct}%, above the ${denyPct}% limit.`);
      if (meter.usedPct >= warnPct) warnings.push(`${provider} ${meter.id} is at ${meter.usedPct}%.`);
    }
    if (minBalance !== null && minBalance !== undefined) {
      for (const m of usage.money ?? []) if (m.amount < minBalance) return no('quota_denied', `${provider} balance ${m.amount} is under the ${minBalance} minimum.`);
    }
    if (usage.stale) warnings.push(`${provider} usage is stale.`);
  }
  return { allow: true, model, provider, warnings };
}

export interface GraphLimits { maxDepth: number; maxDescendants: number }
export const DEFAULT_GRAPH_LIMITS: GraphLimits = { maxDepth: 2, maxDescendants: 16 };

/** Checks a child job against its parent's lineage. `descendants` is the number of jobs already started under the root. */
export function checkLineage(request: JobRequest, parentRoute: RouteConfig | null, descendants: number, limits: GraphLimits = DEFAULT_GRAPH_LIMITS): Rejection | null {
  const parent = request.parent;
  if (!parent) return null;
  if (!parentRoute?.delegation) return { code: 'delegation_not_granted', reason: 'The parent job route does not grant delegation.' };
  if (parent.depth + 1 > limits.maxDepth) return { code: 'depth_exceeded', reason: `Dispatch depth is limited to ${limits.maxDepth}.` };
  if (descendants >= limits.maxDescendants) return { code: 'descendants_exceeded', reason: `A job tree may start ${limits.maxDescendants} jobs.` };
  return null;
}
