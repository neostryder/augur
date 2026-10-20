import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobRequest, RouteConfig, Toolkit } from '@augur/dispatch-protocol';
import type { Adapter } from '@augur/dispatch-protocol';
import { codexExec, copilotExec, falApi, grokExec } from '../src/adapters/index.js';
import { codexToolkitArgs } from '../src/adapters/codex-exec.js';
import { copilotToolkitArgs } from '../src/adapters/copilot-exec.js';
import { loadToolkits } from '../src/toolkits.js';
import { makeEnv, request, submitOk, terminal } from './harness.js';
import type { Env } from './harness.js';

const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); for (const s of servers.splice(0)) s.close(); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'augur-tk-')); dirs.push(d); return d; };

const kit: Toolkit = { pack: 'rea', mcp: { rea: { command: 'node.exe', args: ['C:/rea/rea.mjs', 'mcp'], env: { REA_X: '1' }, denyTools: ['start_frida_session', 'instrument_with_frida'] } } };

describe('toolkits.json', () => {
  it('gives no kits when the file is missing', () => {
    expect(loadToolkits(temp())).toEqual({ kits: {}, notes: [] });
  });

  it('loads a kit by activity and skips what it cannot use, with a note for each', () => {
    const home = temp();
    writeFileSync(join(home, 'toolkits.json'), JSON.stringify({
      reverse_engineering: { pack: 'rea', mcp: { rea: { command: ' node.exe ', args: ['a.mjs'], env: { OK: '1', 'bad name': '2' }, denyTools: ['x_tool'] }, 'no good': { command: 'c' }, nocmd: {}, badargs: { command: 'c', args: [1] }, baddeny: { command: 'c', denyTools: ['a/b'] } } },
      not_an_activity: { pack: 'x' },
      write_code: { pack: '../escape' },
    }));
    const { kits, notes } = loadToolkits(home);
    expect(Object.keys(kits)).toEqual(['reverse_engineering']);
    expect(kits.reverse_engineering).toEqual({ pack: 'rea', mcp: { rea: { command: 'node.exe', args: ['a.mjs'], env: { OK: '1' }, denyTools: ['x_tool'] } } });
    expect(notes.join('\n')).toMatch(/no good/);
    expect(notes.join('\n')).toMatch(/nocmd.*no command/);
    expect(notes.join('\n')).toMatch(/badargs/);
    expect(notes.join('\n')).toMatch(/baddeny/);
    expect(notes.join('\n')).toMatch(/not_an_activity/);
    expect(notes.join('\n')).toMatch(/write_code/);
  });

  it('uses nothing from a file that is not an object', () => {
    const home = temp();
    writeFileSync(join(home, 'toolkits.json'), '[1]');
    expect(loadToolkits(home).kits).toEqual({});
    writeFileSync(join(home, 'toolkits.json'), '{nope');
    expect(loadToolkits(home).notes[0]).toMatch(/could not be read/);
  });
});

describe('toolkit flags per harness', () => {
  it('codex: command, args, env and disabled tools as -c overrides, and nothing without a kit', () => {
    expect(codexToolkitArgs(undefined)).toEqual([]);
    expect(codexToolkitArgs(kit)).toEqual([
      '-c', 'mcp_servers.rea.command="node.exe"', '-c', 'mcp_servers.rea.args=["C:/rea/rea.mjs","mcp"]',
      '-c', 'mcp_servers.rea.env={REA_X="1"}', '-c', 'mcp_servers.rea.disabled_tools=["start_frida_session","instrument_with_frida"]']);
  });

  it('copilot: one additional MCP config and a deny flag per tool', () => {
    expect(copilotToolkitArgs(undefined)).toEqual([]);
    const a = copilotToolkitArgs(kit);
    expect(a[0]).toBe('--additional-mcp-config');
    expect(JSON.parse(a[1] as string)).toEqual({ mcpServers: { rea: { type: 'local', command: 'node.exe', args: ['C:/rea/rea.mjs', 'mcp'], env: { REA_X: '1' }, tools: ['*'] } } });
    expect(a.slice(2)).toEqual(['--deny-tool=rea(start_frida_session)', '--deny-tool=rea(instrument_with_frida)']);
  });

  it('plans carry the kit only on harnesses that can take it', () => {
    const req = (over: Partial<JobRequest> = {}): JobRequest => request(over, tmpdir());
    const ctx = { jobDir: 'C:/jobs/j1', prompt: 'go', workspace: null, toolkit: kit };
    const codex = codexExec.plan(req(), { model: 'gpt', adapter: 'codex-exec', options: {} }, ctx);
    expect(codex.args.join(' ')).toContain('mcp_servers.rea.command');
    expect(codex.args.at(-1)).toBe('-');
    const copilot = copilotExec.plan(req(), { model: 'm', adapter: 'copilot-exec', options: {} }, ctx);
    expect(copilot.args).toContain('--additional-mcp-config');
    const grok = grokExec.plan(req(), { model: 'g', adapter: 'grok-exec', options: {} }, ctx);
    expect(grok.args).toContain('MCPTool(rea__start_frida_session)');
    expect(grokExec.toolkit).toBe('registered');
    expect(codexExec.toolkit).toBe('inject');
    expect(copilotExec.toolkit).toBe('inject');
    const without = codexExec.plan(req(), { model: 'gpt', adapter: 'codex-exec', options: {} }, { ...ctx, toolkit: undefined });
    expect(without.args.join(' ')).not.toContain('mcp_servers');
  });
});

