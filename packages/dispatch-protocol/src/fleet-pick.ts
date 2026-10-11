// How the live Cogitator fleet reading bears on a pick. Pure. A local route has no usage meter, so its usage factor stays 1; the reading gates and nudges instead.
import type { FleetMachine, FleetReading, PolicyFile } from '@augur/core';
import { PACE } from './pace.js';
import type { UsageSnapshot } from './pace.js';

/** The provider id local models are listed under, in the rules and in the usage file. */
export const LOCAL_PROVIDER = 'cogitator';
/** A model that is installed but not loaded has to load first, and a machine short of memory has to push something out to do it. */
export const COLD_FACTOR = 0.7;
export const PRESSURE_FACTOR = 0.8;

export interface LocalReading {
  /** Set when the route cannot run now. */
  blocked?: string;
  /** What the pick multiplies the score by, 1 when the reading changes nothing. */
  factor: number;
  /** A short reason for a nudge, empty when there is none. */
  why: string;
}

/** The fleet and its state from the usage file, or why local routes cannot be told apart: `gone` when the gateway cannot be reached, null when there is no usable reading. */
function readingOf(usage: UsageSnapshot | null, now: Date): { fleet: FleetReading } | { gone: string } | null {
  const p = usage?.providers[LOCAL_PROVIDER];
  if (!p) return null;
  // A gateway that cannot be reached means every local route fails, so none of them is offered while it lasts. A missing key is a different state: the routes use their own key.
  if (p.stale && typeof p.error === 'string' && p.error.startsWith('Could not reach')) return { gone: 'Cogitator is not reachable' };
  const fleet = p.notes?.fleet;
  if (!fleet || !p.fetchedAt) return null;
  const ageMin = (now.getTime() - new Date(p.fetchedAt).getTime()) / 60000;
  return ageMin > PACE.ignoreMin ? null : { fleet };
}

/** Where a role or model is served and in what state, or null when the reading does not know the name. */
function place(fleet: FleetReading, id: string): { machine: FleetMachine | null; cold: boolean; label: string } | { down: string } | null {
  const role = fleet.roles.find(r => r.name === id);
  if (role) {
    if (role.servingIndex === null) return { down: `no machine can serve ${id} now` };
    const machine = fleet.machines.find(m => m.name === role.servingMachine) ?? null;
    const model = machine?.models.find(m => m.id === role.servingModel);
    return { machine, cold: !!model && model.state === 'installed', label: `${id} on ${role.servingMachine}` };
  }
  const holders = fleet.machines.filter(m => m.models.some(row => row.id === id));
  if (!holders.length) return null;
  const up = holders.filter(m => m.up);
  if (!up.length) return { down: `${holders.map(m => m.name).join(' and ')} ${holders.length === 1 ? 'is' : 'are'} down` };
  const loaded = up.find(m => m.models.some(row => row.id === id && row.state !== 'installed'));
  const machine = loaded ?? up[0] as FleetMachine;
  return { machine, cold: !loaded, label: `${id} on ${machine.name}` };
}

/** What the fleet reading says about one local model of the rules, by the id the gateway knows it as. Null when the reading is silent about it. */
export function localReading(usage: UsageSnapshot | null, id: string, now = new Date()): LocalReading | null {
  const read = readingOf(usage, now);
  if (!read) return null;
  if ('gone' in read) return { blocked: read.gone, factor: 1, why: '' };
  const at = place(read.fleet, id);
  if (!at) return null;
  if ('down' in at) return { blocked: at.down, factor: 1, why: '' };
  const parts: string[] = [];
  let factor = 1;
  if (at.cold) { factor *= COLD_FACTOR; parts.push(`${at.label} is not loaded`); }
  if (at.machine?.pressure) { factor *= PRESSURE_FACTOR; parts.push(`${at.machine.name} is short of memory`); }
  return { factor, why: parts.join(', ') };
}

/** The gateway id a local model of the rules is known by. */
export function localId(policy: PolicyFile, model: string): string | null {
  const m = policy.providers[LOCAL_PROVIDER]?.models[model];
  return m ? m.id || model : null;
}
