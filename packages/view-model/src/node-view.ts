import {
  ACTIVITIES, DATA_TIERS, DATA_TIER_LABELS, WEIGHT_LEVELS, WEIGHT_LABELS, addModels, allPlugins, buildPolicyFile, cogitatorEntry, fleetCatalog, policyProviders, resolveModel,
  type ActivityId, type AppConfig, type DataTier, type FleetReading, type ModelCatalog, type ModelEntry, type ResolvedModel, type WeightLevel,
  type Snapshot,
} from '@augur/core';
import { rank, type Ranked, type UsageSnapshot } from '@augur/dispatch-protocol';
import { COST_LABELS, STATUS_LABELS } from './rules.js';

export interface NodeState {
  activity: ActivityId;
  dataTier: DataTier;
  tab: 'weight' | 'data' | 'behavior';
  switching: boolean;
  search: string;
  query: string;
  candidate?: string;
}

export const initialNodeState = (): NodeState => ({ activity: 'write_code', dataTier: 'internal', tab: 'weight', switching: false, search: '', query: '' });

export interface NodeRow {
  provider: string;
  label: string;
  slug: string;
  tag: string;
  entry: ModelEntry;
  resolved: ResolvedModel;
  ranked?: Ranked;
  share: number;
  reason: string;
}

export function roundShares(scores: readonly number[]): number[] {
  const clean = scores.map(score => Number.isFinite(score) && score > 0 ? score : 0);
  const sum = clean.reduce((total, score) => total + score, 0);
  if (!sum) return clean;
  const raw = clean.map(score => score / sum * 100), shares = raw.map(Math.floor);
  const order = raw.map((value, index) => ({ index, remainder: value - shares[index]! })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const item of order.slice(0, 100 - shares.reduce((total, share) => total + share, 0))) shares[item.index]!++;
  const positive = clean.filter(score => score > 0).length;
  if (positive > 100) return raw;
  for (let i = 0; i < shares.length; i++) if (clean[i]! > 0 && shares[i] === 0) {
    const largest = shares.indexOf(Math.max(...shares));
    shares[largest]!--; shares[i] = 1;
  }
  return shares;
}

export function nodeSlug(id: string): string {
  const name = id.toLowerCase().split('/').at(-1) ?? id.toLowerCase();
  const known = name.match(/terra|luna|minimax|deepseek|glm|mimo|sonnet|haiku|opus|gemma|grok|sol/);
  return known?.[0] ?? (name.replace(/^(?:gpt|claude)[-\d.]+/, '').replace(/[-_.]?\d.*$/, '').replace(/[^a-z-]/g, '') || name);
}

export function dragLevel(level: WeightLevel, delta: number, detent = 36): WeightLevel {
  const steps = Number.isFinite(delta) && detent > 0 ? Math.round(delta / detent) : 0;
  return WEIGHT_LEVELS[Math.max(0, Math.min(4, WEIGHT_LEVELS.indexOf(level) + steps))]!;
}

export function stepActivity(activity: ActivityId, direction: number): ActivityId {
  return ACTIVITIES[(ACTIVITIES.indexOf(activity) + direction % ACTIVITIES.length + ACTIVITIES.length) % ACTIVITIES.length]!;
}

function usageOf(snapshot: Snapshot | null): UsageSnapshot | null {
  if (!snapshot) return null;
  return { providers: Object.fromEntries(Object.entries(snapshot.providers).map(([id, row]) => [id, {
    ...row, meters: row.meters.map(meter => ({ ...meter, active: meter.active ?? undefined })),
    money: row.money.filter(money => money.amount !== null).map(money => ({ ...money, amount: money.amount! })),
    notes: row.notes as NonNullable<UsageSnapshot['providers'][string]>['notes'],
  }])) };
}

export function nodeMix(config: AppConfig, snapshot: Snapshot | null, activity: ActivityId, dataTier: DataTier, now = new Date()): NodeRow[] {
  const policy = config.policy ?? { providers: {}, stamps: {}, history: [] };
  const providers = policyProviders(config);
  for (const id of Object.keys(policy.providers)) if (!providers.some(provider => provider.id === id)) providers.push({ id, name: id, metered: false });
  const result = rank(buildPolicyFile(policy, providers, now), usageOf(snapshot), { activity, dataTier, caller: 'interactive' }, now);
  const ranking = new Map(result.ranking.map(row => [row.model, row])), blocked = new Map(result.blocked.map(row => [row.model, row.why]));
  const shares = roundShares(result.ranking.map(row => row.score));
  const byLabel = new Map(result.ranking.map((row, index) => [row.model, shares[index]!]));
  const rows = Object.entries(policy.providers).flatMap(([provider, rules]) => Object.entries(rules.models).map(([label, entry]): NodeRow => ({
    provider, label, entry, resolved: resolveModel(provider, rules.defaults, entry), slug: nodeSlug(entry.id), tag: '', ranked: ranking.get(label),
    share: byLabel.get(label) ?? 0, reason: entry.status === 'hidden' ? STATUS_LABELS.hidden : blocked.get(label) ?? ((ranking.get(label)?.score ?? 0) <= 0 ? NODE_TEXT.expended : ''),
  })));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1);
  for (const row of rows) if (counts.get(row.slug)! > 1) row.tag = row.provider === 'cogitator' ? 'local' : providers.find(provider => provider.id === row.provider)?.name ?? row.provider;
  return rows.sort((a, b) => (b.ranked?.score ?? 0) - (a.ranked?.score ?? 0) || a.label.localeCompare(b.label));
}

