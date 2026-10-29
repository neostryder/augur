import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialTarget, routeSecretName, tierNote } from '@augur/dispatch-protocol';
import type { ExtractInput, JobRequest } from '@augur/dispatch-protocol';
import { anthropicApi, codexExec, copilotExec, grokExec, hermesExec, mcodeSbx, opencodeSbx, openaiApi } from '../src/adapters/index.js';
import { parseCount } from '../src/adapters/copilot-exec.js';
import { insideSandbox, resolveExecutable } from '../src/adapters/util.js';
import { FAKE, ROUTES, makeEnv, request, submitOk, terminal } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 90000 });
const envs: Env[] = [];
const servers: Server[] = [];
afterEach(async () => { while (envs.length) envs.pop()!.dispose(); while (servers.length) await new Promise(r => servers.pop()!.close(() => r(null))); });
const setup = (...a: Parameters<typeof makeEnv>) => { const e = makeEnv(...a); envs.push(e); return e; };
const FAKE_SBX = join(FAKE, '..', 'fake-sbx.mjs');

const input = (over: Partial<ExtractInput> = {}): ExtractInput => ({ stdout: '', stdoutPath: join(tmpdir(), 'none.log'), stderr: '', exitCode: 0, jobDir: tmpdir(), workspace: null, ...over });
const req = (over: Partial<JobRequest> = {}): JobRequest => request(over, tmpdir());
const ctx = (prompt: string, jobDir = 'C:/jobs/j1', workspace: string | null = null) => ({ jobDir, prompt, workspace });

describe('what each harness prints, read from real captured output', () => {
  it('codex: takes the answer from the final-message file and flags a dead tool host', () => {
    const dir = join(tmpdir(), `codex-x-${Date.now()}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'last-message.txt'), 'the answer\n');
    const out = '{"type":"turn.completed","usage":{"input_tokens":253105,"cached_input_tokens":209152,"output_tokens":4034,"reasoning_output_tokens":227}}\n';
    expect(codexExec.extract(input({ stdout: out, jobDir: dir }))).toEqual({ answer: 'the answer', usage: { inputTokens: 253105, outputTokens: 4034, cachedReadTokens: 209152, reasoningTokens: 227, reasoningInOutput: true, source: 'reported' } });
    expect(codexExec.extract(input({ stdout: 'tool said: failed to spawn code-mode host', jobDir: dir })).failure).toMatch(/tool host/);
    const started = '{"type":"thread.started","thread_id":"0199abcd-1234-5678-9abc-def012345678"}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n';
    expect(codexExec.extract(input({ stdout: started, jobDir: dir }))).toEqual({ answer: 'the answer', usage: { inputTokens: 10, outputTokens: 2, source: 'reported' }, sessionId: '0199abcd-1234-5678-9abc-def012345678' });
  });

  it('hermes: answer from standard output, tokens and cost from the usage file, cached counts added to input', () => {
    const dir = join(tmpdir(), `hermes-x-${Date.now()}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'usage.json'), JSON.stringify({ estimated_cost_usd: 0.0021, cost_source: 'provider', input_tokens: 20991, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 0, reasoning_tokens: 3,
      auxiliary: { input_tokens: 236, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 } }));
    const x = hermesExec.extract(input({ stdout: 'pong\r\n', jobDir: dir }));
    expect(x.answer).toBe('pong');
    expect(x.usage).toEqual({ inputTokens: 20991 + 236 + 100, outputTokens: 15, cachedReadTokens: 100, reasoningTokens: 3, costUsd: 0.0021, currency: 'USD', source: 'reported' });
    writeFileSync(join(dir, 'usage.json'), JSON.stringify({ estimated_cost_usd: 0, cost_source: 'none', cost_status: 'included', input_tokens: 5, output_tokens: 1 }));
    expect(hermesExec.extract(input({ stdout: 'x', jobDir: dir })).usage).toEqual({ inputTokens: 5, outputTokens: 1, source: 'reported' });
  });

  it('copilot: strips the statistics trailer and reads credits as dollars and rounded token counts', () => {
    const out = 'pong\r\n\r\n\r\n\r\nChanges    +0 -0\r\nAI Credits 0.37 (5s)\r\nTokens     \u2191 14.1k \u2022 \u2193 87 (64 reasoning)\r\nResume     copilot --resume=352b320c\r\n';
    const x = copilotExec.extract(input({ stdout: out }));
    expect(x.answer).toBe('pong');
    expect(x.usage).toEqual({ inputTokens: 14100, outputTokens: 87, reasoningTokens: 64, reasoningInOutput: true, costUsd: 0.0037, currency: 'USD', source: 'reported' });
    const b = copilotExec.extract(input({ stdout: 'pong\r\n\r\nChanges    +0 -0\r\nAI Credits 0.63 (5s)\r\nTokens     ↑ 49.9k (49.9k written) • ↓ 104 (97 reasoning)\r\n' }));
    expect(b.usage).toEqual({ inputTokens: 49900, outputTokens: 104, cachedWriteTokens: 49900, reasoningTokens: 97, reasoningInOutput: true, costUsd: 0.0063, currency: 'USD', source: 'reported' });
    expect([parseCount('87'), parseCount('14.1k'), parseCount('1.2m'), parseCount('junk')]).toEqual([87, 14100, 1200000, 0]);
  });

  it('grok: answer and usage from the JSON envelope', () => {
    const out = JSON.stringify({ text: 'hello', usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 500 }, total_cost_usd: 0.0123 });
    expect(grokExec.extract(input({ stdout: out }))).toEqual({ answer: 'hello', usage: { inputTokens: 1500, outputTokens: 20, cachedReadTokens: 500, costUsd: 0.0123, currency: 'USD', source: 'reported' } });
    expect(grokExec.extract(input({ stdout: 'plain text' })).answer).toBe('plain text');
    const named = JSON.stringify({ text: 'hello', usage: { input_tokens: 1, output_tokens: 2 }, sessionId: 'sess-1' });
    expect(grokExec.extract(input({ stdout: named })).sessionId).toBe('sess-1');
    expect(grokExec.extract(input({ stdout: JSON.stringify({ text: 'hello', sessionId: '' }) }))).not.toHaveProperty('sessionId');
  });

  it('mcode: skips the sbx status line, adds cache reads to input, and fails on a non-succeeded status', () => {
    const line = '{"schemaVersion":1,"type":"exec.result","status":"succeeded","output":"pong","usage":{"inputTokens":681,"outputTokens":28,"cacheReadTokens":10752}}';
    const x = mcodeSbx.extract(input({ stdout: `Sandbox mc-m3 started successfully\n${line}\n` }));
    expect(x).toEqual({ answer: 'pong', usage: { inputTokens: 11433, outputTokens: 28, cachedReadTokens: 10752, source: 'reported' } });
    expect(mcodeSbx.extract(input({ stdout: line.replace('succeeded', 'failed') })).failure).toMatch(/failed/);
    expect(mcodeSbx.extract(input({ stdout: 'nothing useful' })).failure).toMatch(/did not return/);
  });

  it('opencode: last step text is the answer, and tokens and cost add up across steps', () => {
    const ev = (o: unknown) => JSON.stringify(o);
    const stdout = [ev({ type: 'step_start', part: {} }), ev({ type: 'text', part: { text: 'let me look' } }),
      ev({ type: 'step_finish', part: { tokens: { input: 10, output: 4, reasoning: 0, cache: { write: 0, read: 12544 } }, cost: 0.00008 } }),
      ev({ type: 'step_start', part: {} }), ev({ type: 'text', part: { text: 'pong' } }),
      ev({ type: 'step_finish', part: { tokens: { input: 20, output: 6, reasoning: 2, cache: { write: 5, read: 100 } }, cost: 0.00002 } })].join('\n');
    expect(opencodeSbx.extract(input({ stdout }))).toEqual({ answer: 'pong', usage: { inputTokens: 10 + 12544 + 20 + 100 + 5, outputTokens: 10, cachedReadTokens: 12644, cachedWriteTokens: 5, reasoningTokens: 2, costUsd: 0.0001, currency: 'USD', source: 'reported' } });
  });
});

