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

function runCall(port: number, shape: string): Promise<{ code: number | null; err: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, '--shape', shape, '--url', `http://127.0.0.1:${port}`, '--model', 'm', '--key-env', 'TEST_API_KEY', '--timeout-s', '20'],
      { env: { ...process.env, TEST_API_KEY: 'secret-key-value' }, windowsHide: true });
    let err = '';
    child.stderr.on('data', d => { err += String(d); });
    child.on('close', code => resolve({ code, err }));
    child.stdin.end('hello');
  });
}

describe('api-call', () => {
  it('does not follow a redirect, so a key header never reaches another host', async () => {
    let elsewhere = 0;
    const other = await listen((_req, res) => { elsewhere++; res.end('{}'); });
    const first = await listen((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${other}/v1/messages` }); res.end(); });
    const r = await runCall(first, 'anthropic');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/redirect/);
    expect(r.err).not.toContain('secret-key-value');
    expect(elsewhere).toBe(0);
  }, 30000);
});
