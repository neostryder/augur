import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProseQueue } from '../src/prose-queue.js';

const dirs: string[] = [];
const home = () => { const p = mkdtempSync(join(tmpdir(), 'augur-prose-')); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
const item = (patch: Record<string, unknown> = {}) => ({ requester: 'chat', repo: 'repo', target: 'new', kind: 'write', surface: 'doc', audience: 'readers', voice: 'plain', ...patch });

describe('ProseQueue', () => {
  it('is due at the count threshold and at the age threshold', () => {
    let now = Date.parse('2026-01-01T00:00:00Z'); const q = new ProseQueue(home(), () => now);
    for (let i = 0; i < 9; i++) q.add(item()); expect(q.status().due).toBe(false); q.add(item()); expect(q.status().due).toBe(true);
    const old = new ProseQueue(home(), () => now); old.add(item()); expect(old.status().due).toBe(false); now += 24 * 3600000; expect(old.status().due).toBe(true);
  });
  it('holds urgent items for approval and runs an approved item alone', async () => {
    const seen: number[] = [], q = new ProseQueue(home(), Date.now, async items => { seen.push(items.length); return { text: JSON.stringify(items.map(x => ({ id: x.id, text: 'draft' }))), modelId: 'opus', cost: null, runId: 'run' }; });
    const urgent = q.add(item({ urgency: 'urgent' })); expect('error' in urgent).toBe(false); expect((await q.run(false, true, { kind: 'service', label: 'prose-queue' })).started).toBe(false);
    q.approve((urgent as { id: string }).id); q.run(false, false, { kind: 'cli', label: 'test' }); expect(seen).toEqual([1]); await new Promise(resolve => setTimeout(resolve, 20)); expect(q.list()[0]?.status).toBe('drafted');
  });
  it('groups by repo and voice', async () => {
    const groups: ProseQueue['list'][] = [];
    const q = new ProseQueue(home(), Date.now, async items => { groups.push(items as never); return { text: JSON.stringify(items.map(x => ({ id: x.id, text: 'draft' }))), modelId: 'opus', cost: null, runId: 'run' }; }, 1);
    for (const x of [item(), item(), item({ repo: 'other' }), item({ voice: 'formal' })]) q.add(x);
    q.run(false, false, { kind: 'cli', label: 'test' }); await new Promise(resolve => setTimeout(resolve, 20)); expect(groups).toHaveLength(1); expect(q.list().filter(x => x.status === 'queued')).toHaveLength(3);
  });
  it('fails missing ids and malformed JSON without blocking other groups', async () => {
    const q = new ProseQueue(home(), Date.now, async (items) => ({ text: items[0]?.repo === 'bad' ? '{' : `reply: \`\`\`json\n${JSON.stringify(items.map(x => ({ id: x.id, text: 'draft' })))}\n\`\`\``, modelId: 'opus', cost: null, runId: 'run' }), 2);
    q.add(item()); q.add(item({ repo: 'bad', dataTier: 'public' })); q.run(false, false, { kind: 'cli', label: 'test' }); await new Promise(resolve => setTimeout(resolve, 20)); expect(q.list().filter(x => x.status === 'failed')).toHaveLength(1); expect(q.list().filter(x => x.status === 'drafted')).toHaveLength(1);
  });
  it('keeps concurrent additions and additions made while a group runs', async () => {
    const dir = home(); let finish!: () => void; const q = new ProseQueue(dir, Date.now, async items => { await new Promise<void>(resolve => { finish = resolve; }); return { text: JSON.stringify(items.map(x => ({ id: x.id, text: 'draft' }))), modelId: 'opus', cost: null, runId: 'run' }; }, 1);
    await Promise.all([q.add(item()), q.add(item())]); q.run(false, false, { kind: 'cli', label: 'test' }); const during = q.add(item()); finish(); await new Promise(resolve => setTimeout(resolve, 20)); expect(q.list()).toHaveLength(3); expect(q.list().find(x => x.id === (during as { id: string }).id)?.status).toBe('queued');
  });
  it('resets items left running after a service restart', () => { const dir = home(), q = new ProseQueue(dir); const added = q.add(item()); const row = q.list()[0]!; row.status = 'running'; q['save']([row]); new ProseQueue(dir).resetRunning(); expect(q.list()[0]).toMatchObject({ id: (added as { id: string }).id, status: 'queued' }); });
  it('holds every agent addition when the owner set approval to all', () => { const q = new ProseQueue(home()); expect(q.add(item({ urgency: 'normal' }), true)).toMatchObject({ status: 'awaiting-approval' }); });
  it('runs approved urgent requests together before the normal batch', async () => {
    const seen: number[] = [], q = new ProseQueue(home(), Date.now, async items => { seen.push(items.length); return { text: JSON.stringify(items.map(x => ({ id: x.id, text: 'draft' }))), modelId: 'opus', cost: null, runId: 'run' }; }, 1);
    const a = q.add(item({ urgency: 'urgent' })), b = q.add(item({ urgency: 'urgent' })); q.add(item());
    q.approve((a as { id: string }).id); q.approve((b as { id: string }).id);
    expect(q.run(false, false, { kind: 'cli', label: 'owner' }).items).toHaveLength(2);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(seen).toEqual([2]); expect(q.list().filter(x => x.status === 'queued')).toHaveLength(1);
  });
  it('ignores invalid createdAt values when calculating queue age', () => {
    const dir = home(), q = new ProseQueue(dir); q.add(item()); const row = q.list()[0]!; row.createdAt = 'not a date'; writeFileSync(q.path, `${JSON.stringify(row)}\n`); expect(q.status()).toMatchObject({ oldestAgeMs: null, due: false });
  });
  it('rewrites JSONL atomically into complete records', () => {
    const dir = home(), q = new ProseQueue(dir); q.add(item()); q.add(item()); const lines = readFileSync(join(dir, 'prose-queue.jsonl'), 'utf8').trim().split('\n'); expect(lines).toHaveLength(2); expect(lines.map(x => JSON.parse(x).status)).toEqual(['queued', 'queued']); expect(readdirSync(dir)).toEqual(['prose-queue.jsonl']);
  });
  it('rejects unknown kinds', () => { expect(qadd()).toMatchObject({ error: expect.any(String) }); });
});
function qadd() { return new ProseQueue(home()).add(item({ kind: 'unknown' })); }