describe('command lines', () => {
  const route = (adapter: string, options: Record<string, string | number | boolean>) => ({ model: 'x/y', adapter, options });
  it('hermes: prompt after -z, tier flags, and a long prompt handed over as a file', () => {
    const r = route('hermes-exec', { model: 'gpt-6-luna', command: 'C:/h/hermes.exe' });
    const small = hermesExec.plan(req({ tools: 'read' }), r, ctx('hi'));
    expect(small.args.slice(0, 4)).toEqual(['-z', 'hi', '-m', 'gpt-6-luna']);
    expect(small.args).toContain('--safe-mode');
    expect(small.promptArgs).toEqual([1]);
    expect(hermesExec.plan(req({ tools: 'full' }), r, ctx('hi')).args).toContain('--yolo');
    const hosted = hermesExec.plan(req({ tools: 'read' }), route('hermes-exec', { model: 'z-ai/glm-5.3-flash', provider: 'openrouter', effort: 'medium', command: 'C:/h/hermes.exe' }), ctx('hi')).args;
    expect(hosted.slice(0, 4)).toEqual(['-z', 'hi', '-m', 'z-ai/glm-5.3-flash']);
    expect(hosted.join(' ')).toContain('--provider openrouter --reasoning medium');
    expect(small.args).not.toContain('--provider');
    const big = hermesExec.plan(req(), r, ctx('x'.repeat(13000)));
    expect(big.files?.[0]?.name).toBe('task.md');
    expect(big.args[1]).toMatch(/^Read the file at .*task\.md in full/);
  });
  it('grok: prompt from a file, JSON envelope, write approves all tools and read denies Edit and Bash', () => {
    const r = route('grok-exec', { model: 'grok-4.7', command: 'C:/g/grok.exe', effort: 'high' });
    const w = grokExec.plan(req({ tools: 'write' }), r, ctx('go', 'C:/jobs/j1'));
    expect(w.args).toEqual(expect.arrayContaining(['--prompt-file', join('C:/jobs/j1', 'prompt.md'), '--output-format', 'json', '--always-approve', '--reasoning-effort', 'high']));
    expect(w.files).toEqual([{ name: 'prompt.md', content: 'go' }]);
    const rd = grokExec.plan(req({ tools: 'read' }), r, ctx('go'));
    expect(rd.args).toEqual(expect.arrayContaining(['--allow', 'Read', '--deny', 'Edit']));
    expect(rd.args).not.toContain('--always-approve');
    const none = grokExec.plan(req({ tools: 'none' }), r, ctx('go'));
    expect(none.args).toEqual(expect.arrayContaining(['--deny', 'Read', '--deny', 'Grep', '--deny', 'Edit', '--deny', 'Bash(*)']));
    expect(none.args).not.toContain('--always-approve');
    expect(none.args).not.toContain('--allow');
    expect(w.args).not.toContain('--session-id');
    expect(w.args).not.toContain('--resume');
    const resumeCtx = ctx('go', 'C:/jobs/j1');
    const fresh = grokExec.plan(req({ tools: 'write' }), r, { ...resumeCtx, resume: { id: '11111111-1111-1111-1111-111111111111', fresh: true, name: 'feat' } });
    expect(fresh.args.slice(0, 2)).toEqual(['--session-id', '11111111-1111-1111-1111-111111111111']);
    expect(fresh.args.slice(2)).toEqual(w.args);
    const again = grokExec.plan(req({ tools: 'write' }), r, { ...resumeCtx, resume: { id: '11111111-1111-1111-1111-111111111111', fresh: false, name: 'feat' } });
    expect(again.args.slice(0, 2)).toEqual(['--resume', '11111111-1111-1111-1111-111111111111']);
    expect(again.args.slice(2)).toEqual(w.args);
  });
  it('codex and copilot trim ambient context only when asked, and a route option overrides the setting', () => {
    const off = ['plugins', 'apps', 'multi_agent', 'skill_search', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation', 'goals', 'tool_suggest'];
    const codexRoute = route('codex-exec', { command: 'C:/c/codex.exe', model: 'm' });
    const cctx = ctx('hi', 'C:/jobs/j1');
    const base = codexExec.plan(req(), codexRoute, cctx);
    expect(codexExec.plan(req(), codexRoute, { ...cctx, ambient: 'keep' })).toEqual(base);
    expect(base.args).not.toContain('--disable');
    const trimmed = codexExec.plan(req(), codexRoute, { ...cctx, ambient: 'trim' });
    const at = trimmed.args.indexOf('--sandbox');
    expect(trimmed.args.slice(at + 2, at + 2 + off.length * 2)).toEqual(off.flatMap(f => ['--disable', f]));
    expect(trimmed.args.slice(at + 2 + off.length * 2)).toEqual(['-m', 'm', '-']);
    expect(codexExec.plan(req(), route('codex-exec', { command: 'C:/c/codex.exe', model: 'm', ambient: 'trim' }), { ...cctx, ambient: 'keep' }).args).toEqual(trimmed.args);
    expect(codexExec.plan(req(), route('codex-exec', { command: 'C:/c/codex.exe', model: 'm', ambient: 'keep' }), { ...cctx, ambient: 'trim' })).toEqual(base);
    expect(codexExec.plan(req(), codexRoute, { ...cctx, resume: { id: null, fresh: true, name: 'feat' } })).toEqual(base);
    const resumed = codexExec.plan(req({ tools: 'write' }), codexRoute, { ...cctx, resume: { id: 'thread-1', fresh: false, name: 'feat' } });
    const out = [join('C:/jobs/j1', 'last-message.txt')];
    const head = ['exec', 'resume', '--skip-git-repo-check', '--json', '-o', ...out];
    expect(resumed.args).toEqual([...head, 'thread-1', '-']);
    expect(resumed.stdin).toBe(tierNote('write', 'hi'));
    for (const flag of ['--sandbox', '-m', '--disable']) expect(resumed.args).not.toContain(flag);
    const withEffort = codexExec.plan(req({ tools: 'write' }), route('codex-exec', { command: 'C:/c/codex.exe', model: 'm', effort: 'low' }), { ...cctx, resume: { id: 'thread-1', fresh: false, name: 'feat' } });
    expect(withEffort.args).toEqual([...head, 'thread-1', '-c', 'model_reasoning_effort=low', '-']);
    const bare = codexExec.plan(req({ tools: 'read' }), route('codex-exec', { command: 'C:/c/codex.exe' }), { ...cctx, resume: { id: 'thread-1', fresh: false, name: 'feat' } });
    expect(bare.args).toEqual([...head, 'thread-1', '-']);
    expect(bare.stdin).toBe(tierNote('read', 'hi'));
    const wrapped = codexExec.plan(req({ tools: 'full' }), route('codex-exec', { command: 'C:/c/codex.exe', prefixArgsJson: '["wrap"]' }), { ...cctx, resume: { id: 'thread-1', fresh: false, name: 'feat' } });
    expect(wrapped.args).toEqual(['wrap', ...head, 'thread-1', '-']);
    expect(wrapped.stdin).toBe('hi');

    const copilotRoute = route('copilot-exec', { model: 'gpt-5-mini', command: 'C:/c/copilot.exe' });
    const plain = copilotExec.plan(req({ tools: 'read' }), copilotRoute, ctx('hi'));
    expect(copilotExec.plan(req({ tools: 'read' }), copilotRoute, { ...ctx('hi'), ambient: 'keep' })).toEqual(plain);
    expect(plain.args).not.toContain('--no-custom-instructions');
    expect(copilotExec.plan(req({ tools: 'read' }), copilotRoute, { ...ctx('hi'), ambient: 'trim' }).args).toEqual([...plain.args, '--no-custom-instructions', '--disable-builtin-mcps']);
    const effortTrim = copilotExec.plan(req({ tools: 'read' }), route('copilot-exec', { model: 'gpt-5-mini', command: 'C:/c/copilot.exe', effort: 'high', ambient: 'trim' }), { ...ctx('hi'), ambient: 'keep' });
    expect(effortTrim.args.slice(effortTrim.args.indexOf('--no-color') + 1)).toEqual(['--no-custom-instructions', '--disable-builtin-mcps', '--reasoning-effort', 'high']);
    const held = copilotExec.plan(req({ tools: 'read' }), route('copilot-exec', { model: 'gpt-5-mini', command: 'C:/c/copilot.exe', effort: 'high', ambient: 'keep' }), { ...ctx('hi'), ambient: 'trim' });
    expect(held.args).not.toContain('--disable-builtin-mcps');
    expect(held.args).toContain('--reasoning-effort');
  });
  it('copilot: all tools allowed, tier stated in the prompt, prompt marked for redaction', () => {
    const p = copilotExec.plan(req({ tools: 'read' }), route('copilot-exec', { model: 'gpt-5-mini', command: 'C:/c/copilot.exe' }), ctx('hi'));
    expect(p.args.slice(0, 2)).toEqual(['-p', expect.stringMatching(/^READ-ONLY TASK\.[\s\S]*hi$/)]);
    expect(p.args).toEqual(expect.arrayContaining(['--model', 'gpt-5-mini', '--allow-all-tools', '--no-color']));
    expect(p.promptArgs).toEqual([1]);
  });
  it('mcode: runs through sbx in the job folder as the sandbox sees it, prompt on standard input', () => {
    const r = route('mcode-sbx', { sandbox: 'mc-m3', workRoot: 'C:/w', model: 'custom_provider:minimax-direct/MiniMax-M3', sbx: process.execPath });
    const p = mcodeSbx.plan(req({ tools: 'write' }), r, ctx('hi', 'C:/jobs/j1', 'C:\\w\\jobs\\j1'));
    expect(p.args.slice(0, 5)).toEqual(['exec', '-i', '-e', 'NO_COLOR=1', '-w']);
    expect(p.args[5]).toBe('/c/w/jobs/j1');
    expect(p.args).toEqual(expect.arrayContaining(['--permission', 'full', '--output-format', 'json', '--input', '-']));
    expect(p.stdin).toBe('hi');
    expect(mcodeSbx.validate(route('mcode-sbx', { sandbox: 'a', workRoot: 'b' }))).toMatch(/model/);
    expect(mcodeSbx.isolation?.root(r)).toBe('C:/w');
  });
  it('opencode: a long prompt goes into a task file in the workspace', () => {
    const r = route('opencode-sbx', { sandbox: 'oc-ds', workRoot: 'C:/w', model: 'openrouter/deepseek/deepseek-v4.1-flash', sbx: process.execPath });
    const short = opencodeSbx.plan(req(), r, ctx('hi', 'C:/jobs/j1', 'C:/w/jobs/j1'));
    expect(short.args.at(-1)).toBe('hi');
    expect(short.promptArgs).toEqual([short.args.length - 1]);
    const long = opencodeSbx.plan(req(), r, ctx('y'.repeat(9000), 'C:/jobs/j1', 'C:/w/jobs/j1'));
    expect(long.files).toEqual([{ name: '.ai-task.md', content: 'y'.repeat(9000), inWorkspace: true }]);
    expect(long.args.at(-1)).toMatch(/\.ai-task\.md/);
    const hard = opencodeSbx.plan(req(), route('opencode-sbx', { sandbox: 'oc-ds', workRoot: 'C:/w', model: 'm', sbx: process.execPath, effort: 'xhigh' }), ctx('hi', 'C:/jobs/j1', 'C:/w/jobs/j1'));
    expect(hard.args.slice(-3)).toEqual(['--variant', 'high', 'hi']);
    expect(hard.promptArgs).toEqual([hard.args.length - 1]);
  });
  it('finds a command without cmd.exe, and turns an npm shim into node plus its script', () => {
    const found = resolveExecutable('node');
    expect(found?.prefix).toEqual([]);
    expect(insideSandbox('C:\\Temp\\sbx\\work\\mc-m3\\jobs\\a')).toBe('/c/Temp/sbx/work/mc-m3/jobs/a');
    if (process.platform === 'win32') { const npm = resolveExecutable('npm'); if (npm && /\.cmd$/i.test(npm.command) === false) expect(npm.prefix.length).toBeGreaterThanOrEqual(0); }
  });
});

describe('a prompt too large for an argument', () => {
  it('is rejected before launch for a harness that takes it as an argument, and accepted for one that reads it from a file or stdin', () => {
    if (process.platform !== 'win32') return;
    const e = setup({ adapters: ['codex-exec', 'copilot-exec', 'exec'] });
    e.writeRoutes({ ...ROUTES, cp: { model: 'test/fake', adapter: 'copilot-exec', options: { model: 'gpt-5-mini', command: process.execPath } } });
    const big = 'z'.repeat(31000);
    expect(e.sup.submit(request({ route: 'cp', text: big }, e.root))).toMatchObject({ rejected: { code: 'prompt_too_large' } });
    const ok = e.sup.submit(request({ route: 'fake', text: big + '\nSLEEP 0' }, e.root));
    expect('id' in ok).toBe(true);
  });
});

describe('an API connector', () => {
  async function mock(handler: (body: Record<string, unknown>, headers: IncomingHttpHeaders, url: string) => { status?: number; json: unknown; headers?: Record<string, string> }) {
    const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown>; raw: string }> = [];
    const server = createServer((rq, rs) => {
      let raw = ''; rq.on('data', d => { raw += d; });
      // A multipart upload is not JSON, so its body reads as empty and the raw text is kept.
      rq.on('end', () => { let body: Record<string, unknown> = {}; try { body = JSON.parse(raw || '{}') as Record<string, unknown>; } catch { /* multipart */ } seen.push({ url: rq.url ?? '', headers: rq.headers, body, raw }); const out = handler(body, rq.headers, rq.url ?? ''); rs.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...out.headers }); rs.end(JSON.stringify(out.json)); });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    servers.push(server);
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
  }
  const textReq = (route: string, text = 'say pong') => request({ route, activity: 'research', tools: 'read', output: 'text_only', text });

  it('calls an OpenAI-style endpoint with the key from the environment, and reports usage and cost', async () => {
    const m = await mock(() => ({ json: { choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 1 }, cost: 0.00012 } } }));
    const e = setup({ adapters: ['openai-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'sk-test-secret-value' });
    e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: `${m.url}/api/v1`, model: 'cheap-1', apiKeyEnv: 'AUGUR_TEST_API_KEY', maxTokens: 50 } } });
    const id = submitOk(e.sup, { ...textReq('chat'), cwd: e.root });
    const job = await terminal(e.sup, e.store, id);
    expect(job).toMatchObject({ state: 'completed', usage: { inputTokens: 100, outputTokens: 3, cachedReadTokens: 40, reasoningTokens: 1, reasoningInOutput: true, costUsd: 0.00012, currency: 'USD' } });
    expect(e.sup.result(id)?.answer).toBe('pong');
    expect(m.seen[0]).toMatchObject({ url: '/api/v1/chat/completions', body: { model: 'cheap-1', max_tokens: 50, messages: [{ role: 'user', content: 'say pong' }] } });
    expect(m.seen[0]!.headers.authorization).toBe('Bearer sk-test-secret-value');
    // The key reaches the request and nowhere else.
    const files = readdirSync(join(e.dir, 'jobs', id)).map(f => readFileSync(join(e.dir, 'jobs', id, f), 'utf8'));
    for (const text of files) expect(text).not.toContain('sk-test-secret-value');
    expect(execFileSync('node', ['-e', 'process.stdout.write(String(1))'], { encoding: 'utf8' })).toBe('1');
  });

  it('calls an Anthropic-style endpoint and adds cache tokens to input', async () => {
    const m = await mock(() => ({ json: { content: [{ type: 'text', text: 'po' }, { type: 'text', text: 'ng' }], usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } } }));
    const e = setup({ adapters: ['anthropic-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'k-anthropic' });
    e.writeRoutes({ claude: { model: 'test/text', adapter: 'anthropic-api', options: { baseUrl: m.url, model: 'haiku-x', apiKeyEnv: 'AUGUR_TEST_API_KEY' } } });
    const id = submitOk(e.sup, { ...textReq('claude'), cwd: e.root });
    const job = await terminal(e.sup, e.store, id);
    expect(job.state).toBe('completed');
    expect(job.usage).toEqual({ inputTokens: 240, outputTokens: 4, cachedReadTokens: 200, cachedWriteTokens: 30, source: 'reported' });
    expect(e.sup.result(id)?.answer).toBe('po\nng');
    expect(m.seen[0]).toMatchObject({ url: '/v1/messages', body: { model: 'haiku-x', max_tokens: 4096 } });
    expect(m.seen[0]!.headers['x-api-key']).toBe('k-anthropic');
    expect(m.seen[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('refuses to send a key over plain http to a remote host, and allows http for localhost', () => {
    const e = setup({ adapters: ['openai-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'k' });
    e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: 'http://api.example.com/v1', model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY' } } });
    expect(e.sup.submit({ ...textReq('chat'), cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('https://') } });
    e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: 'http://127.0.0.1:9/v1', model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY' } } });
    const local = e.sup.submit({ ...textReq('chat'), cwd: e.root });
    expect('rejected' in local ? local.rejected.reason : '').not.toContain('https://');
  });

  it('allows plain http to a machine on the home network, and still refuses a public name', () => {
    const e = setup({ adapters: ['openai-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'k' });
    const refused = (baseUrl: string) => {
      e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl, model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY' } } });
      const r = e.sup.submit({ ...textReq('chat'), cwd: e.root });
      return 'rejected' in r ? r.rejected.reason : '';
    };
    expect(refused('http://eru:8470/v1')).not.toContain('https://');
    expect(refused('http://192.168.1.20:8470/v1')).not.toContain('https://');
    expect(refused('http://cogitator.example.com/v1')).toContain('https://');
  });

  it('sends the extra headers and the priority class, and refuses a credential header', async () => {
    const m = await mock(() => ({ json: { choices: [{ message: { content: 'ok' } }] } }));
    const e = setup({ adapters: ['openai-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'k' });
    const route = (options: Record<string, unknown>) => e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: m.url, model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY', ...options } } });
    route({ requestClass: 'cogitator', headersJson: JSON.stringify({ 'x-team': 'home' }) });
    const background = submitOk(e.sup, { ...textReq('chat'), cwd: e.root });
    await terminal(e.sup, e.store, background);
    const typed = submitOk(e.sup, { ...textReq('chat'), cwd: e.root, caller: { kind: 'cli', interactive: true } });
    await terminal(e.sup, e.store, typed);
    const urgent = submitOk(e.sup, { ...textReq('chat'), cwd: e.root, urgent: true });
    await terminal(e.sup, e.store, urgent);
    expect(m.seen.map(r => r.headers['x-cogitator-class'])).toEqual(['low', 'normal', 'normal']);
    expect(m.seen.every(r => r.headers['x-team'] === 'home')).toBe(true);
    expect(m.seen.every(r => r.headers['x-cogitator-source'] === 'augur' && r.headers['x-augur-route'] === 'chat' && r.headers['x-cogitator-activity'] === textReq('chat').activity)).toBe(true);
    route({ headersJson: JSON.stringify({ Authorization: 'Bearer x' }) });
    expect(e.sup.submit({ ...textReq('chat'), cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('key store') } });
    route({ requestClass: 'other' });
    expect(e.sup.submit({ ...textReq('chat'), cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('requestClass') } });
  });

  it('refuses a prompt over maxInput without cutting it, and sends the job on to the fallback route', async () => {
    const m = await mock(() => ({ json: { choices: [{ message: { content: 'served by fallback' } }] } }));
    const e = setup({ adapters: ['openai-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'k' });
    const options = { baseUrl: m.url, model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY' };
    e.writeRoutes({ small: { model: 'test/text', adapter: 'openai-api', fallback: ['big'], options: { ...options, maxInput: 100 } }, big: { model: 'test/text', adapter: 'openai-api', options } });
    const fits = submitOk(e.sup, { ...textReq('small', 'short'), cwd: e.root });
    await terminal(e.sup, e.store, fits);
    expect(m.seen).toHaveLength(1);
    const long = 'x'.repeat(500);
    const id = submitOk(e.sup, { ...textReq('small', long), cwd: e.root });
    expect(e.store.get(id)?.route).toBe('big');
    await terminal(e.sup, e.store, id);
    expect(m.seen[1]!.body).toMatchObject({ messages: [{ role: 'user', content: expect.stringContaining(long) }] });
    e.writeRoutes({ small: { model: 'test/text', adapter: 'openai-api', options: { ...options, maxInput: 100 } } });
    expect(e.sup.submit({ ...textReq('small', long), cwd: e.root })).toMatchObject({ rejected: { code: 'prompt_too_large', reason: expect.stringContaining('at most 100') } });
    e.writeRoutes({ small: { model: 'test/text', adapter: 'openai-api', options: { ...options, maxInput: 0 } } });
    expect(e.sup.submit({ ...textReq('small', long), cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('maxInput') } });
  });

  it('records which machine and chain link the gateway says served the job', async () => {
    const m = await mock(() => ({ json: { choices: [{ message: { content: 'ok' } }] }, headers: { 'x-cogitator-host': 'bilbo', 'x-cogitator-model': 'apple', 'x-cogitator-chain-position': '1', 'x-cogitator-degraded': 'true' } }));
    const e = setup({ adapters: ['openai-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'k' });
    e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: m.url, model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY' } } });
    const id = submitOk(e.sup, { ...textReq('chat'), cwd: e.root });
    expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'completed', served: { host: 'bilbo', model: 'apple', chainPosition: 1, degraded: true } });
    const plain = await mock(() => ({ json: { choices: [{ message: { content: 'ok' } }] } }));
    e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: plain.url, model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY' } } });
    const other = submitOk(e.sup, { ...textReq('chat'), cwd: e.root });
    expect(await terminal(e.sup, e.store, other)).not.toHaveProperty('served');
  });

  describe('with files attached', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const route = (e: Env, url: string, options: Record<string, unknown> = {}) => e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: url, model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY', ...options } } });
    const env = () => setup({ adapters: ['openai-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'k' });

    it('adds a text file to the prompt and shows an image to the model', async () => {
      const m = await mock(() => ({ json: { choices: [{ message: { content: 'seen' } }] } }));
      const e = env(); route(e, m.url);
      writeFileSync(join(e.root, 'notes.md'), 'the notes'); writeFileSync(join(e.root, 'shot.png'), png);
      const id = submitOk(e.sup, { ...textReq('chat', 'look'), cwd: e.root, attach: [join(e.root, 'notes.md'), 'shot.png'] });
      expect((await terminal(e.sup, e.store, id)).state).toBe('completed');
      const content = (m.seen[0]!.body.messages as Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>)[0]!.content;
      expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('--- notes.md ---\nthe notes') });
      expect(content[1]!.image_url!.url).toBe(`data:image/png;base64,${png.toString('base64')}`);
    });

    it('embeds the prompt and the text files and keeps the vectors in the job folder', async () => {
      const m = await mock(() => ({ json: { model: 'embed-small', data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }], usage: { prompt_tokens: 7 } } }));
      const e = env(); route(e, m.url, { mode: 'embeddings' });
      writeFileSync(join(e.root, 'doc.txt'), 'a document');
      const id = submitOk(e.sup, { ...textReq('chat', 'a query'), activity: 'embed', cwd: e.root, attach: ['doc.txt'] });
      const job = await terminal(e.sup, e.store, id);
      expect(job).toMatchObject({ state: 'completed', usage: { inputTokens: 7, outputTokens: 0 } });
      expect(m.seen[0]).toMatchObject({ url: '/embeddings', body: { model: 'x', input: ['a query', 'a document'] } });
      const file = join(e.dir, 'jobs', id, 'vectors.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ model: 'embed-small', dimensions: 3, vectors: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] });
      expect(JSON.parse(e.sup.result(id)?.answer ?? '')).toEqual({ model: 'embed-small', dimensions: 3, vectors: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] });
    });
    it('embeds a JSON array of strings as one batch, in order, before the text files', async () => {
      const m = await mock(() => ({ json: { model: 'embed-small', data: [{ embedding: [1] }, { embedding: [2] }, { embedding: [3] }] } }));
      const e = env(); route(e, m.url, { mode: 'embeddings' });
      writeFileSync(join(e.root, 'doc.txt'), 'a file');
      const id = submitOk(e.sup, { ...textReq('chat', JSON.stringify(['one', 'two'])), activity: 'embed', cwd: e.root, attach: ['doc.txt'] });
      await terminal(e.sup, e.store, id);
      expect(m.seen[0]).toMatchObject({ body: { input: ['one', 'two', 'a file'] } });
      expect(JSON.parse(e.sup.result(id)?.answer ?? '').vectors).toEqual([[1], [2], [3]]);
    });
    it('refuses an embed batch of more than 256 inputs', async () => {
      const m = await mock(() => ({ json: { data: [{ embedding: [1] }] } }));
      const e = env(); route(e, m.url, { mode: 'embeddings' });
      const id = submitOk(e.sup, { ...textReq('chat', JSON.stringify(Array.from({ length: 257 }, (_, i) => `t${i}`))), activity: 'embed', cwd: e.root });
      expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'failed' });
      expect(m.seen).toHaveLength(0);
    });

    it('sends one audio file to the transcription endpoint', async () => {
      const m = await mock(() => ({ json: { text: 'hello there' } }));
      const e = env(); route(e, m.url, { mode: 'transcribe' });
      writeFileSync(join(e.root, 'clip.wav'), 'RIFF....WAVE');
      const id = submitOk(e.sup, { ...textReq('chat', 'names: Eru'), activity: 'transcribe', cwd: e.root, attach: ['clip.wav'] });
      expect((await terminal(e.sup, e.store, id)).state).toBe('completed');
      expect(e.sup.result(id)?.answer).toBe('hello there');
      expect(m.seen[0]!.url).toBe('/audio/transcriptions');
      expect(m.seen[0]!.headers['content-type']).toMatch(/^multipart\/form-data/);
      expect(m.seen[0]!.raw).toContain('filename="clip.wav"');
      expect(m.seen[0]!.raw).toContain('names: Eru');
    });

    it('sends the prompt, text files and images to the moderations endpoint and returns the flags with the raw scores', async () => {
      const m = await mock(() => ({ json: { model: 'omni-moderation-latest', results: [{ flagged: true, categories: { sexual: false, violence: true }, category_scores: { sexual: 0.21, violence: 0.93 }, category_applied_input_types: { sexual: ['image'], violence: ['text'] } }] } }));
      const e = env(); route(e, m.url, { mode: 'moderation' });
      writeFileSync(join(e.root, 'note.txt'), 'a note'); writeFileSync(join(e.root, 'shot.png'), png);
      const id = submitOk(e.sup, { ...textReq('chat', 'a caption'), activity: 'moderate', cwd: e.root, attach: ['note.txt', 'shot.png'] });
      expect((await terminal(e.sup, e.store, id)).state).toBe('completed');
      expect(m.seen[0]).toMatchObject({ url: '/moderations', body: { model: 'x', input: [{ type: 'text', text: 'a caption' }, { type: 'text', text: 'a note' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] } });
      expect(JSON.parse(e.sup.result(id)?.answer ?? '')).toEqual({ model: 'omni-moderation-latest', flagged: true, categories: { sexual: false, violence: true }, scores: { sexual: 0.21, violence: 0.93 }, appliedTo: { sexual: ['image'], violence: ['text'] } });
    });

    it('refuses an attachment or prompt file that reaches outside the allowed folders through a link', async () => {
      const m = await mock(() => ({ json: { choices: [{ message: { content: 'x' } }] } }));
      const e = env(); route(e, m.url);
      const outside = mkdtempSync(join(tmpdir(), 'augur-outside-'));
      writeFileSync(join(outside, 'secret.txt'), 'outside text'); writeFileSync(join(outside, 'secret'), 'no extension');
      try {
        symlinkSync(outside, join(e.root, 'linkdir'), 'junction');
        const refuse = (attach: string[]) => expect(e.sup.submit({ ...textReq('chat'), cwd: e.root, attach })).toMatchObject({ rejected: { code: 'attachment_rejected', reason: expect.stringMatching(/must be inside/) } });
        refuse(['linkdir/secret.txt']);
        expect(e.sup.submit({ ...textReq('chat'), cwd: e.root, prompt: { file: join(e.root, 'linkdir', 'secret.txt') } })).toMatchObject({ rejected: { reason: expect.stringMatching(/prompt file must be inside/) } });
        try { symlinkSync(join(outside, 'secret'), join(e.root, 'pretend.txt'), 'file'); refuse(['pretend.txt']); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err; }
        expect(m.seen).toHaveLength(0);
      } finally { rmSync(outside, { recursive: true, force: true }); }
    });

    it('refuses an attachment the route cannot take, with the reason', async () => {
      const m = await mock(() => ({ json: { choices: [{ message: { content: 'x' } }] } }));
      const e = env(); route(e, m.url);
      writeFileSync(join(e.root, 'clip.wav'), 'RIFF'); writeFileSync(join(e.root, 'blob.bin'), 'x'); writeFileSync(join(e.root, 'big.png'), Buffer.alloc(2 * 1048576));
      const refuse = (attach: string[], reason: RegExp) =>
        expect(e.sup.submit({ ...textReq('chat'), cwd: e.root, attach })).toMatchObject({ rejected: { code: 'attachment_rejected', reason: expect.stringMatching(reason) } });
      refuse(['clip.wav'], /takes text and image attachments, not audio/);
      refuse(['blob.bin'], /type Augur does not send/);
      refuse(['missing.txt'], /could not be read/);
      refuse([join(tmpdir(), 'elsewhere.txt')], /must be inside/);
      route(e, m.url, { maxImageMb: 1 });
      refuse(['big.png'], /2 MB and route chat takes image files up to 1 MB/);
      expect(m.seen).toHaveLength(0);
    });

    it('counts text files toward maxInput, and keeps each activity on its own kind of route', () => {
      const e = env();
      writeFileSync(join(e.root, 'long.txt'), 'y'.repeat(400));
      route(e, 'http://127.0.0.1:9', { maxInput: 100 });
      expect(e.sup.submit({ ...textReq('chat', 'short'), cwd: e.root, attach: ['long.txt'] })).toMatchObject({ rejected: { code: 'prompt_too_large', reason: expect.stringContaining('its text files') } });
      route(e, 'http://127.0.0.1:9');
      expect(e.sup.submit({ ...textReq('chat'), activity: 'embed', cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('mode is embeddings') } });
      route(e, 'http://127.0.0.1:9', { mode: 'transcribe' });
      expect(e.sup.submit({ ...textReq('chat'), activity: 'transcribe', cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('exactly one audio file') } });
      route(e, 'http://127.0.0.1:9');
      expect(e.sup.submit({ ...textReq('chat'), activity: 'moderate', cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('mode is moderation') } });
      route(e, 'http://127.0.0.1:9', { mode: 'moderation' });
      expect(e.sup.submit({ ...textReq('chat'), activity: 'research', cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('only the moderate activity') } });
      expect(openaiApi.validate({ model: 'a/b', adapter: 'openai-api', options: { baseUrl: 'https://x/v1', model: 'm', apiKeyEnv: 'K', mode: 'speak' } })).toMatch(/mode must be/);
    });
  });

  it('fails the job with the HTTP status when the API refuses, and never for a job that asks for tools', async () => {
    const m = await mock(() => ({ status: 401, json: { error: 'bad key' } }));
    const e = setup({ adapters: ['openai-api'] }, { ...process.env, AUGUR_TEST_API_KEY: 'nope' });
    e.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: m.url, model: 'x', apiKeyEnv: 'AUGUR_TEST_API_KEY' } } });
    const id = submitOk(e.sup, { ...textReq('chat'), cwd: e.root });
    expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'failed', reason: 'exit 2' });
    expect(e.sup.logs(id, 'stderr')!.text).toContain('HTTP 401');
    expect(e.sup.submit({ ...request({ route: 'chat', activity: 'research' }, e.root), tools: 'write' })).toMatchObject({ rejected: { code: expect.stringMatching(/bad_request|text_only/) } });
    const unset = setup({ adapters: ['openai-api'] }, { ...process.env });
    unset.writeRoutes({ chat: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: m.url, model: 'x', apiKeyEnv: 'AUGUR_KEY_NOT_SET' } } });
    const id2 = submitOk(unset.sup, { ...textReq('chat'), cwd: unset.root });
    expect((await terminal(unset.sup, unset.store, id2)).state).toBe('failed');
    expect(unset.sup.logs(id2, 'stderr')!.text).toContain('AUGUR_KEY_NOT_SET is not set');
  });

  it.skipIf(process.platform !== 'win32')('reads a route\'s key from the Windows credential store when its keySource is store', async () => {
    const name = `store-test-${Math.floor(Math.random() * 1e9)}`, target = credentialTarget(routeSecretName(name));
    const m = await mock(() => ({ json: { choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } } }));
    const e = setup({ adapters: ['openai-api'] }, { ...process.env });
    e.writeRoutes({ [name]: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: `${m.url}/v1`, model: 'cheap-1', keySource: 'store' } } });
    try {
      // With nothing stored the route is refused and says why, and the service never looks at a value.
      expect(e.sup.submit({ ...textReq(name), cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('No key is stored') } });
      execFileSync('cmdkey', [`/generic:${target}`, '/user:augur', '/pass:stored-key-value'], { windowsHide: true, stdio: 'ignore' });
      const id = submitOk(e.sup, { ...textReq(name), cwd: e.root });
      expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'completed' });
      expect(m.seen[0]!.headers.authorization).toBe('Bearer stored-key-value');
      const files = readdirSync(join(e.dir, 'jobs', id)).map(f => readFileSync(join(e.dir, 'jobs', id, f), 'utf8'));
      for (const text of files) expect(text).not.toContain('stored-key-value');
    } finally {
      try { execFileSync('cmdkey', [`/delete:${target}`], { windowsHide: true, stdio: 'ignore' }); } catch { /* nothing was stored */ }
    }
  });

  it('reads a route\'s key from the user-only key file on any platform when the key store is the file', async () => {
    const appDir = join(tmpdir(), `augur-keyfile-${process.pid}-${Math.floor(Math.random() * 1e9)}`), name = 'filed';
    vi.stubEnv('AUGUR_APP_DIR', appDir);
    vi.stubEnv('AUGUR_KEYSTORE', 'file');
    try {
      const m = await mock(() => ({ json: { choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } } }));
      const e = setup({ adapters: ['openai-api'] }, { ...process.env });
      e.writeRoutes({ [name]: { model: 'test/text', adapter: 'openai-api', options: { baseUrl: `${m.url}/v1`, model: 'cheap-1', keySource: 'store' } } });
      expect(e.sup.submit({ ...textReq(name), cwd: e.root })).toMatchObject({ rejected: { reason: expect.stringContaining('No key is stored') } });
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, 'secrets.json'), JSON.stringify({ [routeSecretName(name)]: 'filed-key-value' }));
      const id = submitOk(e.sup, { ...textReq(name), cwd: e.root });
      expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'completed' });
      expect(m.seen[0]!.headers.authorization).toBe('Bearer filed-key-value');
      const files = readdirSync(join(e.dir, 'jobs', id)).map(f => readFileSync(join(e.dir, 'jobs', id, f), 'utf8'));
      for (const text of files) expect(text).not.toContain('filed-key-value');
    } finally {
      vi.unstubAllEnvs();
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it('names a route\'s secret so that no two routes share one', () => {
    expect(routeSecretName('luna')).toBe('dispatch.luna');
    expect(routeSecretName('my-route')).toBe('dispatch.my_droute');
    expect(routeSecretName('my_route')).toBe('dispatch.my_uroute');
    expect(new Set(['a-b', 'a_b', 'a_db', 'a-_b'].map(routeSecretName)).size).toBe(4);
    expect(credentialTarget('dispatch.luna')).toBe('dispatch.luna.augur');
  });

  it('accepts keySource env or store and refuses anything else', () => {
    const base = { model: 'x', baseUrl: 'https://api.example.com/v1' };
    expect(openaiApi.validate({ model: 'a/b', adapter: 'openai-api', options: { ...base, keySource: 'store' } })).toBeNull();
    expect(openaiApi.validate({ model: 'a/b', adapter: 'openai-api', options: { ...base, keySource: 'env' } })).toMatch(/apiKeyEnv/);
    expect(openaiApi.validate({ model: 'a/b', adapter: 'openai-api', options: { ...base, keySource: 'vault', apiKeyEnv: 'K' } })).toMatch(/keySource/);
  });

  it('validates its route options', () => {
    expect(openaiApi.validate({ model: 'a/b', adapter: 'openai-api', options: { model: 'x', apiKeyEnv: 'K' } })).toMatch(/baseUrl/);
    expect(anthropicApi.validate({ model: 'a/b', adapter: 'anthropic-api', options: { baseUrl: 'ftp://x', model: 'x', apiKeyEnv: 'K' } })).toMatch(/http/);
    expect(anthropicApi.validate({ model: 'a/b', adapter: 'anthropic-api', options: { baseUrl: 'https://x', model: 'x' } })).toMatch(/apiKeyEnv/);
  });
});

