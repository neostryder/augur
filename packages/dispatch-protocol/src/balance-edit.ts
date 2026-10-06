// Checks a balance setting an agent asks to change against the documented settings, so a wrong path or a value of the wrong kind is refused with the reason
// instead of being stored and ignored. The settings come from BALANCE_FIELDS, the same list the configuring page is drawn from.
import { ACTIVITIES } from '@augur/core';
import { BALANCE_FIELDS } from './config-reference.js';

const CHOICES: Record<string, readonly string[]> = { 'classic or neutral': ['classic', 'neutral'], 'deep or everyday': ['deep', 'everyday'], 'strong or light': ['strong', 'light'], 'true or false': ['true', 'false'] };
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const listOf = (v: unknown, each: (x: string) => boolean): boolean => Array.isArray(v) && v.length <= 50 && v.every(x => isText(x) && each(x));

function matches(pattern: readonly string[], path: readonly string[]): boolean {
  return pattern.length === path.length && pattern.every((p, i) => p === '<route>' ? !!path[i] : p === '<activity>' ? ACTIVITIES.includes(path[i] as never) : p === path[i]);
}

function valueProblem(type: string, value: unknown): string | null {
  const choices = CHOICES[type];
  if (choices) return choices.includes(String(value)) && (type !== 'true or false' || typeof value === 'boolean') ? null : `The value is one of: ${choices.join(', ')}.`;
  switch (type) {
    case 'number above 0': return typeof value === 'number' && Number.isFinite(value) && value > 0 ? null : 'The value is a number above 0.';
    case 'points': case 'dollars': return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? null : 'The value is a number of 0 or more.';
    case 'percent': return typeof value === 'number' && value >= 0 && value <= 100 ? null : 'The value is a percent from 0 to 100.';
    case 'provider id': case 'route': return isText(value) ? null : 'The value is a name.';
    case 'list of words': case 'list of routes': case 'list of provider ids': return listOf(value, () => true) ? null : 'The value is a list of names.';
    case 'list of activities': return listOf(value, x => ACTIVITIES.includes(x as never)) ? null : `The value is a list of activities: ${ACTIVITIES.join(', ')}.`;
    default: return null;
  }
}

/**
 * Returns why a balance setting edit cannot be accepted, or null when it can. The path is one name per level (a route label stays whole, dots and slashes included).
 * "inherit" puts a setting back to the profile's own value. null removes one entry of a map, such as a tier, and is refused anywhere else.
 */
export function checkBalanceSetting(path: readonly string[], value: unknown): string | null {
  const rows = BALANCE_FIELDS.map(f => ({ pattern: f.path.split('.'), type: f.type }));
  const row = rows.find(r => matches(r.pattern, path));
  if (!row) {
    // A whole map entry, such as one route's preferences, can be removed by its parent path.
    const parent = value === null || value === 'inherit' ? rows.find(r => r.pattern.length > path.length && matches(r.pattern.slice(0, path.length), path) && r.pattern[path.length] === '<activity>') : undefined;
    return parent ? null : `${path.join('.') || '(empty)'} is not a balance setting. docs/configuring.md lists them.`;
  }
  if (value === 'inherit') return null;
  const mapEntry = row.pattern.some(p => p === '<route>' || p === '<activity>');
  if (value === null) return mapEntry ? null : `${path.join('.')} cannot be removed; give it a value or "inherit".`;
  return valueProblem(row.type, value);
}
