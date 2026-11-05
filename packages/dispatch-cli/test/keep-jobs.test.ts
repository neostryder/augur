import { afterEach, expect, it, vi } from 'vitest';
import { call } from '@augur/augurd';
import { main, parse } from '../src/cli.js';
import { listWindowsProcesses, stopMcpServers } from '../src/keep-jobs.js';
import { spawnSync } from 'node:child_process';

const fake = vi.hoisted(() => ({ list: vi.fn(), kill: vi.fn() }));
vi.mock('@augur/augurd', async original => ({ ...await original<object>(), call: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<object>(), spawnSync: vi.fn(() => ({ status: 0, stdout: '' })) }));
vi.mock('../src/keep-jobs.js', async original => {
  const actual = await original<typeof import('../src/keep-jobs.js')>();
  return { ...actual, stopMcpServers: vi.fn((pid?: number) => actual.stopMcpServers(pid, { platform: 'win32', ...fake })) };
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('stops without listing jobs and reports only MCP pids, excluding every runner', async () => {
  const servicePid = 900001;
  vi.mocked(call).mockResolvedValue({ pid: servicePid } as never);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  fake.list.mockReturnValue([
    { ProcessId: servicePid, Name: 'augur-node.exe', CommandLine: 'augur-node.exe augur-mcp.mjs' },
    { ProcessId: 900002, Name: 'augur-node.exe', CommandLine: '"C:/Augur/augur-node.exe" "C:/Augur/augur-mcp.mjs"' },
    { ProcessId: 900003, Name: 'augur-node.exe', CommandLine: 'augur-node.exe C:/Augur/runner.mjs C:/jobs/a' },
    { ProcessId: 900004, Name: 'augur-node.exe', CommandLine: 'augur-node.exe runner.mjs augur-mcp.mjs' },
    { ProcessId: 900005, Name: 'node.exe', CommandLine: 'node.exe augur-mcp.mjs' },
    { ProcessId: 900006, Name: 'augur-node.exe', CommandLine: null },
    { ProcessId: 900007, Name: 'augur-node.exe', CommandLine: 'augur-node.exe augurd.mjs' },
  ]);
  let out = '';
  const io = { out: (s: string) => { out += s; }, err: () => {}, stdin: () => '', env: {}, cwd: '.' };
  expect(parse(['service', 'stop', '--keep-jobs']).flags.get('keep-jobs')).toBe(true);
  expect(await main(['service', 'stop', '--keep-jobs', '--json'], io)).toBe(0);
  expect(JSON.parse(out)).toEqual({ stopping: true, killedPids: [900002] });
  expect(fake.kill.mock.calls).toEqual([[900002]]);
  expect(vi.mocked(call).mock.calls.map(c => c[0])).toEqual(['ping']);
  if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(servicePid);
});

it('cleans leftover MCP servers when the service is already stopped', async () => {
  vi.mocked(call).mockRejectedValue(new Error());
  fake.list.mockReturnValue([{ ProcessId: 900002, Name: 'augur-node.exe', CommandLine: 'augur-node.exe augur-mcp.mjs' }]);
  let out = '';
  expect(await main(['service', 'stop', '--keep-jobs', '--json'], { out: s => { out += s; }, err: () => {}, stdin: () => '', env: {}, cwd: '.' })).toBe(0);
  expect(JSON.parse(out)).toEqual({ running: false, killedPids: [900002] });
});

it('skips process lookup outside Windows', async () => {
  const actual = await vi.importActual<typeof import('../src/keep-jobs.js')>('../src/keep-jobs.js');
  expect(actual.stopMcpServers(undefined, { platform: 'linux', ...fake })).toEqual([]);
  expect(fake.list).not.toHaveBeenCalled();
});

it('uses a hidden Windows process query and accepts a single result', () => {
  vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: '{"ProcessId":42,"Name":"augur-node.exe","CommandLine":null}' } as never);
  expect(listWindowsProcesses()).toHaveLength(1);
  expect(spawnSync).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']), expect.objectContaining({ windowsHide: true }));
});

it('rejects conflicting stop flags before touching processes', async () => {
  for (const flag of ['--wait', '--if-idle']) {
    expect(await main(['service', 'stop', '--keep-jobs', flag], { out: () => {}, err: () => {}, stdin: () => '', env: {}, cwd: '.' })).toBe(1);
  }
  expect(call).not.toHaveBeenCalled();
  expect(stopMcpServers).not.toHaveBeenCalled();
});
