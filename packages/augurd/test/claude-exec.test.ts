import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeSecretName, schemaPrompt, tierNote } from '@augur/dispatch-protocol';
import type { ExtractInput, JobRequest, PlanContext, RouteConfig, Toolkit } from '@augur/dispatch-protocol';
import { claudeExec } from '../src/adapters/index.js';
import { claudeToolkitArgs } from '../src/adapters/claude-exec.js';
import { MAX_COMMAND_LINE } from '../src/adapters/util.js';
import { classifyFailure } from '../src/failover.js';
import { isUsageLimit } from '../src/route-limits.js';

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(process.cwd(), '.claude-test-')); dirs.push(d); return d; };
afterEach(() => { vi.unstubAllEnvs(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const route = (options: RouteConfig['options'] = {}): RouteConfig => ({ model: 'test/fake', adapter: 'claude-exec', options: { model: 'claude-fixture', command: process.execPath, ...options } });
const req = (over: Partial<JobRequest> = {}): JobRequest => ({ route: 'claude', activity: 'write_code', dataTier: 'internal', tools: 'write', output: 'write_files', cwd: process.cwd(), prompt: { text: 'hello' }, caller: { kind: 'other', label: 'test' }, ...over });
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ jobDir: process.cwd(), prompt: 'hello', workspace: null, ...over });
const input = (stdout: string, stderr = ''): ExtractInput => ({ stdout, stderr, stdoutPath: '', exitCode: 0, jobDir: process.cwd(), workspace: null });
const fixture = (name: string) => readFileSync(new URL(`./fixtures/claude-result-${name}.json`, import.meta.url), 'utf8');
const claudeArgs = (args: string[]) => args.slice(args.indexOf('--') + 1);
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const toolkit: Toolkit = { mcp: { s: { command: 'node', args: ['server.mjs'], env: { MODE: 'read' }, denyTools: ['t'] }, other: { command: 'other', args: [] } } };

describe('claude result extraction', () => {
  it.each([
    ['success', 'ok', 117, 4, 0, 0, 0.000548, '8d87330e-fd63-4a05-a5fe-abc5fc2c23fd'],
    ['read', 'The file contains one line:\n\n> hello from probe', 1613, 156, 1482, 125, 0.0040654, '98ee67ea-9ab9-4460-bf3c-3fb4df5f032f'],
    ['max-turns', null, 745, 108, 0, 741, 0.005881, 'bff197a0-c489-478c-8f46-3d3e728dab8c'],
  ] as const)('reads the %s fixture', (name, answer, inputTokens, outputTokens, read, written, costUsd, sessionId) => {
    const result = claudeExec.extract(input(`\n${fixture(name)}\n`));
    expect(result.answer).toBe(answer);
    expect(result.sessionId).toBe(sessionId);
    expect(result.usage).toEqual({ inputTokens, outputTokens, ...(read ? { cachedReadTokens: read } : {}), ...(written ? { cachedWriteTokens: written } : {}), costUsd, currency: 'USD', source: 'reported' });
    expect(Boolean(result.failure)).toBe(name === 'max-turns');
  });

  it('keeps malformed output as text and explains empty output', () => {
    expect(claudeExec.extract(input('  not JSON\n'))).toEqual({ answer: 'not JSON', usage: null });
    expect(claudeExec.extract(input('\n', 'first\nlast error\n\n'))).toEqual({ answer: null, usage: null, failure: 'last error' });
    expect(claudeExec.extract(input(''))).toEqual({ answer: null, usage: null, failure: 'claude printed no result' });
    for (const text of ['null', '[]']) expect(claudeExec.extract(input(text))).toEqual({ answer: text, usage: null });
  });

  it.each(['error_max_turns', 'error_max_budget_usd'])('%s does not hold or fail over the route', subtype => {
    const result = claudeExec.extract(input(JSON.stringify({ subtype, is_error: true, errors: ['limit reached'] })));
    expect(result.failure).toContain(subtype === 'error_max_turns' ? 'turn count' : 'per-job dollar cap');
    expect(isUsageLimit(result.failure!)).toBe(false);
    expect(classifyFailure({ failure: result.failure, tools: 'read' })).toEqual({ retry: false, why: 'not retryable' });
  });

  it.each([{ api_error_status: 429 }, { api_error_status: 402 }, { result: 'Credit balance is too low' }, { errors: ['You have reached your usage limit'] }])('recognizes a provider allowance failure: %j', detail => {
    const result = claudeExec.extract(input(JSON.stringify({ subtype: 'error_during_execution', is_error: true, ...detail })));
    expect(isUsageLimit(result.failure!)).toBe(true);
    expect(classifyFailure({ failure: result.failure, tools: 'read' })).toEqual({ retry: true, why: 'provider limit' });
  });

  it('treats every non-success subtype and is_error as a failure', () => {
    for (const envelope of [{ subtype: 'other' }, { subtype: 'success', is_error: true }]) expect(claudeExec.extract(input(JSON.stringify(envelope))).failure).toBeTruthy();
  });
});

describe('claude launch plans', () => {
  it.each(['none', 'read', 'write', 'full'] as const)('restricts the %s tier and applies default caps', tools => {
    const plan = claudeExec.plan(req({ tools }), route(), ctx()), args = claudeArgs(plan.args);
    expect(plan).toMatchObject({ command: process.execPath, cwd: process.cwd(), env: {}, files: [] });
    expect(args.slice(0, 9)).toEqual(['-p', '--output-format', 'json', '--model', 'claude-fixture', '--max-turns', '40', '--max-budget-usd', '2']);
    expect(args).toContain('--bare');
    expect(args).toContain('--no-session-persistence');
    expect(value(args, '--permission-mode')).toBe(tools === 'none' || tools === 'read' ? 'dontAsk' : 'bypassPermissions');
    if (tools === 'none') expect(value(args, '--tools')).toBe('');
    else if (tools === 'read') {
      expect(value(args, '--tools')).toBe('Read,Grep,Glob');
      expect(value(args, '--disallowedTools')).toBe('Edit,Write,NotebookEdit,Bash,PowerShell');
    } else expect(args).not.toContain('--tools');
    expect(plan.stdin).toBe(tierNote(tools, 'hello'));
    expect(plan.args).toContain('--fallback-key-name');
    expect(value(plan.args, '--fallback-key-name')).toBe('claude-api.apiKey');
  });

  it('allows web tools on read jobs and keeps none jobs without built-in tools', () => {
    for (const tools of ['read', 'none'] as const) {
      const args = claudeArgs(claudeExec.plan(req({ tools }), route({ allowWeb: true }), ctx()).args);
      expect(value(args, '--tools')).toBe(tools === 'read' ? 'Read,Grep,Glob,WebSearch,WebFetch' : '');
    }
  });

  it('applies route caps, effort precedence, and ambient precedence', () => {
    const r = route({ maxTurns: 7, maxBudgetUsd: 0.5, effort: 'low', ambient: 'keep' });
    const args = claudeArgs(claudeExec.plan(req({ effort: 'max' }), r, ctx({ ambient: 'trim' })).args);
    expect(value(args, '--max-turns')).toBe('7'); expect(value(args, '--max-budget-usd')).toBe('0.5');
    expect(value(args, '--effort')).toBe('max'); expect(args).not.toContain('--bare');
    expect(value(claudeArgs(claudeExec.plan(req(), r, ctx()).args), '--effort')).toBe('low');
    expect(claudeExec.plan(req(), route(), ctx({ ambient: 'keep' })).args).not.toContain('--bare');
    expect(claudeExec.plan(req(), route({ ambient: 'trim' }), ctx({ ambient: 'keep' })).args).toContain('--bare');
    expect(() => claudeExec.plan(req({ effort: 'wrong' }), route(), ctx())).toThrow(/effort/);
  });

  it.each([true, false])('uses a named session with fresh=%s', fresh => {
    const resume = { id: 'd9b30d1d-b19f-426f-8da1-f67790505bc8', fresh, name: 'test' };
    const args = claudeArgs(claudeExec.plan(req(), route(), ctx({ resume })).args);
    expect(value(args, fresh ? '--session-id' : '--resume')).toBe(resume.id);
    expect(args).not.toContain('--no-session-persistence');
    expect(() => claudeExec.plan(req(), route(), ctx({ resume: { ...resume, id: null } }))).toThrow(/session id/);
  });

  it.each(['none', 'read', 'write', 'full'] as const)('injects toolkit servers on %s jobs', tools => {
    const args = claudeArgs(claudeExec.plan(req({ tools }), route(), ctx({ toolkit })).args);
    expect(JSON.parse(value(args, '--mcp-config')!)).toEqual({ mcpServers: { s: { command: 'node', args: ['server.mjs'], env: { MODE: 'read' } }, other: { command: 'other', args: [] } } });
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('mcp__s__t') - 1, args.indexOf('mcp__s__t') + 1)).toEqual(['--disallowedTools', 'mcp__s__t']);
    if (tools === 'read' || tools === 'none') {
      expect(value(args, '--allowedTools')).toBe('mcp__s'); expect(args).toContain('mcp__other');
    } else expect(args).not.toContain('--allowedTools');
    expect(claudeToolkitArgs(undefined)).toEqual([]);
  });

  it('strips cache marker lines, keeps the tier note, and leaves schemas in the prompt', () => {
    const schema = { type: 'object' };
    const prompt = schemaPrompt('standing\r\n<!-- augur:cache-break -->\r\njob', schema, 'claude-exec');
    const plan = claudeExec.plan(req({ schema, tools: 'read' }), route(), ctx({ prompt }));
    expect(plan.stdin).not.toContain('<!-- augur:cache-break -->');
    expect(plan.stdin).toContain('READ-ONLY TASK'); expect(plan.stdin).toContain(JSON.stringify(schema));
    expect(plan.args).not.toContain('--json-schema');
  });

  it('rejects large arguments without counting a long stdin prompt', () => {
    expect(() => claudeExec.plan(req(), route(), ctx({ toolkit: { mcp: { s: { command: 'node', args: ['x'.repeat(MAX_COMMAND_LINE)] } } } }))).toThrow(/MAX_COMMAND_LINE/);
    expect(claudeExec.plan(req(), route(), ctx({ prompt: 'x'.repeat(MAX_COMMAND_LINE * 2) })).stdin!.length).toBeGreaterThan(MAX_COMMAND_LINE);
  });

  it('keeps environment and stored keys out of plans', () => {
    const dir = temp(), sentinel = 'sk-ant-fixture-sentinel';
    vi.stubEnv('AUGUR_APP_DIR', dir); vi.stubEnv('AUGUR_KEYSTORE', 'file'); vi.stubEnv('CLAUDE_TEST_KEY', sentinel);
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ [routeSecretName('claude')]: sentinel, 'claude-api.apiKey': sentinel }));
    for (const keySource of ['store', 'env']) {
      const plan = claudeExec.plan(req(), route({ keySource, apiKeyEnv: 'CLAUDE_TEST_KEY' }), ctx());
      expect(JSON.stringify(plan).includes(sentinel)).toBe(false);
      expect(plan.env).toEqual({});
      if (keySource === 'store') { expect(value(plan.args, '--key-file')).toBe(join(dir, 'secrets.json')); expect(plan.args).toContain('--key-file-only'); }
      else expect(value(plan.args, '--key-env')).toBe('CLAUDE_TEST_KEY');
    }
  });

  it('resolves an npm shim without a shell', () => {
    const dir = temp(); vi.stubEnv('PATH', dir); vi.stubEnv('Path', dir);
    writeFileSync(join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '"%_prog%" "%dp0%\\cli.cjs" %*');
    const plan = claudeExec.plan(req(), { ...route(), options: { model: 'fixture' } }, ctx());
    if (process.platform === 'win32') {
      expect(value(plan.args, '--exe')).toBe(process.execPath);
      expect(JSON.parse(value(plan.args, '--exe-prefix-json')!)).toEqual([join(dir, 'cli.cjs')]);
    }
  });
});

