// The seats a pick names beside its model: a second opinion, a free web route to drive from the browser, and the local model that shadows the decision. Pure.
import type { ActivityId, PolicyFile } from '@augur/core';
import { resolveBalance } from './balance.js';

export interface Seat { model: string; why: string }
export interface WebSeat extends Seat {
  /** What the calling session does with the route, since a browser route is driven by the caller and not run by Augur. */
  how: string;
}
export interface Seats { second?: Seat; web?: WebSeat; shadow?: Seat }

const confirmed = (policy: PolicyFile, label: string): boolean => Object.values(policy.providers).some(p => p.models[label]?.status === 'confirmed');

/** The folder under `~/.augur` where a task's web route is handed its brief and returns its result, named by the kind of work and the minute so two tasks never share one. */
export const webFolder = (activity: ActivityId, now: Date): string => `~/.augur/web/${activity}-${now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`;

const webHandoff = (web: string, activity: ActivityId, now: Date): string => {
  const dir = webFolder(activity, now);
  return `Create ${dir}, write the task and its context to ${dir}/brief.md, give that file to ${web} in the browser, and save what it returns as ${dir}/result.md for the task to read.`;
};

/**
 * `ranking` is the permitted models best first, so a seat is only ever filled by a model that passed every rule for this task.
 * The shadow is the exception: it does not take the task, it only answers beside the pick, and a decision by Jev or by the shadow itself needs none.
 */
export function seatsFor(policy: PolicyFile, ranking: ReadonlyArray<{ model: string }>, pick: string | null, activity: ActivityId, now: Date = new Date()): Seats {
  const rules = resolveBalance((policy as { balance?: unknown }).balance);
  if (!rules.enabled || !pick) return {};
  const out: Seats = {};
  const allowed = new Set(ranking.map(r => r.model));
  if (!rules.seats.second.skip.includes(activity)) {
    const model = rules.seats.second.models.find(m => m !== pick && allowed.has(m));
    if (model) out.second = { model, why: 'a second opinion from a route with plenty of room' };
  }
  const web = (rules.seats.web[activity] ?? []).find(m => m !== pick && allowed.has(m));
  if (web) out.web = { model: web, why: 'a free web route that suits this kind of task', how: webHandoff(web, activity, now) };
  if (rules.seats.shadow && rules.seats.shadow !== pick && pick !== rules.seats.jev.route && confirmed(policy, rules.seats.shadow)) out.shadow = { model: rules.seats.shadow, why: 'the local model answers the same decision, and the two answers are compared' };
  return out;
}

/** The seats as plain lines for a command or a tool to print under the pick. */
export function seatLines(seats: Seats): string[] {
  const out: string[] = [];
  if (seats.second) out.push(`Second opinion: ${seats.second.model}, ${seats.second.why}.`);
  if (seats.web) out.push(`Web: ${seats.web.model}, ${seats.web.why}. ${seats.web.how}`);
  if (seats.shadow) out.push(`Shadow: ${seats.shadow.model}, ${seats.shadow.why}.`);
  return out;
}
