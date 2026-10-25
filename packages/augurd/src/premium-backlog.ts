import { randomUUID } from 'node:crypto';
import { existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DataTier, OutputMode } from '@augur/core';
import type { ToolTier } from '@augur/dispatch-protocol';
import { withFileLock } from './file-lock.js';

export type BacklogStatus = 'awaiting-approval' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
export interface BacklogItem {
  id: string; createdAt: string; author: 'owner' | 'agent'; requester: string; repo: string; task: string; prompt: { text?: string; file?: string };
  activity: string; data: DataTier; route: string; lower?: string; estimate?: number; deadline?: string; cwd: string;
  tools: ToolTier; output: OutputMode; status: BacklogStatus; statusLog: Array<{ at: string; status: BacklogStatus; note: string }>;
  provider?: string; result?: { jobId: string; cost: number | null };
}

const statuses: BacklogStatus[] = ['awaiting-approval', 'queued', 'running', 'done', 'failed', 'cancelled', 'expired'];
const tiers = ['public', 'internal', 'sensitive', 'regulated'];
const toolTiers = ['read', 'write', 'full'];
const outputs = ['write_files', 'patch_only', 'text_only'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function validateBacklogItem(value: unknown): string[] {
  if (!object(value)) return ['Item must be an object.'];
  const problems: string[] = [];
  for (const key of ['requester', 'repo', 'task', 'activity', 'route', 'cwd']) if (typeof value[key] !== 'string' || !value[key]) problems.push(`${key} is required.`);
  if (value.lower !== undefined && typeof value.lower !== 'string') problems.push('lower must be a string.');
  if (typeof value.cwd === 'string' && !isAbsolute(value.cwd)) problems.push('cwd must be an absolute path to an existing directory.');
  if (!tiers.includes(String(value.data))) problems.push('data must be a known data tier.');
  if (!toolTiers.includes(String(value.tools))) problems.push('tools must be read, write or full.');
  if (!outputs.includes(String(value.output))) problems.push('output must be write_files, patch_only or text_only.');
  if (value.estimate !== undefined && (typeof value.estimate !== 'number' || !Number.isFinite(value.estimate) || value.estimate < 0 || value.estimate > 100)) problems.push('estimate must be 0 to 100 points of the provider weekly allowance.');
  if (value.deadline !== undefined && (typeof value.deadline !== 'string' || !Number.isFinite(Date.parse(value.deadline)))) problems.push('deadline must be an ISO date.');
  if (!object(value.prompt) || (typeof value.prompt.text !== 'string' && typeof value.prompt.file !== 'string')) problems.push('prompt needs text or file.');
  if (value.prompt && object(value.prompt) && typeof value.prompt.text === 'string' && typeof value.prompt.file === 'string') problems.push('prompt takes text or file, not both.');
  return problems;
}

export class PremiumBacklog {
  readonly path: string;
  constructor(home: string, private now: () => number = Date.now) { this.path = join(home, 'premium-backlog.jsonl'); }
  list(status?: BacklogStatus): BacklogItem[] { return this.read().rows.filter(item => !status || item.status === status); }
  invalidCount(): number { return this.read().invalid.length; }
  add(value: unknown, author: 'owner' | 'agent' = 'owner'): BacklogItem | { error: string } {
    const problems = validateBacklogItem(value);
    if (object(value) && typeof value.cwd === 'string') { try { if (!statSync(value.cwd).isDirectory()) problems.push('cwd must be an absolute path to an existing directory.'); } catch { problems.push('cwd must be an absolute path to an existing directory.'); } }
    if (problems.length) return { error: problems.join(' ') };
    const input = value as Omit<BacklogItem, 'id' | 'createdAt' | 'author' | 'status' | 'statusLog'>;
    return this.change(data => {
      const at = new Date(this.now()).toISOString(), status = author === 'owner' ? 'queued' : 'awaiting-approval';
      const item: BacklogItem = { ...input, id: randomUUID(), createdAt: at, author, status, statusLog: [{ at, status, note: 'added' }] };
      data.rows.push(item); return item;
    });
  }
  approve(id: string): BacklogItem | null {
    return this.change(data => { const item = data.rows.find(row => row.id === id); if (!item || item.status !== 'awaiting-approval' || item.deadline && Date.parse(item.deadline) <= this.now()) return null; this.set(item, 'queued', 'approved by owner'); return item; });
  }
  update(id: string, status: BacklogStatus, note: string, result?: BacklogItem['result'], provider?: string, once = false): BacklogItem | null {
    return this.change(data => { const item = data.rows.find(row => row.id === id); if (!item) return null; item.status = status; if (item.statusLog.at(-1)?.note !== note && (!once || !item.statusLog.some(row => row.note === note))) item.statusLog.push({ at: new Date(this.now()).toISOString(), status, note }); if (result) item.result = result; if (provider) item.provider = provider; return item; });
  }
  drop(id: string): boolean { return this.change(data => { const n = data.rows.length; data.rows = data.rows.filter(item => item.id !== id); return data.rows.length !== n; }); }
  reconcile(job: (id: string, itemId: string) => { id?: string; state: string; provider?: string } | null): void {
    this.change(data => { for (const item of data.rows.filter(row => row.status === 'running')) { const jobId = item.result?.jobId, found = job(jobId ?? '', item.id);
      if (found && ['completed', 'failed', 'artifact_validation_failed', 'cancelled', 'killed', 'lost'].includes(found.state)) this.set(item, found.state === 'completed' ? 'done' : found.state === 'cancelled' ? 'cancelled' : 'failed', found.state);
      else if (found) { if (!item.result?.jobId) item.result = { jobId: found.id ?? '', cost: null }; if (found.provider) item.provider = found.provider; }
      else this.set(item, 'queued', 'service restarted');
    } });
  }
  private set(item: BacklogItem, status: BacklogStatus, note: string): void { item.status = status; item.statusLog.push({ at: new Date(this.now()).toISOString(), status, note }); }
  private read(): { rows: BacklogItem[]; invalid: string[] } {
    if (!existsSync(this.path)) return { rows: [], invalid: [] };
    try { const rows: BacklogItem[] = [], invalid: string[] = []; for (const line of readFileSync(this.path, 'utf8').split('\n').filter(Boolean)) { try { const row = JSON.parse(line); if (object(row) && statuses.includes(row.status as BacklogStatus) && ['owner', 'agent'].includes(String(row.author)) && !validateBacklogItem(row).length) rows.push(row as unknown as BacklogItem); else invalid.push(line); } catch { invalid.push(line); } } return { rows, invalid }; } catch { return { rows: [], invalid: [] }; }
  }
  private change<T>(fn: (data: { rows: BacklogItem[]; invalid: string[] }) => T): T {
    return withFileLock(this.path, () => { const data = this.read(), result = fn(data); this.write(data); return result; });
  }
  private write(data: { rows: BacklogItem[]; invalid: string[] }): void {
    const tmp = `${this.path}.${randomUUID()}.tmp`, body = [...data.rows.map(row => JSON.stringify(row)), ...data.invalid].join('\n') + (data.rows.length || data.invalid.length ? '\n' : '');
    let fd: number | null = null;
    try { fd = openSync(tmp, 'wx'); writeFileSync(fd, body, 'utf8'); fsyncSync(fd); closeSync(fd); fd = null; renameSync(tmp, this.path); }
    catch (error) { if (fd !== null) closeSync(fd); try { unlinkSync(tmp); } catch { /* no temporary file remains */ } throw error; }
  }
}