describe('claude route validation', () => {
  it.each([
    ['model', ['', ' ', false]], ['maxTurns', [0, 501, 1.5, '40', NaN]], ['maxBudgetUsd', [0, -1, 51, '2', NaN, Infinity]],
    ['effort', ['wrong', false]], ['keySource', ['other', false]], ['apiKeyEnv', ['', false]], ['ambient', ['other', false]],
    ['allowWeb', ['true', 1]], ['command', ['', false]], ['envAllow', [true, 'ANTHROPIC_API_KEY', 'X, anthropic_base_url', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK']],
  ] as const)('rejects invalid %s values', (key, values) => {
    for (const v of values) {
      const r = route({ [key]: v });
      expect(claudeExec.validate(r)).toContain(key);
      expect(() => claudeExec.plan(req(), r, ctx())).toThrow(key);
    }
  });

  it('accepts valid options and requires a variable for env keys', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) for (const ambient of ['keep', 'trim']) {
      expect(claudeExec.validate(route({ effort, ambient, maxTurns: 500, maxBudgetUsd: 50, keySource: 'env', apiKeyEnv: 'TEST_KEY', allowWeb: true, envAllow: 'HTTP_PROXY, CUSTOM' }))).toBeNull();
    }
    expect(claudeExec.validate(route({ maxTurns: 1, maxBudgetUsd: 0.01, keySource: 'store', allowWeb: false }))).toBeNull();
    expect(claudeExec.validate(route({ keySource: 'env' }))).toContain('apiKeyEnv');
    expect(claudeExec.envAllow.some(n => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN)/.test(n))).toBe(false);
  });

  it('explains a missing executable without running claude', () => {
    vi.stubEnv('PATH', temp()); vi.stubEnv('Path', process.env.PATH!);
    const r: RouteConfig = { model: 'test/fake', adapter: 'claude-exec', options: { model: 'fixture' } };
    expect(claudeExec.validate(r)).toMatch(/claude was not found on PATH; set the command route option/);
    expect(() => claudeExec.plan(req(), r, ctx())).toThrow(/not found on PATH/);
    expect(claudeExec.version!(r)).toBeNull();
  });
});