const route = (options: Record<string, string | number | boolean>): RouteConfig => ({ model: 'minimax/h3-max-turbo', adapter: 'fal-api', options });
const RATES = JSON.stringify({ '480P': 0.05, '768P': 0.1, '1080P': 0.2 });
const GOOD = { endpoint: 'minimax/h3-max-turbo/image-to-video', usdPerSecondJson: RATES };

describe('fal adapter', () => {
  it('refuses a route without an endpoint or a price list, and a bad endpoint, price, resolution or limit', () => {
    expect(falApi.validate(route({}))).toContain('endpoint');
    expect(falApi.validate(route({ endpoint: 'minimax/h3-max-turbo/image-to-video' }))).toContain('usdPerSecondJson');
    expect(falApi.validate(route({ ...GOOD, endpoint: 'https://evil.example/x' }))).toContain('endpoint');
    expect(falApi.validate(route({ ...GOOD, usdPerSecondJson: '[1]' }))).toContain('JSON object');
    expect(falApi.validate(route({ ...GOOD, usdPerSecondJson: '{"4K": 1}' }))).toContain('usdPerSecondJson');
    expect(falApi.validate(route({ ...GOOD, usdPerSecondJson: '{"768P": -1}' }))).toContain('usdPerSecondJson');
    expect(falApi.validate(route({ ...GOOD, resolution: '720P' }))).toContain('resolution');
    expect(falApi.validate(route({ ...GOOD, maxUsd: 0 }))).toContain('maxUsd');
    expect(falApi.validate(route({ ...GOOD, keySource: 'env' }))).toContain('apiKeyEnv');
    expect(falApi.validate(route(GOOD))).toBeNull();
    expect(falApi.validate(route({ ...GOOD, keySource: 'env', apiKeyEnv: 'FAL_KEY', resolution: '1080P', duration: 6, promptExpansion: 'quality', maxUsd: 2 }))).toBeNull();
  });

  it('plans only video generation, with no charter and the key by name, never by value', () => {
    expect(falApi.charterEngine).toBeNull();
    const base = request({ activity: 'generate_video', tools: 'read', output: 'text_only', route: 'fal-h3' }, tmpdir());
    const p = falApi.plan(base, route(GOOD), { jobDir: 'C:/jobs/j1', prompt: 'a fox runs', workspace: null });
    expect(p.stdin).toBe('a fox runs');
    expect(p.args).toEqual(expect.arrayContaining(['--endpoint', 'minimax/h3-max-turbo/image-to-video', '--resolution', '768P', '--duration', '5', '--max-usd', '0.5', '--key-name']));
    expect(p.args).not.toContain('--key-env');
    expect(() => falApi.plan({ ...base, activity: 'write_code' }, route(GOOD), { jobDir: 'j', prompt: 'x', workspace: null })).toThrow(/generate_video/);
    expect(() => falApi.plan({ ...base, tools: 'write' }, route(GOOD), { jobDir: 'j', prompt: 'x', workspace: null })).toThrow(/text_only/);
    const env = falApi.plan(base, route({ ...GOOD, keySource: 'env', apiKeyEnv: 'FAL_KEY' }), { jobDir: 'j', prompt: 'x', workspace: null });
    expect(env.args).toEqual(expect.arrayContaining(['--key-env', 'FAL_KEY']));
  });

  it('reads the script result and a failure line', () => {
    const ok = falApi.extract({ stdout: JSON.stringify({ answer: ' done ', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.5, currency: 'USD' } }), stdoutPath: '', stderr: '', exitCode: 0, jobDir: tmpdir(), workspace: null });
    expect(ok).toEqual({ answer: 'done', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.5, currency: 'USD', source: 'reported' } });
    const bad = falApi.extract({ stdout: '', stdoutPath: '', stderr: 'first\nHTTP 401: no\n', exitCode: 2, jobDir: tmpdir(), workspace: null });
    expect(bad.failure).toBe('HTTP 401: no');
  });
});