export interface NodeCatalogItem {
  provider: string;
  providerName?: string;
  label: string;
  id: string;
  name: string;
  description: string;
  limits: string;
  activities: Partial<Record<ActivityId, WeightLevel>>;
  tier: DataTier;
  exists: boolean;
}

export function nodeCatalog(config: AppConfig, catalog: ModelCatalog, snapshot: Snapshot | null): NodeCatalogItem[] {
  const items = new Map<string, NodeCatalogItem>();
  for (const [provider, rules] of Object.entries(config.policy?.providers ?? {})) for (const [label, entry] of Object.entries(rules.models)) {
    const resolved = resolveModel(provider, rules.defaults, entry), knowledge = provider === 'cogitator' ? cogitatorEntry(entry.id) : undefined;
    items.set(label, { provider, label, id: entry.id, name: entry.name ?? entry.id, description: knowledge?.strengths ?? resolved.notes, limits: knowledge?.limits ?? '', activities: resolved.activities, tier: resolved.dataTier, exists: true });
  }
  for (const [provider, list] of Object.entries(catalog)) for (const entry of list.models) {
    const plugin = allPlugins(config).find(item => item.id === provider), label = `${plugin?.labelPrefix ?? provider}/${entry.id}`;
    if ([...items.values()].some(item => item.provider === provider && item.id === entry.id)) continue;
    const knowledge = provider === 'cogitator' ? cogitatorEntry(entry.id) : undefined, tier = config.policy?.providers[provider]?.defaults.dataTier ?? 'public';
    items.set(label, { provider, label, id: entry.id, name: entry.name ?? entry.id, description: knowledge?.strengths ?? plugin?.name ?? provider, limits: knowledge?.limits ?? '', activities: knowledge?.activities ?? {}, tier: knowledge?.maxDataTier && !clearedFor(knowledge.maxDataTier, tier) ? knowledge.maxDataTier : tier, exists: false });
  }
  const fleet = snapshot?.providers.cogitator?.notes?.fleet as FleetReading | undefined;
  if (fleet) for (const entry of fleetCatalog(fleet)) {
    const existing = [...items.values()].find(item => item.provider === 'cogitator' && item.id === entry.id);
    if (existing) { existing.description = entry.strengths ?? existing.description; existing.limits = entry.limits ?? existing.limits; if (!existing.exists) existing.activities = entry.activities; continue; }
    items.set(entry.label, { provider: 'cogitator', label: entry.label, id: entry.id, name: entry.id, description: entry.strengths ?? entry.uses?.join(', ') ?? '', limits: entry.limits ?? '', activities: entry.activities, tier: config.policy?.providers.cogitator?.defaults.dataTier ?? 'public', exists: false });
  }
  const providers = policyProviders(config);
  return [...items.values()].map(item => ({ ...item, providerName: providers.find(provider => provider.id === item.provider)?.name ?? allPlugins(config).find(plugin => plugin.id === item.provider)?.name ?? item.provider }));
}

export function nodeSearch(query: string, ...values: string[]): boolean {
  const normalize = (value: string): string => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const haystack = normalize(values.join(' '));
  return normalize(query).split(/\s+/).every(word => haystack.includes(word));
}

export const clearedFor = (tier: DataTier, required: DataTier): boolean => DATA_TIERS.indexOf(tier) >= DATA_TIERS.indexOf(required);

