import type { Host, HttpRequest, HttpResponse, Platform } from '../types.js';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export interface NodeHostOptions { bwsProject?: string; secretMap?: Record<string, string> }

export function createNodeHost(options: NodeHostOptions = {}): Host {
  const platform: Platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const home = homedir();
  let bwsCache: Promise<Record<string, string>> | null = null;
  const safePath = (path: string): string => {
    const absolute = resolve(home, path);
    const codexHome = process.env.CODEX_HOME;
    if (codexHome && absolute === resolve(codexHome, 'auth.json')) return absolute;
    const fromHome = relative(home, absolute);
    if (fromHome.startsWith('..') || isAbsolute(fromHome)) throw new Error('Invalid home path');
    return absolute;
  };
  const bws = () => bwsCache ??= (async () => {
    if (!options.bwsProject) return {};
    try {
      const { stdout } = await execute('bws', ['secret', 'list', options.bwsProject, '-o', 'json'], { timeout: 30000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      const rows = JSON.parse(stdout);
      return Object.fromEntries(Array.isArray(rows) ? rows.map(row => [row.key, row.value]) : []);
    } catch { return {}; }
  })();
  return {
    platform,
    env: name => process.env[name] ?? null,
    async http(req: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 15000);
      try {
        const response = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, signal: controller.signal });
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
      } finally { clearTimeout(timeout); }
    },
    async secret(name) {
      const envName = `AUGUR_${name.replaceAll('.', '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
      const direct = process.env[envName];
      if (direct) return direct;
      if (name === 'openrouter.apiKey' && process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
      if (name === 'jev.apiKey' && process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
      if (name === 'jev.apiKey' && process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
      const mapped = options.secretMap?.[name];
      return mapped ? (await bws())[mapped] ?? null : null;
    },
    async readHomeFile(path) { try { return await readFile(safePath(path), 'utf8'); } catch { return null; } },
    async writeHomeFileAtomic(path, text) {
      const target = safePath(path), temp = `${target}.${process.pid}.tmp`;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, target);
    },
    async run(command, args, timeoutMs = 60000) {
      if (!['grok', 'bws'].includes(command)) throw new Error('Command is not allowed');
      const result = await execute(command, args, { timeout: timeoutMs, windowsHide: true });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    },
    async keychainGet(service, account = userInfo().username) {
      if (platform !== 'macos') return null;
      try { const { stdout } = await execute('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { windowsHide: true }); return stdout.trim() || null; }
      catch { return null; }
    },
    async keychainSet(service, account, value) {
      if (platform !== 'macos') throw new Error('Keychain unavailable');
      await execute('security', ['add-generic-password', '-U', '-s', service, '-a', account || userInfo().username, '-w', value], { windowsHide: true });
    }
  };
}
