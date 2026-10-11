// The Local page and the dashboard card for local compute: what the Cogitator fleet reading says, in the words both apps show.
import { fleetOf } from '@augur/core';
import type { CompactFleet, FleetMachine, FleetReading, FleetRole, Snapshot } from '@augur/core';
import { ago } from './format.js';

export type LocalTone = 'ok' | 'warn' | 'cold' | 'down';

export const LOCAL_TEXT = {
  title: 'Local compute',
  open: 'Open',
  machines: 'Machines',
  loaded: 'Loaded models',
  roles: 'Roles and their chains',
  recent: 'Recent local jobs',
  noJobs: 'No local jobs yet.',
  noModels: 'No models listed on this machine.',
  noRoles: 'The gateway lists no roles.',
  empty: 'Add the Cogitator provider in settings to see your machines here.',
  waiting: 'Reading the fleet.',
  notReachable: 'Cogitator is not reachable. The last reading is shown.',
  phoneOnly: 'This device shows a summary. The machines and models are on the desktop.',
  columns: { model: 'Model', role: 'Role', held: 'Held', lastUsed: 'Last used' },
} as const;

/** One role as a chip: the name, where it is served, and a tone. */
export interface LocalChip { name: string; text: string; tone: LocalTone }

export interface LocalCard {
  /** "3 of 4 machines up". */
  summary: string;
  chips: LocalChip[];
  /** True when only the summary form is known, as on a phone, and the chips are the degraded roles alone. */
  compact: boolean;
  stale: boolean;
}

export interface LocalModelRow { id: string; role: string; state: string; held: string; lastUsed: string; loaded: boolean }
export interface LocalMachineRow {
  name: string; self: boolean; up: boolean; tone: LocalTone;
  /** Share of the memory budget held, 0 to 100, or null when the machine reports none. */
  usedPct: number | null;
  /** "41 of 64 GB free, 3 models loaded", or why the machine is down. */
  line: string;
  models: LocalModelRow[];
}
export interface LocalChainStep { text: string; machine: string; serving: boolean; up: boolean }
export interface LocalRoleRow { name: string; tone: LocalTone; chip: string; chain: LocalChainStep[]; refusesDegrade: boolean; note: string }
export interface LocalPage {
  summary: string; stale: boolean; checked: string;
  machines: LocalMachineRow[]; roles: LocalRoleRow[];
}

const gb = (mb: number): string => { const v = mb / 1024; return v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ''); };

function roleTone(r: FleetRole, fleet: FleetReading): LocalTone {
  if (r.servingIndex === null) return 'down';
  if (r.degraded) return 'warn';
  const machine = fleet.machines.find(m => m.name === r.servingMachine);
  return machine?.models.find(m => m.id === r.servingModel)?.state === 'installed' ? 'cold' : 'ok';
}

function chipText(r: FleetRole, tone: LocalTone): string {
  return tone === 'down' ? `${r.name} down` : tone === 'cold' ? `${r.name} cold` : tone === 'warn' ? `${r.name} ${r.servingMachine}, degraded` : `${r.name} ${r.servingMachine}`;
}

const summaryOf = (up: number, total: number): string => `${up} of ${total} ${total === 1 ? 'machine' : 'machines'} up`;

/** The dashboard card from a snapshot. Null when the Cogitator provider is off or has not answered yet. */
export function localCard(snap: Snapshot | null | undefined): LocalCard | null {
  const f = fleetOf(snap);
  if (f) {
    const chips = f.fleet.roles.map(r => { const tone = roleTone(r, f.fleet); return { name: r.name, text: chipText(r, tone), tone }; });
    return { summary: summaryOf(f.fleet.machines.filter(m => m.up).length, f.fleet.machines.length), chips, compact: false, stale: f.stale };
  }
  // A phone gets names, up or down, and the degraded roles.
  const p = snap?.providers.cogitator, compact = (p?.notes as { fleetCompact?: CompactFleet } | undefined)?.fleetCompact;
  if (!p || !compact) return null;
  return { summary: summaryOf(compact.machines.filter(m => m.up).length, compact.machines.length), compact: true, stale: p.stale,
    chips: compact.degraded.map(name => ({ name, text: `${name}, degraded`, tone: 'warn' as const })) };
}

function machineRow(m: FleetMachine, roles: FleetRole[]): LocalMachineRow {
  const roleOf = (id: string): string => roles.filter(r => r.chain.some(link => { const at = link.lastIndexOf('@'); return (at < 0 ? link : link.slice(0, at)) === id && (at < 0 ? m.self : link.slice(at + 1) === m.name); })).map(r => r.name).join(', ');
  const models: LocalModelRow[] = m.models.map(row => ({
    id: row.id, role: roleOf(row.id), state: row.state === 'ready' ? 'ready' : row.state === 'busy' ? 'in use' : 'not loaded',
    held: row.state === 'installed' ? '' : `${gb(row.memoryMb)} GB`,
    lastUsed: row.state === 'busy' ? 'now' : row.idleSecs === null ? '' : row.idleSecs < 60 ? `${Math.round(row.idleSecs)} s ago` : `${Math.round(row.idleSecs / 60)} min ago`, loaded: row.state !== 'installed' }))
    .sort((a, b) => Number(b.loaded) - Number(a.loaded));
  const loaded = models.filter(x => x.loaded).length;
  const line = !m.up ? (m.error ? `down: ${m.error}` : 'down')
    : m.freeMb === null || m.budgetMb === null ? `${loaded} ${loaded === 1 ? 'model' : 'models'} loaded`
    : `${gb(m.freeMb)} of ${gb(m.budgetMb)} GB free, ${loaded} ${loaded === 1 ? 'model' : 'models'} loaded${m.pressure ? ', memory pressure' : ''}`;
  return { name: m.name, self: m.self, up: m.up, tone: !m.up ? 'down' : m.pressure ? 'warn' : 'ok',
    usedPct: m.up && m.budgetMb && m.usedMb !== null ? Math.min(100, Math.round(m.usedMb / m.budgetMb * 100)) : null, line, models };
}

function chainOf(r: FleetRole, fleet: FleetReading): LocalChainStep[] {
  return r.chain.map((link, i) => {
    const at = link.lastIndexOf('@'), machine = at < 0 ? fleet.self : link.slice(at + 1), m = fleet.machines.find(x => x.name === machine);
    return { text: machine, machine, serving: r.servingIndex === i, up: m?.up ?? false };
  });
}

/** The Local page from a snapshot. Null when the Cogitator provider is off or has never answered. */
export function localPage(snap: Snapshot | null | undefined, now = Date.now()): LocalPage | null {
  const f = fleetOf(snap);
  if (!f) return null;
  const roles: LocalRoleRow[] = f.fleet.roles.map(r => {
    const tone = roleTone(r, f.fleet);
    const note = r.servingIndex === null ? (r.refusesDegrade ? 'Waiting for its machine. This role never falls back.' : 'No machine in its chain can serve it now.')
      : r.degraded ? 'Served from a later link, because an earlier machine cannot serve it.' : '';
    return { name: r.name, tone, chip: chipText(r, tone), chain: chainOf(r, f.fleet), refusesDegrade: r.refusesDegrade, note };
  });
  return { summary: summaryOf(f.fleet.machines.filter(m => m.up).length, f.fleet.machines.length), stale: f.stale, checked: ago(f.fetchedAt, now),
    machines: f.fleet.machines.map(m => machineRow(m, f.fleet.roles)), roles };
}