export function nodeAddReason(config: AppConfig, snapshot: Snapshot | null, item: NodeCatalogItem, activity: ActivityId, tier: DataTier): string {
  if (!clearedFor(item.tier, tier)) return NODE_TEXT.refuseTier;
  if (!item.exists) return nodeMix(previewCatalog(config, item, activity), snapshot, activity, tier).find(row => row.provider === item.provider && row.label === item.label)?.reason ?? NODE_TEXT.rulesBlocked;
  const rules = config.policy?.providers[item.provider], own = rules?.models[item.label]?.rule.activities?.[activity];
  const explicit = own !== undefined ? own : rules?.defaults.activities?.[activity];
  const current = nodeMix(config, snapshot, activity, tier).find(row => row.provider === item.provider && row.label === item.label);
  if (current?.resolved.activities[activity] !== undefined || explicit === null) return current?.reason || NODE_TEXT.alreadyInMix;
  return nodeMix(previewLevel(config, item.provider, item.label, activity, 'normal'), snapshot, activity, tier).find(row => row.provider === item.provider && row.label === item.label)?.reason ?? NODE_TEXT.rulesBlocked;
}

export function nodeRemoveReason(config: AppConfig, snapshot: Snapshot | null, label: string, activity: ActivityId, tier: DataTier): string {
  const mix = nodeMix(config, snapshot, activity, tier).filter(row => row.share > 0);
  if (!mix.some(row => row.label === label)) return NODE_TEXT.absentModel;
  return mix.length === 1 ? NODE_TEXT.lastModel : '';
}

export function nodeCanRestore(config: AppConfig, snapshot: Snapshot | null, item: NodeCatalogItem, activity: ActivityId, tier: DataTier): boolean {
  const rules = config.policy?.providers[item.provider], own = rules?.models[item.label]?.rule.activities?.[activity];
  const explicit = own !== undefined ? own : rules?.defaults.activities?.[activity];
  return item.exists && explicit === null && clearedFor(item.tier, tier) && nodeMix(previewLevel(config, item.provider, item.label, activity, 'normal'), snapshot, activity, tier).some(row => row.label === item.label && row.share > 0);
}

export function suggestedThree(items: NodeCatalogItem[], activity: ActivityId, tier: DataTier): NodeCatalogItem[] {
  return items.filter(item => item.activities[activity] && clearedFor(item.tier, tier)).sort((a, b) => WEIGHT_LEVELS.indexOf(b.activities[activity]!) - WEIGHT_LEVELS.indexOf(a.activities[activity]!) || a.label.localeCompare(b.label)).slice(0, 3);
}

export function previewLevel(config: AppConfig, provider: string, label: string, activity: ActivityId, level: WeightLevel): AppConfig {
  const copy = structuredClone(config), entry = copy.policy?.providers[provider]?.models[label];
  if (entry) entry.rule.activities = { ...entry.rule.activities, [activity]: level };
  return copy;
}

export const NODE_TEXT = {
  list: 'List',
  node: 'Node view',
  weight: 'Weight',
  data: 'Data',
  behavior: 'Behavior',
  activity: 'Activity',
  searchActivities: 'Search activities',
  searchCatalog: 'Search models',
  catalog: 'Catalog',
  out: 'Out of the mix, share zero',
  emptyTitle: 'No models in this mix',
  emptyHelp: 'Add a model from the catalog or start from a suggested mix.',
  copy: 'Copy the mix from another activity.',
  advanced: 'Advanced',
  share: 'Share',
  inMix: 'In the mix',
  addHelp: 'Click or drag a catalog model to add it at Normal; a new model still needs confirmation.',
  refuseTier: 'The model cannot receive this activity\'s data tier.',
  notInMix: 'Not in the mix',
  expended: 'Quota used up',
  clearance: 'Data clearance',
  handling: 'Data handling',
  oneHour: 'For 1 hour',
  tomorrow: 'Until tomorrow',
  custom: 'Custom',
  sheen: 'Sheen',
  animation: 'Animation',
  ticks: 'Tick marks',
  effectHelp: 'TODO_PROSE_effectHelp Sheen, animation and ticks can be disabled; reduced motion disables slice animation.',
  testKey: 'Test key',
  keyOk: 'Key works.',
  keyFailed: 'Key test failed. Check the key and try again.',
  claudeApiHelp: 'Add a Claude API key to use Claude models. Existing route-specific keys keep working.',
  preview: 'The preview uses current rules and usage with a neutral fit of 0.5, so real tasks can differ.',
  cancel: 'Cancel',
  useDefault: 'Use default',
  series: 'Series',
  seriesKind: 'Series type',
  seriesPattern: 'Pattern',
  close: 'Close',
  noSuggestions: 'No suggestions for this activity.',
  levelHelp: 'Level sets how often the model is picked for this activity.',
  tierHelp: 'Highest data tier is the most sensitive data the model can receive.',
  behaviorHelp: 'Pause the model or change its ask-first, cost, output, sandbox, and reasoning effort settings.',
  switchHelp: 'Press Ctrl K to search activities, and press [ or ] to step through them.',
  mathHelp: 'Shares come from the existing pick preview using weight level, neutral task fit 0.5, current usage, and balance gates.',
  dragHelp: 'Drag the slice edge to move through five weight levels.',
  suggested: 'Add the suggested three',
  reset: 'Until the meter resets',
  noVision: 'No vision',
  blocked: 'Blocked',
  notAllowed: 'Not allowed',
  leader: 'Leader',
  fit: 'Task fit',
  usage: 'Usage',
  level: 'Level',
  balance: 'Balance',
  sum: 'Sum',
  hide: 'Hide',
  confirm: 'Confirm',
  dataGate: 'Data tier gate',
  noMatch: 'No matching activities',
  noModelMatch: 'TODO_PROSE_noModelMatch No models match this search.',
  addSelected: 'TODO_PROSE_addSelected Add selected model.',
  removeSelected: 'TODO_PROSE_removeSelected Remove selected model from this activity.',
  mixDragHelp: 'TODO_PROSE_mixDragHelp Drag this model to the list to remove it.',
  rulesBlocked: 'TODO_PROSE_rulesBlocked Current activity rules prevent adding this model.',
  restoreActivity: 'TODO_PROSE_restoreActivity This activity blocks the model; add it at Normal?',
  alreadyInMix: 'TODO_PROSE_alreadyInMix This model already has a level in this activity.',
  absentModel: 'TODO_PROSE_absentModel This model is not in this activity mix.',
  lastModel: 'TODO_PROSE_lastModel Removing this model leaves the activity mix empty; continue?',
  added: 'TODO_PROSE_added Model added to this activity.',
  removed: 'TODO_PROSE_removed Model removed from this activity.',
  dialogTitle: 'TODO_PROSE_dialogTitle Model mix change.',
  ok: 'TODO_PROSE_ok OK.',
  dialogCancel: 'TODO_PROSE_dialogCancel Cancel.',
  selectionHelp: 'Select an activity to view its rules.',
  status: 'Status',
  highestTier: 'Highest data tier',
  allActivities: 'All activities',
  none: 'None',
  awaitingReview: 'Awaiting review',
  dragCue: 'Drag to change level',
  stopHelp: 'The numbers show this model\'s share at each level.',
  touchHelp: 'Tap a slice or chip to select it. Hold for the math.',
  pinHelp: 'Select a slice to keep its math here.',
} as const;