const SCRIPT = fileURLToPath(new URL('../src/adapters/fal-call.ts', import.meta.url));
const listen = (handler: http.RequestListener): Promise<number> => new Promise(resolve => {
  const s = http.createServer(handler);
  servers.push(s);
  s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
});
interface Run { code: number | null; out: string; err: string }
function runCall(port: number, extra: string[], prompt = 'a fox runs', env: Record<string, string> = {}): Promise<Run> {
  const out = temp();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, '--endpoint', 'minimax/h3-max-turbo/image-to-video', '--queue-base', `http://127.0.0.1:${port}/`, '--key-env', 'TEST_FAL_KEY', '--out-dir', out,
      '--rates-json', RATES, '--timeout-s', '30', ...extra], { env: { ...process.env, TEST_FAL_KEY: 'secret-fal-key', ...env }, windowsHide: true });
    let o = '', e = '';
    child.stdout.on('data', d => { o += String(d); });
    child.stderr.on('data', d => { e += String(d); });
    child.on('close', code => resolve({ code, out: o.replace(out, '<out>'), err: e }));
    child.stdin.end(prompt);
    dirs.push(out);
  });
}

describe('fal-call', () => {
  it('submits, polls, fetches and saves the video, with the key only in the authorization header', async () => {
    const seen: Array<{ method: string; url: string; auth: string | undefined; noRetry: string | undefined; body: string }> = [];
    let polls = 0;
    let port = 0;
    const base = (): string => `http://127.0.0.1:${port}/`;
    port = await listen((req, res) => {
      let body = '';
      req.on('data', d => { body += String(d); });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, noRetry: req.headers['x-fal-no-retry'] as string | undefined, body });
        const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.method === 'POST') return json({ request_id: 'r1', status_url: `${base()}req/r1/status`, response_url: `${base()}req/r1`, cancel_url: `${base()}req/r1/cancel` });
        if (req.url === '/req/r1/status') return json({ status: ++polls < 2 ? 'IN_PROGRESS' : 'COMPLETED' });
        if (req.url === '/req/r1') return json({ video: { url: `${base()}files/v.mp4`, file_name: 'v.mp4', content_type: 'video/mp4' } });
        if (req.url === '/files/v.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end('VIDEO-BYTES'); }
        res.writeHead(404); res.end();
      });
    });
    const dir = temp(), frame = join(dir, 'f.png');
    writeFileSync(frame, 'PNG');
    const r = await runCall(port, ['--resolution', '768P', '--duration', '6', '--max-usd', '1', '--attachments-json', JSON.stringify([{ path: frame, kind: 'image' }])]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { answer: string; usage: { costUsd: number; currency: string } };
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0.6, currency: 'USD' });
    expect(parsed.answer).toMatch(/video\.mp4/);
    expect(r.out).not.toContain('secret-fal-key');
    const post = seen.find(s => s.method === 'POST')!;
    expect(post.url).toBe('/minimax/h3-max-turbo/image-to-video');
    expect(post.auth).toBe('Key secret-fal-key');
    expect(post.noRetry).toBe('1');
    const sent = JSON.parse(post.body) as Record<string, unknown>;
    expect(sent).toMatchObject({ prompt: 'a fox runs', duration: 6, resolution: '768P', prompt_expansion_mode: 'balanced' });
    expect(String(sent.image_url)).toMatch(/^data:image\/png;base64,/);
    expect(seen.find(s => s.url === '/files/v.mp4')!.auth).toBeUndefined();
  }, 40000);

  it('refuses a job whose estimate is over the limit, before anything is sent', async () => {
    let hits = 0;
    const port = await listen((_req, res) => { hits++; res.end('{}'); });
    const r = await runCall(port, ['--resolution', '1080P', '--duration', '10', '--max-usd', '1']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/over the route's limit/);
    expect(hits).toBe(0);
  }, 30000);

  it('refuses a resolution that has no price, and an empty prompt', async () => {
    const port = await listen((_req, res) => res.end('{}'));
    const rates = await new Promise<Run>(resolve => {
      const child = spawn(process.execPath, [SCRIPT, '--endpoint', 'a/b', '--queue-base', `http://127.0.0.1:${port}/`, '--key-env', 'K', '--out-dir', temp(), '--rates-json', '{}'], { env: { ...process.env, K: 'k' }, windowsHide: true });
      let e = '';
      child.stderr.on('data', d => { e += String(d); });
      child.on('close', code => resolve({ code, out: '', err: e }));
      child.stdin.end('hi');
    });
    expect(rates.code).toBe(3);
    expect(rates.err).toMatch(/no price per second/);
    const empty = await runCall(port, [], '   ');
    expect(empty.code).toBe(64);
  }, 30000);

  it('does not follow a redirect, so the key never reaches another host', async () => {
    let elsewhere = 0;
    const other = await listen((_req, res) => { elsewhere++; res.end('{}'); });
    const first = await listen((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${other}/x` }); res.end(); });
    const r = await runCall(first, []);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/redirect/);
    expect(r.err).not.toContain('secret-fal-key');
    expect(elsewhere).toBe(0);
  }, 30000);

  it('does not use a status address outside the queue host', async () => {
    const port = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status_url: 'http://127.0.0.1:1/s', response_url: 'http://127.0.0.1:1/r' })); });
    const r = await runCall(port, []);
    expect(r.code).toBe(66);
    expect(r.err).toMatch(/outside its queue/);
  }, 30000);

  it('reports a failed request without the key and an HTTP error body', async () => {
    const port = await listen((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"detail":"bad key"}'); });
    const r = await runCall(port, []);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/HTTP 401/);
    expect(r.err).not.toContain('secret-fal-key');
  }, 30000);

});

describe('the supervisor and toolkits', () => {
  const envs: Env[] = [];
  afterEach(() => { while (envs.length) envs.pop()!.dispose(); });
  const seen: Array<{ id: string; prompt: string; toolkit: Toolkit | undefined }> = [];
  const probe = (id: string, toolkit?: 'inject'): Adapter => ({
    id, charterEngine: 'codex', transport: 'exec', ...(toolkit ? { toolkit } : {}),
    capabilities: { permissionRequests: false, sessions: false, reportsUsage: false, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: false },
    envAllow: [], validate: () => null,
    plan(req, _route, ctx) { seen.push({ id, prompt: ctx.prompt, toolkit: ctx.toolkit }); return { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: req.cwd, env: {}, stdin: null }; },
    extract: () => ({ answer: 'ok', usage: null }),
  });

  it('adds the pack and hands the servers to an adapter that can carry them, and warns for one that cannot', async () => {
    const charter = temp();
    mkdirSync(join(charter, 'packs'), { recursive: true });
    writeFileSync(join(charter, 'core.md'), 'Core.'); writeFileSync(join(charter, 'packs', 'rea.md'), 'REA rules.');
    const e = makeEnv({ adapters: ['can', 'cannot'], runner: { charterDir: charter, ambient: 'keep', failover: 'off' } } as never, process.env, { extra: [probe('can', 'inject'), probe('cannot')] });
    envs.push(e);
    e.writeRoutes({ can: { model: 'test/fake', adapter: 'can', options: {} }, cannot: { model: 'test/fake', adapter: 'cannot', options: {} } });
    writeFileSync(join(e.home, 'toolkits.json'), JSON.stringify({ reverse_engineering: kit }));
    seen.length = 0;
    const ok = e.sup.submit(request({ route: 'can', activity: 'reverse_engineering', cwd: e.root, text: 'look at it' }));
    if ('rejected' in ok) throw new Error(ok.rejected.reason);
    expect(ok.warnings.join(' ')).not.toMatch(/cannot carry/);
    expect(seen[0]?.toolkit).toEqual(kit);
    expect(seen[0]?.prompt).toContain('REA rules.');
    expect(e.store.get(ok.id)?.charter).toContain('rea');
    await terminal(e.sup, e.store, ok.id);
    const no = e.sup.submit(request({ route: 'cannot', activity: 'reverse_engineering', cwd: e.root, text: 'look at it' }));
    if ('rejected' in no) throw new Error(no.rejected.reason);
    expect(no.warnings.join(' ')).toContain('Route cannot cannot carry the tools for reverse_engineering, so the job runs without them.');
    expect(seen[1]?.toolkit).toBeUndefined();
    expect(seen[1]?.prompt).toContain('REA rules.');
    await terminal(e.sup, e.store, no.id);
    const other = submitOk(e.sup, request({ route: 'can', activity: 'write_code', cwd: e.root, text: 'x' }));
    expect(seen[2]?.toolkit).toBeUndefined();
    expect(seen[2]?.prompt).not.toContain('REA rules.');
    await terminal(e.sup, e.store, other);
  }, 90000);
});
