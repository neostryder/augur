import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../src/adapters/api-call.ts', import.meta.url));
const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const listen = (handler: http.RequestListener): Promise<number> => new Promise(resolve => {
  const s = http.createServer(handler);
  servers.push(s);
  s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
});

function runCall(url: string, shape: string, args: string[] = [], nodeArgs: string[] = []): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, SCRIPT, '--shape', shape, '--url', url, '--model', 'm', '--key-env', 'TEST_API_KEY', '--timeout-s', '20', ...args],
      { env: { ...process.env, TEST_API_KEY: 'secret-key-value' }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += String(d); });
    child.stderr.on('data', d => { err += String(d); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end('hello');
  });
}

describe('api-call', () => {
  it('uses the stored provider key only when the route key is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'augur-api-key-test-')), file = join(dir, 'secrets.json');
    writeFileSync(file, JSON.stringify({ 'claude-api.apiKey': 'provider-fixture' }));
    const headers: string[] = [], paths: string[] = [];
    const port = await listen((req, res) => { paths.push(req.url!); headers.push(String(req.headers['x-api-key'])); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"content":[{"type":"text","text":"done"}]}'); });
    const call = (key: string | undefined): Promise<{ code: number | null; output: string }> => new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.TEST_API_KEY; if (key) env.TEST_API_KEY = key;
      const child = spawn(process.execPath, [SCRIPT, '--shape', 'anthropic', '--url', `http://127.0.0.1:${port}/v1`, '--model', 'm', ...(key === 'store' ? ['--key-name', 'dispatch.missing'] : ['--key-env', 'TEST_API_KEY']), '--fallback-key-name', 'claude-api.apiKey', '--key-file', file, '--key-file-only'], { env, windowsHide: true });
      let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); }); child.on('error', reject); child.on('close', code => resolve({ code, output })); child.stdin.end('hello');
    });
    try {
      for (const key of ['route-fixture', undefined, 'store']) {
        const result = await call(key); expect(result.code).toBe(0); expect(result.output).not.toContain('provider-fixture'); expect(result.output).not.toContain('route-fixture');
      }
      expect(headers).toEqual(['route-fixture', 'provider-fixture', 'provider-fixture']);
      expect(paths).toEqual(['/v1/messages', '/v1/messages', '/v1/messages']);
    } finally { unlinkSync(file); rmdirSync(dir); }
  }, 30000);

  it('does not follow a redirect, so a key header never reaches another host', async () => {
    let elsewhere = 0;
    const other = await listen((_req, res) => { elsewhere++; res.end('{}'); });
    const first = await listen((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${other}/v1/messages` }); res.end(); });
    const r = await runCall(`http://127.0.0.1:${first}`, 'anthropic');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/redirect/);
    expect(r.err).not.toContain('secret-key-value');
    expect(elsewhere).toBe(0);
  }, 30000);
});

describe('api-call chat token limit', () => {
  const echoBody = `data:text/javascript,${encodeURIComponent(
    'globalThis.fetch = async (_url, { body }) => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }));',
  )}`;

  it.each([
    ['https://api.openai.com/v1/', 128, { max_completion_tokens: 128 }],
    ['https://api.openai.com.example.test/v1', 128, { max_tokens: 128 }],
    ['https://api.openai.com/v1', 0, {}],
    ['https://api.openai.com.example.test/v1', 0, {}],
  ])('sends the expected limit to %s with maxTokens %i', async (url, maxTokens, limit) => {
    const r = await runCall(url, 'openai', ['--max-tokens', String(maxTokens)], ['--import', echoBody]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(JSON.parse(r.out).answer)).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hello' }], ...limit });
  });
});

describe('api-call when the gateway preempts the request', () => {
  const preempt = (res: http.ServerResponse) => { res.writeHead(503, { 'x-cogitator-retry': 'elsewhere', 'retry-after': '1', 'content-type': 'application/json' }); res.end('{"error":{"code":"preempted"}}'); };

  it('waits the Retry-After seconds and asks again, then returns the answer', async () => {
    let calls = 0;
    const port = await listen((_req, res) => {
      calls++;
      if (calls === 1) return preempt(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const r = await runCall(`http://127.0.0.1:${port}`, 'openai');
    expect(r.code).toBe(0);
    expect(calls).toBe(2);
  }, 30000);

  it('gives up after three tries with a preempted message the failover can read', async () => {
    let calls = 0;
    const port = await listen((_req, res) => { calls++; preempt(res); });
    const r = await runCall(`http://127.0.0.1:${port}`, 'openai');
    expect(r.code).toBe(69);
    expect(r.err).toMatch(/^preempted:/);
    expect(calls).toBe(3);
  }, 30000);
});