export function previewCatalog(config: AppConfig, item: NodeCatalogItem, activity: ActivityId): AppConfig {
  const copy = structuredClone(config);
  if (!copy.policy) return copy;
  if (!item.exists) addModels(copy.policy, item.provider, [{ label: item.label, id: item.id, name: item.name }], 'manual');
  const entry = copy.policy.providers[item.provider]?.models[item.label];
  if (entry && entry.status === 'unreviewed') entry.status = 'confirmed';
  return previewLevel(copy, item.provider, item.label, activity, 'normal');
}

export function copyMix(config: AppConfig, source: ActivityId, target: ActivityId): Array<{ path: string; value: WeightLevel | null }> {
  return Object.entries(config.policy?.providers ?? {}).flatMap(([provider, rules]) => Object.entries(rules.models).flatMap(([label, entry]) => {
    if (entry.status === 'hidden') return [];
    const own = entry.rule.activities?.[source], explicit = own !== undefined ? own : rules.defaults.activities?.[source];
    const value = explicit === null ? null : resolveModel(provider, rules.defaults, entry).activities[source];
    return value === undefined ? [] : [{ path: `${provider}|${label}|activities.${target}`, value }];
  }));
}

export function nodeTooltip(row: NodeRow): string {
  const r = row.ranked;
  return r ? `${row.slug}: ${r.weight} x ${r.fit.toFixed(2)} x ${r.usage.toFixed(2)}${r.tilt !== 1 || r.boost !== 1 ? ` x ${r.tilt} x ${r.boost}` : ''} = ${r.score}; ${NODE_TEXT.share} ${row.share}%. ${DATA_TIER_LABELS[row.resolved.dataTier]}. ${COST_LABELS[row.resolved.cost]}. ${r.why}` : `${row.slug}: 0%. ${row.reason}`;
}

export function nodeActivityLabel(row: NodeRow, activity: ActivityId, catalog: ModelCatalog): string {
  const level = row.resolved.activities[activity];
  if (!level) {
    const inputs = catalog[row.provider]?.models.find(model => model.id === row.entry.id)?.inputModalities;
    const kind = row.provider === 'cogitator' ? cogitatorEntry(row.entry.id)?.kind : undefined;
    return activity === 'read_images' && ((inputs && !inputs.includes('image')) || (kind && kind !== 'vision')) ? NODE_TEXT.noVision : NODE_TEXT.notInMix;
  }
  return row.reason ? NODE_TEXT.blocked : WEIGHT_LABELS[level];
}
