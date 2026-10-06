// The reference tables in docs/configuring.md, drawn from the code so the page cannot fall behind it.
// A test lists every field of the shipped balance rules and every adapter option, and fails when one has no entry here or the page's tables differ from what these functions print.
import { ADAPTER_INFO } from './adapter-info.js';
import { DEFAULT_BALANCE } from './balance.js';

export interface FieldDoc { path: string; type: string; summary: string }

/** One row for every setting the `balance` section of policy.json reads. `<route>` is a route label such as codex/sol and `<activity>` is one of the activity ids. */
export const BALANCE_FIELDS: readonly FieldDoc[] = [
  { path: 'enabled', type: 'true or false', summary: 'Switches the whole balance off. A pick then ranks on weights and usage alone.' },
  { path: 'depth.<activity>', type: 'deep or everyday', summary: 'How hard an activity is when the caller does not say. Deep work leans to strong models and everyday work to light ones.' },
  { path: 'tiers.<route>', type: 'strong or light', summary: 'The tier of a route. A route with no tier is never tilted. Set a shipped entry to null to remove it.' },
  { path: 'exclude', type: 'list of words', summary: 'Route labels, or ids containing any of these words, that are never picked unless a caller names one.' },
  { path: 'tilt.deep.strong', type: 'number above 0', summary: 'The score multiplier for a strong route on deep work.' },
  { path: 'tilt.deep.light', type: 'number above 0', summary: 'The score multiplier for a light route on deep work.' },
  { path: 'tilt.everyday.strong', type: 'number above 0', summary: 'The score multiplier for a strong route on everyday work.' },
  { path: 'tilt.everyday.light', type: 'number above 0', summary: 'The score multiplier for a light route on everyday work.' },
  { path: 'prose.models', type: 'list of routes', summary: 'The routes that write the best prose. They get prose.tilt on draft_prose at any depth.' },
  { path: 'prose.tilt', type: 'number above 0', summary: 'The multiplier a prose route gets on draft_prose in place of the depth tilt.' },
  { path: 'claude.provider', type: 'provider id', summary: 'The provider the Claude controller steers. It reads that provider\'s session and weekly windows.' },
  { path: 'claude.band', type: 'points', summary: 'How many points of usage ahead of or behind the share of the window that has passed still count as on pace.' },
  { path: 'claude.reserve', type: 'percent', summary: 'A window at or above this moves optional work off Claude while another route can take it.' },
  { path: 'claude.hot.strong', type: 'number above 0', summary: 'The multiplier for a strong route when Claude runs ahead of pace.' },
  { path: 'claude.hot.light', type: 'number above 0', summary: 'The multiplier for a light route when Claude runs ahead of pace.' },
  { path: 'claude.behind.strong', type: 'number above 0', summary: 'The multiplier for a strong route when Claude runs behind pace.' },
  { path: 'claude.behind.light', type: 'number above 0', summary: 'The multiplier for a light route when Claude runs behind pace.' },
  { path: 'fallback.providers', type: 'list of provider ids', summary: 'Providers whose routes are backups. They compete only when no subscription route can take the work.' },
  { path: 'fallback.routes.<route>', type: 'list of activities', summary: 'A single route that is a backup for these activities only.' },
  { path: 'fallback.anthropic', type: 'list of routes', summary: 'Claude models reached through a backup provider. They are allowed once Claude is at its reserve, since a Claude stop halts everything.' },
  { path: 'fallback.aim', type: 'dollars', summary: 'The monthly spend on backup routes the router tries to stay under. A pick mentions the spend once it passes this.' },
  { path: 'fallback.cap', type: 'dollars', summary: 'The monthly spend at which backup routes are dropped, except the Claude models in fallback.anthropic while Claude is at its reserve.' },
  { path: 'fallback.margin', type: 'dollars', summary: 'Added to the last known spend, because the provider\'s figures lag.' },
  { path: 'prefer.<route>.<activity>', type: 'number above 0', summary: 'What a route is known to be good at: a multiplier on one activity. Set a route or an entry to null to remove it.' },
  { path: 'seats.second.models', type: 'list of routes', summary: 'The routes that give a second opinion, in order. The first one that is allowed for the task is named.' },
  { path: 'seats.second.skip', type: 'list of activities', summary: 'Activities too small to need a second opinion.' },
  { path: 'seats.web.<activity>', type: 'list of routes', summary: 'The free web routes a pick recommends for an activity, in order. The calling session drives the browser. Set an activity to null to remove it.' },
  { path: 'seats.shadow', type: 'route', summary: 'The local model that answers beside a pick made by a reasoning model, so the two answers can be compared.' },
  { path: 'seats.jev.route', type: 'route', summary: 'The classifier route that is first for the activities listed next.' },
  { path: 'seats.jev.activities', type: 'list of activities', summary: 'The activities the classifier route is first for.' },
  { path: 'seats.jev.tilt', type: 'number above 0', summary: 'The multiplier the classifier route gets on those activities.' },
];

const MAP_NODES: Record<string, string> = { depth: '<activity>', tiers: '<route>', prefer: '<route>', 'fallback.routes': '<route>', 'seats.web': '<activity>', 'prefer.<route>': '<activity>' };

/** The settings of the shipped balance rules, with each map's keys written as <route> or <activity>. */
export function balancePaths(rules: object = DEFAULT_BALANCE): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { out.add(path); return; }
    const key = MAP_NODES[path];
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${key ?? k}` : k);
    if (key && Object.keys(value).length === 0) out.add(`${path}.${key}`);
  };
  walk(rules, '');
  return [...out].sort();
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');

export function renderBalanceReference(): string {
  const rows = BALANCE_FIELDS.map(f => `| \`${f.path}\` | ${cell(f.type)} | ${cell(f.summary)} |`);
  return ['| Setting | Value | What it does |', '| --- | --- | --- |', ...rows].join('\n');
}

export function renderAdapterReference(): string {
  const out: string[] = [];
  for (const a of ADAPTER_INFO) {
    out.push(`#### \`${a.id}\`: ${a.label}`, '', a.summary, '');
    out.push('| Option | Value | What it does |', '| --- | --- | --- |');
    for (const o of a.options) {
      const kind = o.kind === 'choice' && o.choices ? o.choices.join(', ') : o.kind;
      out.push(`| \`${o.key}\`${o.required ? ' (required)' : ''} | ${cell(kind)} | ${cell(o.help)} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