const SCRIPT = fileURLToPath(new URL('../src/adapters/claude-call.ts', import.meta.url));
const SENTINEL = 'sk-ant-fixture-wrapper';
function runCall(args: string[], env: NodeJS.ProcessEnv = {}, stdin = 'whole prompt\nsecond line'): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += String(d); }); child.stderr.on('data', d => { err += String(d); });
    child.on('error', reject); child.on('close', code => resolve({ code, out, err })); child.stdin.on('error', () => {}); child.stdin.end(stdin);
  });
}
const fake = () => {
  const dir = temp(), file = join(dir, 'fake.cjs');
  writeFileSync(file, `let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => text += d); process.stdin.on('end', () => {
    const key = process.env.ANTHROPIC_API_KEY || '';
    process.stdout.write(JSON.stringify({ blocked: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK'].filter(n => process.env[n] !== undefined), keyLength: key.length, apiKey: key.startsWith('sk-ant-'), text, args: process.argv.slice(2), custom: process.env.CLAUDE_TEST_CUSTOM }));
    process.stderr.write('credential ' + key.slice(0, 8)); setTimeout(() => process.stderr.write(key.slice(8) + ' twice ' + key + '\\n'), 10);
    process.exitCode = Number(process.env.CLAUDE_TEST_EXIT || 0);
  });`);
  return { dir, file };
};

