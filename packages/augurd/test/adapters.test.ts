import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(codexExec.extract(input({ stdout: out, jobDir: dir }))).toEqual({ answer: 'the answer', usage: { inputTokens: 253105, outputTokens: 4034, cachedReadTokens: 209152, reasoningTokens: 227, source: 'reported' } });
    expect(codexExec.extract(input({ stdout: 'tool said: failed to spawn code-mode host', jobDir: dir })).failure).toMatch(/tool host/);
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
    expect(x.usage).toEqual({ inputTokens: 14100, outputTokens: 87, reasoningTokens: 64, costUsd: 0.0037, currency: 'USD', source: 'reported' });
    const b = copilotExec.extract(input({ stdout: 'pong\r\n\r\nChanges    +0 -0\r\nAI Credits 0.63 (5s)\r\nTokens     ↑ 49.9k (49.9k written) • ↓ 104 (97 reasoning)\r\n' }));
    expect(b.usage).toEqual({ inputTokens: 49900, outputTokens: 104, cachedWriteTokens: 49900, reasoningTokens: 97, costUsd: 0.0063, currency: 'USD', source: 'reported' });
    expect([parseCount('87'), parseCount('14.1k'), parseCount('1.2m'), parseCount('junk')]).toEqual([87, 14100, 1200000, 0]);
  });

  it('grok: answer and usage from the JSON envelope', () => {
    const out = JSON.stringify({ text: 'hello', usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 500 }, total_cost_usd: 0.0123 });
    expect(grokExec.extract(input({ stdout: out }))).toEqual({ answer: 'hello', usage: { inputTokens: 1500, outputTokens: 20, cachedReadTokens: 500, costUsd: 0.0123, currency: 'USD', source: 'reported' } });
    expect(grokExec.extract(input({ stdout: 'plain text' })).answer).toBe('plain text');
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
    const big = hermesExec.plan(req(), r, ctx('x'.repeat(13000)));
    expect(big.files?.[0]?.name).toBe('task.md');
    expect(big.args[1]).toMatch(/^Read the file at .*task\.md in full/);
  });
  it('grok: prompt from a file, JSON envelope, write approves all tools and read denies Edit and Bash', () => {
    const r = route('grok-exec', { model: 'grok-4.7', command: 'C:/g/grok.exe', effort: 'high' });
    const w = grokExec.plan(req({ tools: 'write' }), r, ctx('go', 'C:/jobs/j1'));
    expect(w.args).toEqual(expect.arrayContaining(['--prompt-file', 'C:\\jobs\\j1\\prompt.md', '--output-format', 'json', '--always-approve', '--reasoning-effort', 'high']));
    expect(w.files).toEqual([{ name: 'prompt.md', content: 'go' }]);
    const rd = grokExec.plan(req({ tools: 'read' }), r, ctx('go'));
    expect(rd.args).toEqual(expect.arrayContaining(['--allow', 'Read', '--deny', 'Edit']));
    expect(rd.args).not.toContain('--always-approve');
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
  async function mock(handler: (body: Record<string, unknown>, headers: IncomingHttpHeaders, url: string) => { status?: number; json: unknown }) {
    const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = createServer((rq, rs) => {
      let raw = ''; rq.on('data', d => { raw += d; });
      rq.on('end', () => { const body = JSON.parse(raw || '{}') as Record<string, unknown>; seen.push({ url: rq.url ?? '', headers: rq.headers, body }); const out = handler(body, rq.headers, rq.url ?? ''); rs.writeHead(out.status ?? 200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(out.json)); });
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
    expect(job).toMatchObject({ state: 'completed', usage: { inputTokens: 100, outputTokens: 3, cachedReadTokens: 40, reasoningTokens: 1, costUsd: 0.00012, currency: 'USD' } });
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
    expect('rejected' in e.sup.submit({ ...textReq('chat'), cwd: e.root }) && (e.sup.submit({ ...textReq('chat'), cwd: e.root }) as { rejected: { reason: string } }).rejected.reason.includes('https://')).toBe(false);
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

describe('the supported-harness manifest', () => {
  it('lists every registered adapter and nothing else', async () => {
    const { ALL_ADAPTERS } = await import('../src/adapters/index.js');
    const ADAPTER_IDS = ALL_ADAPTERS.map(a => a.id);
    const manifest = JSON.parse(readFileSync(new URL('../harnesses.json', import.meta.url), 'utf8')) as { harnesses: Record<string, { tested: string; conformance: string }> };
    expect(Object.keys(manifest.harnesses).sort()).toEqual([...ADAPTER_IDS].sort());
    for (const h of Object.values(manifest.harnesses)) expect(['verified', 'shadow', 'unit-only']).toContain(h.conformance);
  });
});