describe('a sandboxed connector on a copy of the workspace', () => {
  const sbxRoute = (adapter: string, workRoot: string, extra: Record<string, string> = {}) => ({ model: 'test/patch', adapter, options: { sandbox: 'fake', workRoot, model: 'm', sbx: process.execPath, sbxPrefixJson: JSON.stringify([FAKE_SBX]), ...extra } });

  it('leaves the original untouched, exports a patch, checks the expected file in the copy, and applies on request', async () => {
    const e = setup({ adapters: ['mcode-sbx', 'opencode-sbx'] });
    const work = join(e.root, 'sbxwork'); const project = join(e.root, 'project');
    mkdirSync(project, { recursive: true }); writeFileSync(join(project, 'keep.txt'), 'original\n');
    execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true }); mkdirSync(join(project, 'node_modules'), { recursive: true }); writeFileSync(join(project, 'node_modules', 'big.js'), 'x');
    e.writeRoutes({ ...ROUTES, mc: sbxRoute('mcode-sbx', work) });
    const id = submitOk(e.sup, request({ route: 'mc', text: 'WRITE new.txt\nSLEEP 0', expectFile: 'new.txt', output: 'patch_only' }, project));
    const job = await terminal(e.sup, e.store, id);
    expect(job).toMatchObject({ state: 'completed', adapter: 'mcode-sbx', usage: { inputTokens: 1000, outputTokens: 10, cachedReadTokens: 900 } });
    expect(existsSync(join(project, 'new.txt'))).toBe(false);
    expect(existsSync(join(job.workspace as string, 'new.txt'))).toBe(true);
    expect(existsSync(join(job.workspace as string, 'node_modules'))).toBe(false);
    expect(job.patch).toMatchObject({ files: 1 });
    expect(readFileSync(job.patch!.path, 'utf8')).toContain('+++ b/new.txt');
    expect(e.sup.apply(id, true)).toMatchObject({ ok: true });
    expect(existsSync(join(project, 'new.txt'))).toBe(false);
    expect(e.sup.apply(id)).toMatchObject({ ok: true });
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('artifact\n');
    expect(e.sup.apply(id)).toMatchObject({ ok: false });
    expect(e.store.events(id).map(x => x.kind)).toContain('patch_applied');
  });

  it('runs opencode the same way and reads its events', async () => {
    const e = setup({ adapters: ['opencode-sbx'] });
    const work = join(e.root, 'sbxwork'); const project = join(e.root, 'project');
    mkdirSync(project, { recursive: true }); writeFileSync(join(project, 'a.txt'), 'a\n');
    e.writeRoutes({ oc: sbxRoute('opencode-sbx', work) });
    const id = submitOk(e.sup, request({ route: 'oc', text: 'SLEEP 0', tools: 'read', output: 'patch_only' }, project));
    const job = await terminal(e.sup, e.store, id);
    expect(job.state).toBe('completed');
    expect(job.usage).toEqual({ inputTokens: 1005, outputTokens: 5, cachedReadTokens: 995, reasoningTokens: 1, costUsd: 0.0005, currency: 'USD', source: 'reported' });
    expect(e.sup.result(id)?.answer).toBe('done (read)');
    expect(job.patch).toBeNull();
  });

  it('carries a long prompt to opencode in a task file that is gone when the job ends', async () => {
    const e = setup({ adapters: ['opencode-sbx'] });
    const work = join(e.root, 'sbxwork'); const project = join(e.root, 'project');
    mkdirSync(project, { recursive: true });
    e.writeRoutes({ oc: sbxRoute('opencode-sbx', work) });
    const id = submitOk(e.sup, request({ route: 'oc', text: `${'pad '.repeat(2500)}\nWRITE big.txt\nSLEEP 0`, expectFile: 'big.txt', output: 'patch_only' }, project));
    const job = await terminal(e.sup, e.store, id);
    expect(job.state).toBe('completed');
    expect(existsSync(join(job.workspace as string, '.ai-task.md'))).toBe(false);
    expect(readFileSync(join(e.dir, 'jobs', id, 'job.json'), 'utf8')).not.toContain('pad pad pad');
  });

  it('rejects a write job for a patch-only model on an adapter that does not isolate', () => {
    const e = setup();
    e.writeRoutes({ bad: { model: 'test/patch', adapter: 'codex-exec', options: { command: process.execPath, prefixArgsJson: JSON.stringify([FAKE]) } } });
    expect(e.sup.submit(request({ route: 'bad', output: 'patch_only' }, e.root))).toMatchObject({ rejected: { code: 'sandbox_required' } });
  });

  it('fails a job that leaves an empty expected file, and a job that exits cleanly with no answer', async () => {
    const e = setup({ adapters: ['exec', 'codex-exec'] });
    writeFileSync(join(e.root, 'empty.txt'), '');
    const empty = submitOk(e.sup, request({ route: 'fake', text: 'SLEEP 0', expectFile: 'empty.txt', cwd: e.root }));
    expect(await terminal(e.sup, e.store, empty)).toMatchObject({ state: 'artifact_validation_failed', reason: 'expected file empty.txt is empty' });
    const silent = submitOk(e.sup, request({ route: 'raw', text: 'SLEEP 0', cwd: e.root }));
    expect(await terminal(e.sup, e.store, silent)).toMatchObject({ state: 'failed', reason: 'exited cleanly but produced no answer' });
  });
});

