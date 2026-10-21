// The reference tables in docs/configuring.md, drawn from the code so the page cannot fall behind it.
// A test lists every field of the shipped balance rules and every adapter option, and fails when one has no entry here or the page's tables differ from what these functions print.
import { ADAPTER_INFO } from './adapter-info.js';
import { DEFAULT_BALANCE } from './balance.js';

export interface FieldDoc { path: string; type: string; summary: string }

/** One row for every setting the `balance` section of policy.json reads. `<route>` is a route label such as codex/sol or its standard name, the provider id and the model id joined by a slash (codex/gpt-6.1-sol), and a `*` in it matches any text. `<activity>` is one of the activity ids. */
export const BALANCE_FIELDS: readonly FieldDoc[] = [
  { path: 'profile', type: 'classic or neutral', summary: 'The starting rules the other settings sit on. Classic is the original rule set and is what an install with no profile uses. Neutral gives a tier only to Claude\'s own models, so pace moves work between Opus and Sonnet and leaves other routes alone. Both profiles boost providers with unused allowance.' },
  { path: 'enabled', type: 'true or false', summary: 'Switches the whole balance off, pace and the boost with it. Scores then come from fit, weights and usage alone.' },
  { path: 'boostFitFloor', type: 'number from 0 to 1', summary: 'The lowest caller fit that still gets the unused-allowance boost. A route the caller gave no fit for is boosted.' },
  { path: 'draw.enabled', type: 'true or false', summary: 'Draws each pick at random by its odds. Off, every pick takes the top score.' },
  { path: 'draw.tail', type: 'number from 0 to 1', summary: 'The share of the top score a route needs to stay in the draw. A route below it gets 0% odds and stays in the ranking.' },
  { path: 'depth.<activity>', type: 'routine, everyday, deep or core', summary: 'The depth an activity gets when neither the caller nor the task description gives one. Out of the box, write_code and reason_critique are deep and every other activity is everyday.' },
  { path: 'tiers.<route>', type: 'strong or light', summary: 'The tier of a route. A route with no tier is never tilted. Set a shipped entry to null to remove it.' },
  { path: 'exclude', type: 'list of words', summary: 'Route labels, or ids containing any of these words, that are never picked unless a caller names one.' },
  { path: 'tilt.deep.strong', type: 'number above 0', summary: 'The score multiplier for a strong route on deep work.' },
  { path: 'tilt.deep.light', type: 'number above 0', summary: 'The score multiplier for a light route on deep work.' },
  { path: 'tilt.everyday.strong', type: 'number above 0', summary: 'The score multiplier for a strong route on everyday work.' },
  { path: 'tilt.everyday.light', type: 'number above 0', summary: 'The score multiplier for a light route on everyday work.' },
  { path: 'tilt.routine.strong', type: 'number above 0', summary: 'The score multiplier for a strong route on routine work, such as renames, plumbing, and boilerplate.' },
  { path: 'tilt.routine.light', type: 'number above 0', summary: 'The score multiplier for a light route on routine work.' },
  { path: 'tilt.core.strong', type: 'number above 0', summary: 'The score multiplier for a strong route on core work: an engine, core logic, security-critical code, or anything costly to redo.' },
  { path: 'tilt.core.light', type: 'number above 0', summary: 'The score multiplier for a light route on core work.' },
  { path: 'caps.<route>.perDay', type: 'count', summary: 'The most times this route can be picked in 24 hours. At the limit it is left out of picks unless a caller names it, and picks that named it do not count. 0 turns the limit off.' },
  { path: 'caps.<route>.perSession', type: 'count', summary: 'The most times this route can be picked in one caller session. Named picks do not count here either, and 0 turns the limit off.' },
  { path: 'training.enabled', type: 'true or false', summary: 'Turns training mode on. A pick on a route in training.askTiers or training.askRoutes then waits for a person to confirm it or choose another route with augur pick-answer, and no job can run on it until then. Off by default.' },
  { path: 'training.agree', type: 'number from 0 to 1', summary: 'How often your answers must match the proposal, as a share of the recent ones, before a kind of work stops asking. A kind of work is an activity at one depth, such as write_code at deep. 0.9 by default.' },
  { path: 'training.window', type: 'number of 1 or more', summary: 'How many of the newest answers for a kind of work count toward its agreement share. 20 by default.' },
  { path: 'training.min', type: 'number of 1 or more', summary: 'How many answers a kind of work needs before it can stop asking. 10 by default.' },
  { path: 'training.spot', type: 'count', summary: 'After a kind of work stops asking, one pick in this many asks anyway. 10 by default, and 0 means it never asks again.' },
  { path: 'training.askDepths', type: 'list of words', summary: 'Picks at these depths ask every time on an asked route, even after the answers agree. Core by default.' },
  { path: 'training.askTiers', type: 'list of words', summary: 'Picks of routes in these tiers ask until the answers agree often enough. Strong by default, so light routes never ask.' },
  { path: 'training.askRoutes', type: 'list of routes', summary: 'Routes that ask on every pick, whatever their tier. Empty by default.' },
  { path: 'prose.models', type: 'list of routes', summary: 'The routes that write the best prose. They get prose.tilt on draft_prose at any depth.' },
  { path: 'prose.tilt', type: 'number above 0', summary: 'The multiplier a prose route gets on draft_prose in place of the depth tilt.' },
  { path: 'prose.pace.enabled', type: 'true or false', summary: 'Turns the prose pace switches on or off. Each provider with a route in prose.models has its own switch. While a provider\'s switch is on, draft_prose moves off its prose routes if another route can take the work.' },
  { path: 'prose.pace.ahead', type: 'points', summary: 'How many points a provider\'s stricter window must run ahead of its pace marker, with nothing used, before draft_prose moves off that provider. The lead needed shrinks as usage climbs.' },
  { path: 'prose.pace.aheadAtReserve', type: 'points', summary: 'The lead that moves draft_prose off a provider once a window reaches that provider\'s reserve. Between no usage and the reserve, the lead needed falls in a straight line from prose.pace.ahead to this value.' },
  { path: 'prose.pace.returnAt', type: 'points', summary: 'The lead at or below which draft_prose returns to a provider. Zero means the provider is back on its pace marker.' },
  { path: 'claude.provider', type: 'provider id', summary: 'The provider the older claude settings apply to, claude unless set. Its reserve can send work to backup routes, and while its figures are missing it leans to its light models. Pace settings for every provider sit under pace.<provider>.' },
  { path: 'claude.band', type: 'points', summary: 'The older spelling of pace.claude.band. Other providers set theirs under pace.<provider>.' },
  { path: 'claude.reserve', type: 'percent', summary: 'The older spelling of pace.claude.reserve. Other providers set theirs under pace.<provider>.' },
  { path: 'claude.hot.strong', type: 'number above 0', summary: 'The older spelling of pace.claude.hot.strong: Claude\'s multiplier for a strong route while it runs ahead of pace.' },
  { path: 'claude.hot.light', type: 'number above 0', summary: 'The older spelling of pace.claude.hot.light: Claude\'s multiplier for a light route while it runs ahead of pace.' },
  { path: 'claude.behind.strong', type: 'number above 0', summary: 'The older spelling of pace.claude.behind.strong: Claude\'s multiplier for a strong route while it runs behind pace.' },
  { path: 'claude.behind.light', type: 'number above 0', summary: 'The older spelling of pace.claude.behind.light: Claude\'s multiplier for a light route while it runs behind pace.' },
  { path: 'pace.<provider>.reserve', type: 'percent', summary: 'The percent of a window at which optional work moves off that provider while another provider can take it, 90 by default. Claude\'s work can then go to a backup route. Any other provider\'s work goes only to a subscription route.' },
  { path: 'pace.<provider>.band', type: 'points', summary: 'How many points of usage ahead of or behind the share of the window that has passed still count as on pace for that provider. 10 by default and 5 for Claude.' },
  { path: 'pace.<provider>.hot.strong', type: 'number above 0', summary: 'The multiplier for that provider\'s strong routes while it runs ahead of pace, 0.8 by default.' },
  { path: 'pace.<provider>.hot.light', type: 'number above 0', summary: 'The multiplier for that provider\'s light routes while it runs ahead of pace, 1.25 by default.' },
  { path: 'pace.<provider>.behind.strong', type: 'number above 0', summary: 'The multiplier for that provider\'s strong routes while it runs behind pace, 1.25 by default.' },
  { path: 'pace.<provider>.behind.light', type: 'number above 0', summary: 'The multiplier for that provider\'s light routes while it runs behind pace, 0.85 by default.' },
  { path: 'pace.<provider>.boost', type: 'number of 1 or more', summary: 'The most the unused-allowance boost can multiply that provider\'s scores, reached at a fresh window and shrinking as its fullest window fills. 1.5 by default, and 1 turns it off.' },
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

const MAP_NODES: Record<string, string> = { caps: '<route>', depth: '<activity>', tiers: '<route>', prefer: '<route>', 'fallback.routes': '<route>', 'seats.web': '<activity>', 'prefer.<route>': '<activity>', pace: '<provider>' };

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
  // A cap has two limits, so an empty map still names both.
  if (out.delete('caps.<route>')) { out.add('caps.<route>.perDay'); out.add('caps.<route>.perSession'); }
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
    if (a.notes) out.push(a.notes, '');
  }
  return out.join('\n').trimEnd();
}
