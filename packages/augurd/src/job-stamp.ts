import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { validStamp } from '@augur/dispatch-protocol';
import type { LedgerAttribution, OriginKind, Stamp } from '@augur/dispatch-protocol';

export interface ProcessInfo { pid: number; parentPid: number; name: string }
export interface PeerInfo { pid?: number; address?: string; userAgent?: string }
export type ProcessReader = (pid: number) => Promise<ProcessInfo | null>;
export interface ProcessProbe { text(path: string): Promise<string>; run(file: string, args: string[]): Promise<string> }
const originOf = (name: string): OriginKind | undefined => /claude/i.test(name) ? 'claude-code' : /hermes/i.test(name) ? 'hermes'
  : /augur-mcp/i.test(name) ? 'mcp' : /augur/i.test(name) ? 'cli' : /cron|taskeng|taskhost/i.test(name) ? 'scheduled-task' : undefined;

function command(file: string, args: string[]): Promise<string> {
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 2000, maxBuffer: 16384, encoding: 'utf8' }, (error, out) => resolve(error ? '' : out)));
}

function jobhost(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, 'jobhost.exe'), join(here, '..', 'native', 'bin', 'jobhost.exe')].find(existsSync);
}

export async function readProcess(pid: number, platform = process.platform,
  probe: ProcessProbe = { text: path => readFile(path, 'utf8'), run: command }): Promise<ProcessInfo | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const helper = jobhost();
      const text = helper ? await probe.run(helper, ['--process-info', String(pid)])
        : await probe.run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`]);
      const row = JSON.parse(text);
      return typeof row.Name === 'string' && Number.isSafeInteger(row.ParentProcessId) ? { pid, parentPid: row.ParentProcessId, name: row.Name } : null;
    }
    if (platform === 'linux') {
      const stat = await probe.text(`/proc/${pid}/stat`), end = stat.lastIndexOf(')');
      const parentPid = Number(stat.slice(end + 2).split(' ')[1]);
      return end > 0 && Number.isSafeInteger(parentPid) ? { pid, parentPid, name: stat.slice(stat.indexOf('(') + 1, end) } : null;
    }
    if (platform === 'darwin') {
      const text = (await probe.run('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='])).trim();
      const match = /^(\d+)\s+(.+)$/.exec(text);
      return match ? { pid, parentPid: Number(match[1]), name: match[2]! } : null;
    }
  } catch { /* Processes can exit while attribution is being read. */ }
  return null;
}

/** A stamp is a caller's claim; a process observation only fills a group that has no claim. */
export async function inferStamp(raw: Stamp = {}, peer: PeerInfo = {}, read: ProcessReader = readProcess): Promise<{ stamp: Stamp; attribution: LedgerAttribution }> {
  if (!validStamp(raw)) throw new Error('The job stamp is invalid.');
  const stamp = { ...raw }, attribution: LedgerAttribution = {
    session: stamp.sessionId || stamp.sessionTitle ? 'stamped' : 'unknown',
    origin: stamp.origin || stamp.originLabel ? 'stamped' : 'unknown',
    process: stamp.pid || stamp.parentPid ? 'stamped' : 'unknown', host: stamp.host ? 'stamped' : 'unknown',
  };
  try {
    const first = peer.pid ? await read(peer.pid) : null;
    if (first && attribution.process === 'unknown') { stamp.pid = first.pid; if (first.parentPid > 0) stamp.parentPid = first.parentPid; attribution.process = 'inferred'; }
    if (attribution.origin === 'unknown') {
      let current = first;
      const seen = new Set<number>();
      for (let depth = 0; current && depth < 6 && !seen.has(current.pid); depth++) {
        seen.add(current.pid);
        const origin = originOf(current.name);
        if (origin) { stamp.origin = origin; stamp.originLabel = current.name.slice(0, 256); attribution.origin = 'inferred'; break; }
        current = current.parentPid > 0 ? await read(current.parentPid) : null;
      }
      if (attribution.origin === 'unknown' && peer.userAgent) { stamp.origin = originOf(peer.userAgent) ?? 'other'; stamp.originLabel = peer.userAgent.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256); attribution.origin = 'inferred'; }
    }
    if (attribution.host === 'unknown' && (first || peer.address)) { stamp.host = (peer.address ?? hostname()).slice(0, 256); attribution.host = 'inferred'; }
  } catch { /* Attribution must not prevent a job from running. */ }
  return { stamp, attribution };
}

/** Node's net API has no portable peer-pid method. Tests and native transports can supply one. */
export function pipePeer(sock: unknown): PeerInfo {
  try {
    const socket = sock as { remoteAddress?: string; _handle?: { getPeerCredentials?(): { pid?: number }; getPeerPid?(): number } };
    const pid = socket._handle?.getPeerCredentials?.().pid ?? socket._handle?.getPeerPid?.();
    return { ...(Number.isSafeInteger(pid) && Number(pid) > 0 ? { pid } : {}), ...(socket.remoteAddress ? { address: socket.remoteAddress } : {}) };
  } catch { return {}; }
}

export async function readPipePeer(sock: Socket): Promise<PeerInfo> {
  const peer = pipePeer(sock);
  if (peer.pid || process.platform !== 'win32') return peer;
  const helper = jobhost();
  if (!helper) return peer;
  return new Promise(resolve => {
    try {
      const child = spawn(helper, ['--peer-pid'], { windowsHide: true, stdio: [sock, 'pipe', 'ignore'] });
      let text = '', done = false;
      const finish = (pid?: number) => { if (done) return; done = true; clearTimeout(timer); resolve(pid && Number.isSafeInteger(pid) ? { ...peer, pid } : peer); };
      const timer = setTimeout(() => { child.kill(); finish(); }, 750);
      child.stdout?.on('data', chunk => { if (text.length < 32) text += String(chunk); });
      child.on('error', () => finish());
      child.on('close', code => finish(code === 0 && /^\d+$/.test(text) ? Number(text) : undefined));
    } catch { resolve(peer); }
  });
}
