import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './home-files.js';

export type ProseStatus = 'queued' | 'awaiting-approval' | 'running' | 'drafted' | 'failed';
export interface ProseItem {
  dataTier: 'public' | 'internal' | 'sensitive' | 'regulated';
  id: string; createdAt: string; requester: string; repo: string; target: string; kind: 'write' | 'rewrite' | 'review' | 'sweep-edit';
  surface: 'README' | 'changelog' | 'ui-strings' | 'post' | 'doc' | 'other'; audience: string; voice: string; limits: { length?: string; format?: string };
  facts: Array<{ text: string; source: string }>; mustInclude: string[]; mustAvoid: string[]; currentText?: string;
  context: { before?: string; after?: string; outline?: string; samples?: string; glossary?: string }; urgency: 'normal' | 'urgent';
  status: ProseStatus; statusLog: Array<{ at: string; status: ProseStatus; note: string }>; result?: { text: string; modelId: string; cost: number | null; runId: string };
}

const KINDS = ['write', 'rewrite', 'review', 'sweep-edit'];
const STATUSES: ProseStatus[] = ['queued', 'awaiting-approval', 'running', 'drafted', 'failed'];
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
function firstJsonArray(text: string): string | null {
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '[') { if (depth === 0) start = i; depth++; }
    else if (c === ']' && depth > 0 && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseProseItem(raw: unknown, now = new Date()): ProseItem | { error: string } {
  if (!object(raw)) return { error: 'A prose item must be an object.' };
  if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind)) return { error: 'A prose kind must be write, rewrite, review or sweep-edit.' };
  if ((raw.kind === 'rewrite' || raw.kind === 'review') && typeof raw.currentText !== 'string') return { error: 'A rewrite or review needs currentText.' };
  for (const key of ['requester', 'repo', 'target', 'audience', 'voice'] as const) if (typeof raw[key] !== 'string' || !raw[key]) return { error: `A prose item needs ${key}.` };
  if (!['README', 'changelog', 'ui-strings', 'post', 'doc', 'other'].includes(String(raw.surface))) return { error: 'A prose surface is not known.' };
  if (raw.urgency !== undefined && raw.urgency !== 'normal' && raw.urgency !== 'urgent') return { error: 'Urgency must be normal or urgent.' };
  if (raw.dataTier !== undefined && !['public', 'internal', 'sensitive', 'regulated'].includes(String(raw.dataTier))) return { error: 'dataTier must be public, internal, sensitive or regulated.' };
  if (object(raw.limits) && Object.keys(raw.limits).some(k => !['length', 'format'].includes(k))) return { error: 'Limits may contain only length and format.' };
  const facts = raw.facts ?? [];
  if (!Array.isArray(facts) || !facts.every((f: unknown) => object(f) && typeof f.text === 'string' && !!f.text && typeof f.source === 'string' && !!f.source)) return { error: 'Facts need text and source.' };
  if (!strings(raw.mustInclude ?? []) || !strings(raw.mustAvoid ?? [])) return { error: 'Term lists and blocks must contain strings.' };
  if (raw.limits !== undefined && (!object(raw.limits) || (raw.limits.length !== undefined && typeof raw.limits.length !== 'string') || (raw.limits.format !== undefined && typeof raw.limits.format !== 'string'))) return { error: 'Limits need string length and format values.' };
  if (raw.context !== undefined && (!object(raw.context) || ['before', 'after', 'outline', 'samples', 'glossary'].some(k => raw.context && (raw.context as Record<string, unknown>)[k] !== undefined && typeof (raw.context as Record<string, unknown>)[k] !== 'string'))) return { error: 'Context values must be strings.' };
  const status: ProseStatus = raw.urgency === 'urgent' ? 'awaiting-approval' : 'queued';
  return { dataTier: (raw.dataTier as ProseItem['dataTier'] | undefined) ?? 'internal', id: randomUUID(), createdAt: now.toISOString(), requester: raw.requester as string, repo: raw.repo as string, target: raw.target as string, kind: raw.kind as ProseItem['kind'], surface: raw.surface as ProseItem['surface'], audience: raw.audience as string, voice: raw.voice as string,
    limits: object(raw.limits) ? raw.limits as ProseItem['limits'] : {}, facts: facts as ProseItem['facts'], mustInclude: (raw.mustInclude ?? []) as string[], mustAvoid: (raw.mustAvoid ?? []) as string[],
    ...(typeof raw.currentText === 'string' ? { currentText: raw.currentText } : {}), context: object(raw.context) ? raw.context as ProseItem['context'] : {}, urgency: raw.urgency === 'urgent' ? 'urgent' : 'normal',
    status, statusLog: [{ at: now.toISOString(), status, note: 'Added to queue.' }] };
}