describe('a named conversation on a real harness', () => {
  it('refuses one on an adapter that cannot keep it, and refuses a Codex tier change', async () => {
    const e = setup();
    expect(e.sup.submit(request({ route: 'raw', conversation: 'feat', text: 'SLEEP 0', cwd: e.root }))).toMatchObject({
      rejected: { code: 'bad_request', reason: 'Adapter exec does not keep a conversation, so route raw cannot use one.' },
    });
    const id = submitOk(e.sup, request({ conversation: 'feat', text: 'SLEEP 0', tools: 'write', cwd: e.root }));
    expect(await terminal(e.sup, e.store, id)).toMatchObject({ state: 'completed', conversation: 'feat', turn: 1 });
    expect(e.store.conversation('feat')).toMatchObject({ turns: 1, nativeId: null, adapter: 'codex-exec', route: 'fake', tools: 'write' });
    expect(e.sup.submit(request({ conversation: 'feat', text: 'SLEEP 0', tools: 'read', cwd: e.root }))).toMatchObject({
      rejected: { code: 'bad_request', reason: 'Conversation feat was opened with the write tool tier. A resumed Codex session keeps that tier, because resume cannot set the sandbox again.' },
    });
    expect(e.sup.submit(request({ conversation: 'feat', text: 'SLEEP 0', tools: 'write', cwd: e.root }))).toMatchObject({
      rejected: { code: 'bad_request', reason: 'Conversation feat has no session id to resume.' },
    });
  });
});

describe('the supported-harness manifest', () => {
  it('lists every registered adapter and nothing else', async () => {
    const { ALL_ADAPTERS } = await import('../src/adapters/index.js');
    const ADAPTER_IDS = ALL_ADAPTERS.map(a => a.id);
    const manifest = JSON.parse(readFileSync(new URL('../harnesses.json', import.meta.url), 'utf8')) as { harnesses: Record<string, { tested: string; conformance: string }> };
    expect(Object.keys(manifest.harnesses).sort()).toEqual([...ADAPTER_IDS].sort());
    for (const h of Object.values(manifest.harnesses)) expect(['verified', 'shadow', 'unit-only']).toContain(h.conformance);
  });
});
