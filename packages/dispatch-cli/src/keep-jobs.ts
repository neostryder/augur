import { spawnSync } from 'node:child_process';

export const SERVICE_STOP_TEXT = {
  help: 'augur service status | start | stop [--keep-jobs | --if-idle | --wait [--timeout <s>]]    Give stop at most one option. --keep-jobs stops at once and leaves running jobs going for the next start to pick up. --if-idle stops only when no job is running, so an upgrade never cuts one off. --wait names the running jobs, waits for them to end, then stops.',
  conflict: 'More than one stop option was given. Use only one of --keep-jobs, --if-idle, or --wait.',
  lookupFailed: 'Could not read the list of running Windows processes. Run the command again.',
  stopFailed: 'The Augur service did not stop. Check it with augur service status, then run augur service stop again.',
};

export interface WindowsProcess { ProcessId: number; Name: string; CommandLine: string | null }

export function listWindowsProcesses(): WindowsProcess[] {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name = 'augur-node.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (r.error || r.status !== 0) throw new Error(SERVICE_STOP_TEXT.lookupFailed);
  try {
    const rows: WindowsProcess | WindowsProcess[] | null = JSON.parse(r.stdout.trim() || 'null');
    return rows ? Array.isArray(rows) ? rows : [rows] : [];
  } catch { throw new Error(SERVICE_STOP_TEXT.lookupFailed); }
}

export function stopMcpServers(servicePid?: number, deps = {
  platform: process.platform as string,
  list: listWindowsProcesses,
  kill: (pid: number) => { process.kill(pid, 'SIGKILL'); },
}): number[] {
  if (deps.platform !== 'win32') return [];
  const killed: number[] = [];
  for (const row of deps.list()) {
    if (!Number.isInteger(row.ProcessId) || row.ProcessId <= 1 || row.ProcessId === process.pid || row.ProcessId === servicePid) continue;
    if (row.Name.toLowerCase() !== 'augur-node.exe' || !row.CommandLine || /runner\.mjs/i.test(row.CommandLine)) continue;
    if (!/(?:^|[\\/\s"])augur-mcp\.mjs(?:["\s]|$)/i.test(row.CommandLine)) continue;
    try { deps.kill(row.ProcessId); killed.push(row.ProcessId); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
  return killed;
}