export class ProseQueue {
  readonly path: string;
  private locked = false;
  constructor(home: string, private now: () => number = Date.now, private runGroup?: (items: ProseItem[], prompt: string, caller: { kind: 'cli' | 'service'; label: string; interactive?: boolean }) => Promise<{ text: string; modelId: string; cost: number | null; runId: string }>, private batchSize = 10, private batchHours = 24) { this.path = join(home, 'prose-queue.jsonl'); }
  list(status?: ProseStatus): ProseItem[] { let text = ''; try { text = readFileSync(this.path, 'utf8'); } catch { return []; } return text.split(/\r?\n/).filter(Boolean).flatMap(line => { try { const x: unknown = JSON.parse(line); return object(x) && typeof x.status === 'string' && STATUSES.includes(x.status as ProseStatus) && (!status || x.status === status) ? [x as unknown as ProseItem] : []; } catch { return []; } }); }
  private save(items: ProseItem[]): void { atomicWrite(this.path, items.map(x => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''), 0o600); }
  private mergeOwned(owned: ProseItem[]): void { const ids = new Set(owned.map(x => x.id)); const latest = this.list().filter(x => !ids.has(x.id)); this.save([...latest, ...owned]); }
  private lockedWrite<T>(work: () => T): T { if (this.locked) throw new Error('Prose queue write is already in progress.'); this.locked = true; try { return work(); } finally { this.locked = false; } }
  resetRunning(): void { this.lockedWrite(() => { const rows = this.list(); let changed = false; for (const item of rows) if (item.status === 'running') { this.change(item, 'queued', 'Service restarted before the run finished.'); changed = true; } if (changed) this.save(rows); }); }
  add(raw: unknown, holdForApproval = false): ProseItem | { error: string } { return this.lockedWrite(() => { const item = parseProseItem(raw, new Date(this.now())); if ('error' in item) return item; if (holdForApproval && item.status !== 'awaiting-approval') this.change(item, 'awaiting-approval', 'Held for owner approval.'); const rows = this.list(); rows.push(item); this.save(rows); return item; }); }
  status(): { counts: Record<ProseStatus, number>; oldestAgeMs: number | null; due: boolean } { const rows = this.list(), queued = rows.filter(x => x.status === 'queued' && x.urgency === 'normal'); const dates = queued.map(x => Date.parse(x.createdAt)).filter(Number.isFinite); const oldest = dates.length ? Math.min(...dates) : null; return { counts: Object.fromEntries(STATUSES.map(s => [s, rows.filter(x => x.status === s).length])) as Record<ProseStatus, number>, oldestAgeMs: oldest === null ? null : Math.max(0, this.now() - oldest), due: queued.length >= this.batchSize || (oldest !== null && this.now() - oldest >= this.batchHours * 3600000) }; }
  approve(id: string): ProseItem | { error: string } { return this.lockedWrite(() => { const rows = this.list(), item = rows.find(x => x.id === id); if (!item) return { error: 'No prose item with that id.' }; if (item.status !== 'awaiting-approval') return { error: 'That prose item is not awaiting approval.' }; this.change(item, 'queued', 'Approved by owner.'); this.save(rows); return item; }); }
  private change(item: ProseItem, status: ProseStatus, note: string): void { item.status = status; item.statusLog.push({ at: new Date(this.now()).toISOString(), status, note }); }
  run(dryRun = false, automatic = false, caller?: { kind: 'cli' | 'service'; label: string; interactive?: boolean }): { started: boolean; batchId?: string; items?: string[]; reason?: string } { return this.lockedWrite(() => this.runLocked(dryRun, automatic, caller)); }
  private runLocked(dryRun = false, automatic = false, caller?: { kind: 'cli' | 'service'; label: string; interactive?: boolean }): { started: boolean; batchId?: string; items?: string[]; reason?: string } {
    if (!dryRun && !automatic && !caller) return { started: false, reason: 'The owner CLI caller was not attested.' };
    const rows = this.list(), status = this.status(), approved = rows.filter(x => x.status === 'queued' && x.urgency === 'urgent'), normal = rows.filter(x => x.status === 'queued' && x.urgency === 'normal');
    if (automatic && !approved.length && rows.some(x => x.status === 'awaiting-approval' && x.urgency === 'urgent')) return { started: false, reason: 'Urgent items require an owner run.' };
    if (!approved.length && !status.due) return { started: false, reason: 'The batch is not due.' };
    if (!approved.length && !normal.length) return { started: false, reason: 'No queued items.' };
    const selected = approved.length ? approved : normal.slice(0, this.batchSize);
    if (dryRun) return { started: false, reason: `${selected.length} item(s) would run.` };
    if (!this.runGroup) return { started: false, reason: 'No prose runner is configured.' };
    const groups = new Map<string, ProseItem[]>(); for (const item of selected) { const key = item.dataTier; groups.set(key, [...(groups.get(key) ?? []), item]); }
    const latest = this.list(), latestById = new Map(latest.map(x => [x.id, x])); for (const item of selected) { const current = latestById.get(item.id); if (current?.status === 'queued') { this.change(current, 'running', 'Run submitted.'); Object.assign(item, current); } } this.save(latest);
    const batchId = randomUUID();
    void this.processGroups(groups, caller ?? { kind: 'service', label: 'prose-queue' });
    return { started: true, batchId, items: selected.map(x => x.id) };
  }
  private async processGroups(groups: Map<string, ProseItem[]>, caller: { kind: 'cli' | 'service'; label: string; interactive?: boolean }): Promise<void> {
    for (const group of groups.values()) {
      const prompt = `Voice: ${group[0]?.voice}\nReturn only a JSON array of {"id":"...","text":"..."}. Follow each item's facts, terms, limits and context.\n${JSON.stringify(group)}`;
      try {
        const result = await this.runGroup!(group, prompt, caller);
        const fenced = result.text.replace(/```(?:json)?\s*([\s\S]*?)```/i, '$1');
        const array = firstJsonArray(fenced);
        if (!array) throw new Error('Model reply has no JSON array.');
        const parsed: unknown = JSON.parse(array);
        if (!Array.isArray(parsed)) throw new Error('Reply is not a JSON array.');
        const mapped = new Map<string, unknown>(); for (const entry of parsed) { if (!object(entry) || typeof entry.id !== 'string' || typeof entry.text !== 'string' || mapped.has(entry.id)) continue; mapped.set(entry.id, entry.text); }
        for (const item of group) { const text = mapped.get(item.id); if (typeof text !== 'string') this.change(item, 'failed', 'Model reply omitted or malformed item.'); else { item.result = { ...result, text }; this.change(item, 'drafted', 'Draft received.'); } }
      } catch (e) { for (const item of group) this.change(item, 'failed', e instanceof Error ? e.message : String(e)); }
      this.lockedWrite(() => this.mergeOwned(group));
    }
  }

}
