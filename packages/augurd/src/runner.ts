// One supervisor unit per job, started detached by the service and run with plain node. It owns the child's process tree,
// sends output to files (so a dead parent cannot break it) and leaves result.json when the child ends. Erasable TypeScript only.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface JobFile { command: string; args: string[]; cwd: string; stdin: 'prompt' | 'none'; timeoutS: number | null; jobhost: string | null }

const dir = process.argv[2];
if (!dir) process.exit(64);
const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as JobFile;
const atomic = (name: string, value: unknown) => { const tmp = join(dir, name + '.tmp'); writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, join(dir, name)); };

// The prompt is read into memory and its file removed before the child starts, so it is never on disk while the job runs.
let prompt: string | null = null;
const promptFile = join(dir, 'prompt.in');
if (job.stdin === 'prompt' && existsSync(promptFile)) { prompt = readFileSync(promptFile, 'utf8'); try { unlinkSync(promptFile); } catch { /* left for the service to remove */ } }

const out = openSync(join(dir, 'stdout.log'), 'a'), err = openSync(join(dir, 'stderr.log'), 'a');
const win = process.platform === 'win32';
const viaHost = win && job.jobhost && existsSync(job.jobhost);
const argv = viaHost ? [job.jobhost as string, job.command, ...job.args] : [job.command, ...job.args];
let killedBy: 'cancel' | 'timeout' | null = null;

const child = spawn(argv[0] as string, argv.slice(1), {
  cwd: job.cwd, env: process.env, windowsHide: true, detached: !win,
  stdio: [job.stdin === 'prompt' ? 'pipe' : 'ignore', out, err],
  shell: win && !viaHost && /\.(cmd|bat)$/i.test(job.command),
});
child.on('error', e => { atomic('result.json', { exitCode: null, spawnError: e.message, killedBy, endedAt: Date.now() }); process.exit(0); });
if (child.pid === undefined) { /* the error handler reports it */ } else {
  atomic('state.json', { runnerPid: process.pid, childPid: child.pid, contained: !!viaHost, startedAt: Date.now() });
  if (prompt !== null && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(prompt); prompt = null; }
}

const beat = () => { const now = new Date(); try { utimesSync(join(dir, 'heartbeat'), now, now); } catch { /* next beat */ } };
writeFileSync(join(dir, 'heartbeat'), 'hb');
const heartbeat = setInterval(beat, 1000);

function killTree(why: 'cancel' | 'timeout'): void {
  if (killedBy || child.pid === undefined) return;
  killedBy = why;
  if (win) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
}
const cancelPoll = setInterval(() => { if (existsSync(join(dir, 'cancel.request'))) killTree('cancel'); }, 300);
const timer = job.timeoutS ? setTimeout(() => killTree('timeout'), job.timeoutS * 1000) : null;

child.on('exit', (code, signal) => {
  clearInterval(heartbeat); clearInterval(cancelPoll); if (timer) clearTimeout(timer);
  try { closeSync(out); closeSync(err); } catch { /* already closed */ }
  atomic('result.json', { exitCode: code, signal, killedBy, endedAt: Date.now() });
  process.exit(0);
});
