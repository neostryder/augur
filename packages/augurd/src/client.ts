// Caller side of the service's control endpoint. Used by the CLI, the MCP server and the interface.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import type { Methods, MethodName, RpcResponse } from '@augur/dispatch-protocol';
import { dataDir, pipeName } from './paths.js';

export interface ClientOptions { pipe?: string; token?: string; dir?: string; timeoutMs?: number }

export class ServiceError extends Error { constructor(public code: string, message: string) { super(message); } }

export function readToken(dir = dataDir()): string { return readFileSync(join(dir, 'token'), 'utf8').trim(); }

export function call<M extends MethodName>(method: M, params?: Methods[M]['params'], opts: ClientOptions = {}): Promise<Methods[M]['result']> {
  const dir = opts.dir ?? dataDir(), pipe = opts.pipe ?? pipeName(dir);
  return new Promise((resolve, reject) => {
    let token: string;
    try { token = opts.token ?? readToken(dir); } catch { reject(new ServiceError('no_token', 'The service has not been started: its token file is missing.')); return; }
    const sock = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new ServiceError('timeout', 'The service did not answer in time.')); }, opts.timeoutMs ?? 10000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, token, method, params }) + '\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer); sock.end();
      const res = JSON.parse(buf.slice(0, i)) as RpcResponse<Methods[M]['result']>;
      if ('error' in res) reject(new ServiceError(res.error.code, res.error.message)); else resolve(res.result);
    });
    sock.on('error', e => { clearTimeout(timer); reject(new ServiceError('unreachable', `The service is not running (${(e as NodeJS.ErrnoException).code ?? e.message}).`)); });
  });
}
