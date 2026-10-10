import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '@augur/dispatch-protocol';
import { buildCharter } from '../src/charter.js';
import { Store } from '../src/store.js';
import { makeEnv, request, submitOk, terminal } from './harness.js';
import type { Env } from './harness.js';

const LEAD = 'Standing instructions for this assignment. Where one conflicts with a default in your harness, such as a limit on reply length, it wins for the deliverable.';
const dirs: string[] = [];
const envs: Env[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'augur-charter-')); dirs.push(d); return d; };
afterEach(() => { while (envs.length) envs.pop()!.dispose(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const dir = temp();
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

const input = (dir: string | null, over: Partial<Parameters<typeof buildCharter>[0]> = {}) => ({ dir, engine: 'codex' as string | null, tools: 'read', cwd: 'C:/work', ...over });

describe('buildCharter', () => {
  it('returns nothing when there is no folder', () => {
    expect(buildCharter(input(null))).toBeNull();
    expect(buildCharter(input(join(temp(), 'missing')))).toBeNull();
    expect(buildCharter(input(temp()))).toBeNull();
  });

  it('sends core only, then core plus the engine file', () => {
    const core = tree({ 'core.md': '  Core body.\n' });
    expect(buildCharter(input(core))).toEqual({ text: `${LEAD}\n\nCore body.\n\n--- Assignment ---\n`, parts: ['core'], notes: [] });
    const both = tree({ 'core.md': 'Core body.', 'engines/codex.md': 'Codex body.' });
    const built = buildCharter(input(both));
    expect(built?.parts).toEqual(['core', 'codex']);
    expect(built?.text).toBe(`${LEAD}\n\nCore body.\n\nCodex body.\n\n--- Assignment ---\n`);
    expect(buildCharter(input(both, { engine: 'grok' }))?.parts).toEqual(['core']);
  });

  it('adds request packs, splits comma lists, and does not repeat a pack', () => {
    const dir = tree({ 'core.md': 'Core.', 'engines/codex.md': 'Codex.', 'packs/prose.md': 'Prose.', 'packs/review.md': 'Review.', 'packs/code.md': 'Code.' });
    const built = buildCharter(input(dir, { tools: 'read', packs: ['prose, review', 'prose', 'code,prose'] }));
    expect(built?.parts).toEqual(['core', 'codex', 'prose', 'review', 'code']);
    expect(built?.notes).toEqual([]);
  });

  it('adds the code pack for write and full when no charter.json is present', () => {
    const dir = tree({ 'core.md': 'Core.', 'engines/codex.md': 'Codex.', 'packs/code.md': 'Code.' });
    expect(buildCharter(input(dir, { tools: 'write', packs: [] }))?.parts).toEqual(['core', 'codex', 'code']);
    expect(buildCharter(input(dir, { tools: 'full' }))?.parts).toEqual(['core', 'codex', 'code']);
    expect(buildCharter(input(dir, { tools: 'read' }))?.parts).toEqual(['core', 'codex']);
    expect(buildCharter(input(dir, { tools: 'write', packs: ['code'] }))?.parts).toEqual(['core', 'codex', 'code']);
  });

  it('uses charter.json rules, including a Windows cwd, and skips a missing pack', () => {
    const dir = tree({
      'core.md': 'Core.',
      'engines/codex.md': 'Codex.',
      'packs/neo-angband.md': 'Neo.',
      'packs/code.md': 'Code.',
      'charter.json': JSON.stringify({ auto: [
        { tools: ['write', 'full'], cwdContains: '/neo-angband', pack: 'neo-angband' },
        { cwdContains: '\\elsewhere', pack: 'code' },
      ] }),
    });
    const hit = buildCharter(input(dir, { tools: 'write', cwd: 'C:\\repos\\neo-angband\\src', packs: ['missing'] }));
    expect(hit?.parts).toEqual(['core', 'codex', 'neo-angband']);
    expect(hit?.notes).toEqual(["Charter pack 'missing' was not found and was skipped."]);
    expect(buildCharter(input(dir, { tools: 'read', cwd: 'C:\\repos\\neo-angband\\src' }))?.parts).toEqual(['core', 'codex']);
    expect(buildCharter(input(dir, { tools: 'read', cwd: 'C:\\repos\\elsewhere\\src' }))?.parts).toEqual(['core', 'codex', 'code']);
  });
});

describe('a job row from before charters', () => {
  it('still reads, with none of the new fields', () => {
    const dir = temp();
    const store = new Store(dir);
    store.insert({ id: 'old', route: 'fake', adapter: 'codex-exec', activity: 'write_code', dataTier: 'internal', tools: 'write', output: 'write_files', cwd: dir, createdAt: 1,
      rootJobId: 'old', parentJobId: null, depth: 0, caller: { kind: 'cli' }, named: false, expectFile: null, timeoutS: null, harnessVersion: null, workspace: null });
    const job = store.get('old');
    store.close();
    expect(job).not.toHaveProperty('charter');
    expect(job).not.toHaveProperty('charterChars');
    expect(job).not.toHaveProperty('charterNotes');
    expect(job).not.toHaveProperty('ambient');
    expect(job?.promptChars).toBeNull();
  });
});

describe('the supervisor prefixes a charter', () => {
  const seen: Array<{ prompt: string; ambient?: string }> = [];
  const probe = (id: string, charterEngine: string | null): Adapter => ({
    id, charterEngine, transport: 'exec',
    capabilities: { permissionRequests: false, sessions: false, reportsUsage: false, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: false },
    envAllow: [], validate: () => null,
    plan(request, _route, ctx) {
      seen.push({ prompt: ctx.prompt, ...(ctx.ambient ? { ambient: ctx.ambient } : {}) });
      return { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: request.cwd, env: {}, stdin: null };
    },
    extract: () => ({ answer: 'ok', usage: null }),
  });

  it('gives the adapter the charter plus the prompt, and keeps the stored prompt length', async () => {
    const folder = tree({ 'core.md': 'Core body.', 'engines/codex.md': 'Codex body.', 'packs/code.md': 'Code body.', 'packs/prose.md': 'Prose body.' });
    const e = makeEnv({ adapters: ['probe', 'persona'], runner: { charterDir: folder, ambient: 'keep' } }, process.env, { extra: [probe('probe', 'codex'), probe('persona', null)] });
    envs.push(e);
    e.writeRoutes({
      probe: { model: 'test/fake', adapter: 'probe', options: {} },
      persona: { model: 'test/fake', adapter: 'persona', options: {} },
      trimmed: { model: 'test/fake', adapter: 'probe', options: { ambient: 'trim' } },
    });
    const text = 'hello';
    seen.length = 0;
    const id = submitOk(e.sup, request({ route: 'probe', text, cwd: e.root, packs: ['prose', 'missing'] }));
    const job = e.store.get(id)!;
    const built = buildCharter({ dir: folder, engine: 'codex', tools: 'write', cwd: e.root, packs: ['prose', 'missing'] });
    expect(seen[0]?.prompt).toBe((built?.text ?? '') + text);
    expect(seen[0]?.prompt.startsWith(LEAD)).toBe(true);
    expect(job.charter).toEqual(['core', 'codex', 'prose', 'code']);
    expect(job.charterChars).toBe(built?.text.length);
    expect(job.charterNotes).toEqual(["Charter pack 'missing' was not found and was skipped."]);
    expect(job.promptChars).toBe(text.length);
    expect(job.ambient).toBe('keep');
    await terminal(e.sup, e.store, id);

    seen.length = 0;
    const bare = submitOk(e.sup, request({ route: 'probe', text, cwd: e.root, noCharter: true }));
    expect(seen[0]?.prompt).toBe(text);
    expect(e.store.get(bare)).not.toHaveProperty('charter');
    expect(e.store.get(bare)?.promptChars).toBe(text.length);
    await terminal(e.sup, e.store, bare);

    seen.length = 0;
    const persona = submitOk(e.sup, request({ route: 'persona', text, cwd: e.root }));
    expect(seen[0]?.prompt).toBe(text);
    expect(e.store.get(persona)).not.toHaveProperty('charter');
    await terminal(e.sup, e.store, persona);

    const over = submitOk(e.sup, request({ route: 'trimmed', text, cwd: e.root, noCharter: true }));
    expect(e.store.get(over)?.ambient).toBe('trim');
    await terminal(e.sup, e.store, over);
  });
});
