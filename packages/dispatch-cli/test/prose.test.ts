import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IpcServer } from '@augur/augurd';
import { main } from '../src/cli.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

describe('augur prose', () => {
  it('adds, lists, reports status, and starts a batch through IPC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'augur-prose-cli-')), token = 'p'.repeat(64), ids: string[] = [], calls: Array<[string, unknown]> = [];
    writeFileSync(join(dir, 'token'), token);
    const item = { id: 'item-1', status: 'queued', repo: 'repo', target: 'new' };
    const sup = {
      proseAdd(raw: Record<string, unknown>) { calls.push(['add', raw]); ids.push(item.id); return item; },
      proseList() { calls.push(['list', undefined]); return [item]; },
      proseStatus() { calls.push(['status', undefined]); return { counts: { queued: 1 }, oldestAgeMs: 0, due: true }; },
      proseRun(_dry: boolean, _auto: boolean, caller: unknown) { calls.push(['run', caller]); return { started: true, batchId: 'batch-1', items: ids }; },
      proseApprove() { return item; },
    };
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\augur-prose-cli-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : join(dir, 's.sock');
    const server = new IpcServer(sup as never, {} as never, token, () => null);
    await server.start(pipe);
    cleanup.push(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
    const run = async (args: string[]) => {
      let out = '', err = '';
      const code = await main(args, { out: text => { out += text; }, err: text => { err += text; }, stdin: () => '', env: { ...process.env, AUGURD_DATA: dir, AUGURD_PIPE: pipe }, cwd: dir, interactive: true });
      return { code, out, err };
    };
    expect((await run(['prose', 'add', '--requester', 'owner', '--repo', 'repo', '--target', 'new', '--kind', 'write', '--surface', 'doc', '--audience', 'readers', '--voice', 'plain', '--fact', 'one', '--fact', 'two', '--must-include', 'alpha', '--data', 'internal'])).code).toBe(0);
    expect(calls[0]?.[1]).toMatchObject({ facts: [{ text: 'one' }, { text: 'two' }], mustInclude: ['alpha'], dataTier: 'internal' });
    expect((await run(['prose', 'list'])).out).toContain('item-1');
    expect((await run(['prose', 'status'])).out).toContain('run due');
    expect((await run(['prose', 'run'])).out).toContain('batch-1');
    expect(calls.find(x => x[0] === 'run')?.[1]).toMatchObject({ kind: 'cli', interactive: true });
  });
});
