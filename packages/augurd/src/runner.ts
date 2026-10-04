// One supervisor unit per job, started detached by the service and run with plain node. It owns the child's process tree,
// sends output to files (so a dead parent cannot break it) and leaves result.json when the child ends. Erasable TypeScript only.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface JobFile { command: string; args: string[]; cwd: string; stdin: 'prompt' | 'none'; timeoutS: number | null; jobhost: string | null; files?: unknown[]; promptArgs?: number[]; redact?: boolean;
  scope?: string | null; scopeEnv?: Record<string, string> }

const dir = process.argv[2];
if (!dir) process.exit(64);
const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as JobFile;
const atomic = (name: string, value: unknown) => { const tmp = join(dir, name + '.tmp'); writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, join(dir, name)); };

// The stored plan holds the command line, which for some harnesses carries the prompt. It is scrubbed before anything can fail, so a spawn error leaves no prompt behind.
if (job.redact) atomic('job.json', { ...job, args: job.args.map((a, i) => (job.promptArgs ?? []).includes(i) ? '<prompt>' : a),
  files: (job.files ?? []).map(f => ({ name: (f as { name: string }).name, inWorkspace: (f as { inWorkspace?: boolean }).inWorkspace, content: '' })) });

// The prompt is read into memory and its file removed before the child starts, so it is never on disk while the job runs.
let prompt: string | null = null;
const promptFile = join(dir, 'prompt.in');
if (job.stdin === 'prompt' && existsSync(promptFile)) { prompt = readFileSync(promptFile, 'utf8'); try { unlinkSync(promptFile); } catch { /* left for the service to remove */ } }

const out = openSync(join(dir, 'stdout.log'), 'a'), err = openSync(join(dir, 'stderr.log'), 'a');
const win = process.platform === 'win32';
const viaHost = win && job.jobhost && existsSync(job.jobhost);
// Without the Job Object launcher a Windows job could leave detached descendants behind, so it does not start.
if (win && !viaHost) { atomic('result.json', { exitCode: null, spawnError: 'The Windows job host was not found, so the job was not started.', killedBy: null, endedAt: Date.now() }); process.exit(0); }
// On Linux with systemd, the job runs in its own user scope: systemd-run starts the scope and then becomes the command, so the child's pid is the
// command's. Anything that leaves the process group stays in the scope, and stopping the scope ends it. Elsewhere the process group is the boundary.
// systemd-run gets the variables that reach the user's systemd, and env takes back out the ones the job was not given before it runs the command.
const scope = !win && job.scope ? job.scope : null;
const scopeEnv = { ...process.env, ...(job.scopeEnv ?? {}) };
const unset = Object.keys(job.scopeEnv ?? {}).filter(k => process.env[k] === undefined).flatMap(k => ['-u', k]);
const argv = viaHost ? [job.jobhost as string, job.command, ...job.args]
  : scope ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${scope}`, '--', 'env', ...unset, job.command, ...job.args]
  : [job.command, ...job.args];
const stopScope = () => { if (scope) spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', `${scope}.scope`], { stdio: 'ignore', timeout: 10000, env: scopeEnv }); };
let killedBy: 'cancel' | 'timeout' | null = null;

const child = spawn(argv[0] as string, argv.slice(1), {
  cwd: job.cwd, env: scope ? scopeEnv : process.env, windowsHide: true, detached: !win,
  stdio: [job.stdin === 'prompt' ? 'pipe' : 'ignore', out, err],
  shell: win && !viaHost && /\.(cmd|bat)$/i.test(job.command),
});
child.on('error', e => { atomic('result.json', { exitCode: null, spawnError: e.message, killedBy, endedAt: Date.now() }); process.exit(0); });
if (child.pid === undefined) { /* the error handler reports it */ } else {
  atomic('state.json', { runnerPid: process.pid, childPid: child.pid, contained: !!viaHost || !!scope, startedAt: Date.now() });
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
  stopScope();
}
const cancelPoll = setInterval(() => { if (existsSync(join(dir, 'cancel.request'))) killTree('cancel'); }, 300);
const timer = job.timeoutS ? setTimeout(() => killTree('timeout'), job.timeoutS * 1000) : null;

child.on('exit', (code, signal) => {
  clearInterval(heartbeat); clearInterval(cancelPoll); if (timer) clearTimeout(timer);
  // Whatever the job left running ends with it, as the job host's Job Object does on Windows: the rest of its process group, and its scope.
  if (!win && child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already empty */ }
    stopScope();
  }
  try { closeSync(out); closeSync(err); } catch { /* already closed */ }
  atomic('result.json', { exitCode: code, signal, killedBy, endedAt: Date.now() });
  process.exit(0);
});
