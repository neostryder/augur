import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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

function runCall(port: number, timeoutS: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, '--shape', 'anthropic', '--url', `http://127.0.0.1:${port}`, '--model', 'm', '--key-env', 'TEST_API_KEY', '--timeout-s', String(timeoutS)],
      { env: { ...process.env, TEST_API_KEY: 'secret-key-value' }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += String(d); });
    child.stderr.on('data', d => { err += String(d); });
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end('hello');
  });
}

describe('api-call network retry', () => {
  it('asks again after a dropped connection and answers once the connection holds', async () => {
    let requests = 0;
    const port = await listen((req, res) => {
      requests++;
      if (requests <= 2) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"content":[{"type":"text","text":"back online"}],"usage":{"input_tokens":1,"output_tokens":1}}');
    });
    const r = await runCall(port, 60);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).answer).toBe('back online');
    expect(requests).toBe(3);
  }, 60000);

  it('gives up inside the time limit and says how many requests it made', async () => {
    let requests = 0;
    const port = await listen((req) => { requests++; req.socket.destroy(); });
    const r = await runCall(port, 5);
    expect(r.code).toBe(66);
    expect(r.err).toMatch(/request failed after 2 attempts/);
    expect(requests).toBe(2);
  }, 30000);

  it('does not repeat a request the server answered with an error', async () => {
    let requests = 0;
    const port = await listen((_req, res) => { requests++; res.writeHead(500); res.end('broken'); });
    const r = await runCall(port, 30);
    expect(r.code).toBe(2);
    expect(requests).toBe(1);
  }, 30000);
});