describe('claude key wrapper', () => {
  it('scrubs auth overrides and stderr while forwarding stdin, args, and exit status', async () => {
    const { file } = fake();
    const r = await runCall(['--exe', process.execPath, '--key-env', 'CLAUDE_TEST_KEY', '--', file, '-p', '--tools', '', '--key-env', 'unchanged'], {
      CLAUDE_TEST_KEY: SENTINEL, ANTHROPIC_API_KEY: 'other', ANTHROPIC_AUTH_TOKEN: 'other', CLAUDE_CODE_OAUTH_TOKEN: 'other', ANTHROPIC_BASE_URL: 'http://invalid', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_TEST_CUSTOM: 'kept', CLAUDE_TEST_EXIT: '7',
    });
    expect(r.code).toBe(7);
    expect(JSON.parse(r.out)).toEqual({ blocked: [], keyLength: SENTINEL.length, apiKey: true, text: 'whole prompt\nsecond line', args: ['-p', '--tools', '', '--key-env', 'unchanged'], custom: 'kept' });
    expect(r.err).toBe('credential [key] twice [key]\n'); expect((r.out + r.err).includes(SENTINEL)).toBe(false);
  });

  it('reads a stored key and its provider fallback, with executable prefix arguments', async () => {
    const { dir, file } = fake(), keyFile = join(dir, 'secrets.json');
    writeFileSync(keyFile, JSON.stringify({ own: SENTINEL, 'claude-api.apiKey': SENTINEL }));
    for (const name of ['own', 'missing']) {
      const r = await runCall(['--exe', process.execPath, '--exe-prefix-json', JSON.stringify([file]), '--key-name', name, '--key-file', keyFile, '--key-file-only', '--fallback-key-name', 'claude-api.apiKey', '--', '-p']);
      expect(r.code).toBe(0); expect(JSON.parse(r.out)).toMatchObject({ keyLength: SENTINEL.length, args: ['-p'] });
      expect((r.out + r.err).includes(SENTINEL)).toBe(false);
    }
  });

  it('refuses missing and non-Anthropic keys before starting the child', async () => {
    for (const key of ['', 'not-an-anthropic-key']) {
      const r = await runCall(['--exe', process.execPath, '--key-env', 'CLAUDE_TEST_MISSING', '--', 'missing.cjs'], { CLAUDE_TEST_MISSING: key });
      expect(r.code).toBe(65); expect(r.out).toBe('');
      expect(r.err).toContain(key ? 'not an Anthropic API key' : 'CLAUDE_TEST_MISSING');
      if (key) expect(r.err.includes(key)).toBe(false);
    }
  });

  it('reports launch errors and rejects malformed prefix arguments without printing credentials', async () => {
    const base = ['--exe', join(temp(), 'missing'), '--key-env', 'CLAUDE_TEST_KEY'];
    const r = await runCall([...base, '--'], { CLAUDE_TEST_KEY: SENTINEL });
    expect(r.code).toBe(69); expect(r.err).toContain('could not start claude'); expect(r.err.includes(SENTINEL)).toBe(false);
    for (const prefix of ['{', '{}', '[1]']) expect((await runCall([...base, '--exe-prefix-json', prefix, '--'])).code).toBe(64);
  });
});
