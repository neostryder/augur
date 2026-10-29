// The fleet reading: which machines Cogitator serves from, how full their memory is, and where each role's chain is being served.
import { obj, num } from './util.js';
import type { Snapshot } from './types.js';
import { readCogitatorKnowledge } from './cogitator-catalog.js';
import type { CogitatorKnowledge } from './cogitator-catalog.js';

export type FleetModelState = 'ready' | 'busy' | 'installed' | string;

export interface FleetModel extends CogitatorKnowledge {
  id: string;
  state: FleetModelState;
  memoryMb: number;
  /** Seconds since the model last served a request, when it is loaded and idle. */
  idleSecs: number | null;
  /** Why the model stepped aside for another, when it did. */
  yielded: string[];
}

export interface FleetMachine {
  name: string;
  /** True for the machine the gateway runs on. */
  self: boolean;
  up: boolean;
  error: string | null;
  checkedSecsAgo: number | null;
  /** Memory Cogitator may use on the machine, what it holds and what is free, in MB. Null when the machine reports none. */
  budgetMb: number | null;
  usedMb: number | null;
  freeMb: number | null;
  /** True when the free memory is short enough that a new model load would push another out. */
  pressure: boolean;
  models: FleetModel[];
}

export interface FleetRole extends CogitatorKnowledge {
  name: string;
  /** The links in order, each a model id with `@machine` when it runs on a peer. */
  chain: string[];
  refusesDegrade: boolean;
  /** Where the first available link sits (0 is the first), or null when no link can serve. */
  servingIndex: number | null;
  /** The machine and model of that link. */
  servingMachine: string | null;
  servingModel: string | null;
  /** True when a later link has to serve because an earlier one cannot. */
  degraded: boolean;
}

export interface FleetReading {
  /** The machine the gateway runs on. */
  self: string;
  machines: FleetMachine[];
  roles: FleetRole[];
}

/** What the phone gets: names, up or down, and the degraded roles. Nothing about memory, models or chains. */
export interface CompactFleet {
  machines: Array<{ name: string; up: boolean }>;
  degraded: string[];
}

/** A machine is under pressure when less than a tenth of its memory budget, and under 2 GB, is free. */
export const PRESSURE_FREE_FRACTION = 0.1;
export const PRESSURE_FREE_MB = 2048;

function readModels(ledger: Record<string, any>, body: unknown): FleetModel[] {
  const rows = Array.isArray(ledger.models) ? ledger.models : [];
  return rows.map(obj).filter(row => typeof row.id === 'string').map(row => ({
    id: String(row.id), state: typeof row.state === 'string' ? row.state : 'installed', memoryMb: num(row.memory_mb) ?? 0, idleSecs: num(row.idle_secs),
    yielded: Array.isArray(row.yielded) ? row.yielded.filter((v: unknown): v is string => typeof v === 'string') : [],
    ...readCogitatorKnowledge(body, row.id, false, row) }));
}

function readMachine(name: string, self: boolean, up: boolean, error: string | null, checkedSecsAgo: number | null, ledger: Record<string, any>, body: unknown): FleetMachine {
  const budgetMb = num(ledger.budget_mb), usedMb = num(ledger.used_mb), freeMb = num(ledger.free_mb);
  const pressure = freeMb !== null && budgetMb !== null && freeMb < Math.min(PRESSURE_FREE_MB, budgetMb * PRESSURE_FREE_FRACTION);
  return { name, self, up, error, checkedSecsAgo, budgetMb, usedMb, freeMb, pressure, models: readModels(ledger, body) };
}

/** Whether a chain link can serve now: its machine is up and the machine lists the model. A machine that reports no models cannot be checked, so it counts as able. */
function linkAvailable(link: string, self: string, machines: Map<string, FleetMachine>): { machine: string; model: string; ok: boolean } {
  const at = link.lastIndexOf('@');
  const model = at < 0 ? link : link.slice(0, at), machine = at < 0 ? self : link.slice(at + 1);
  const m = machines.get(machine);
  if (!m) return { machine, model, ok: false };
  if (!m.up) return { machine, model, ok: false };
  return { machine, model, ok: !m.models.length || m.models.some(row => row.id === model) };
}

/** Reads the answer of Cogitator's `GET /api/v1/hosts`. Anything missing reads as absent rather than failing the whole reading. */
export function readFleet(body: unknown): FleetReading {
  const doc = obj(body), me = obj(doc.self);
  const selfName = typeof me.name === 'string' && me.name ? me.name : 'this machine';
  const machines: FleetMachine[] = [readMachine(selfName, true, true, null, 0, obj(me.ledger), body)];
  for (const raw of Array.isArray(doc.peers) ? doc.peers : []) {
    const peer = obj(raw);
    if (typeof peer.name !== 'string' || !peer.name) continue;
    machines.push(readMachine(peer.name, false, peer.up !== false, typeof peer.error === 'string' ? peer.error : null, num(peer.checked_secs_ago), obj(peer.ledger), body));
  }
  const byName = new Map(machines.map(m => [m.name, m]));
  const roleRows = me.roles ?? obj(doc.catalog).roles ?? doc.roles;
  const roles: FleetRole[] = (Array.isArray(roleRows) ? roleRows : []).map(obj).filter(row => typeof row.name === 'string').map(row => {
    const chain = (Array.isArray(row.chain) ? row.chain : []).filter((v: unknown): v is string => typeof v === 'string');
    const found = chain.map(link => linkAvailable(link, selfName, byName));
    const at = found.findIndex(link => link.ok);
    return { name: String(row.name), chain, refusesDegrade: row.refuses_degrade === true, servingIndex: at < 0 ? null : at,
      servingMachine: at < 0 ? null : found[at]!.machine, servingModel: at < 0 ? null : found[at]!.model, degraded: at > 0,
      ...readCogitatorKnowledge(body, row.name, true, row) };
  });
  return { self: selfName, machines, roles };
}

/** The reading cut down to what a phone shows. */
export function compactFleet(fleet: FleetReading): CompactFleet {
  return { machines: fleet.machines.map(m => ({ name: m.name, up: m.up })), degraded: fleet.roles.filter(r => r.degraded || r.servingIndex === null).map(r => r.name) };
}

/** The fleet of a snapshot, as the Cogitator provider last read it, with the age of that reading. Null when the provider is off or has never answered. */
export function fleetOf(snap: Snapshot | null | undefined): { fleet: FleetReading; fetchedAt: string; stale: boolean } | null {
  const p = snap?.providers?.cogitator;
  const fleet = obj(p?.notes).fleet as FleetReading | undefined;
  return p && fleet && p.fetchedAt ? { fleet, fetchedAt: p.fetchedAt, stale: p.stale } : null;
}

/** The snapshot with the fleet cut to its compact form, for the phone sync. */
export function withCompactFleet(snap: Snapshot): Snapshot {
  const p = snap.providers.cogitator, fleet = obj(p?.notes).fleet as FleetReading | undefined;
  if (!p || !fleet) return snap;
  const { fleet: _full, ...rest } = obj(p.notes);
  return { ...snap, providers: { ...snap.providers, cogitator: { ...p, notes: { ...rest, fleetCompact: compactFleet(fleet) } } } };
}
