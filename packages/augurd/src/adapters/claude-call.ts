// The wrapper reads credentials outside the service so plans and job files never carry a key.
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { missingKeyMessage, resolveApiKey } from './api-key.ts';

const all = process.argv.slice(2), separator = all.indexOf('--');
const args = separator < 0 ? all : all.slice(0, separator);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const exe = opt('--exe'), keyEnv = opt('--key-env'), keyName = opt('--key-name');
if (!exe || separator < 0 || (!keyEnv && !keyName)) { console.error('missing --exe, --key-env or --key-name, or -- separator'); process.exit(64); }
let prefix: unknown;
try { prefix = JSON.parse(opt('--exe-prefix-json') ?? '[]'); } catch { console.error('--exe-prefix-json must be a JSON array of strings'); process.exit(64); }
if (!Array.isArray(prefix) || !prefix.every(v => typeof v === 'string')) { console.error('--exe-prefix-json must be a JSON array of strings'); process.exit(64); }
const source = { keyEnv, keyName, keyFile: opt('--key-file'), fileOnly: args.includes('--key-file-only'), fallbackKeyName: opt('--fallback-key-name') };
const key = resolveApiKey(source);
if (!key) { console.error(missingKeyMessage(source)); process.exit(65); }
if (!key.startsWith('sk-ant-')) { console.error('the key is not an Anthropic API key (expected sk-ant-)'); process.exit(65); }

const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/i.test(name)) delete env[name];
env.ANTHROPIC_API_KEY = key;
const child = spawn(exe, [...prefix as string[], ...all.slice(separator + 1)], { env, windowsHide: true });
// A key can span stderr chunks, so retain only a suffix that could begin the next occurrence.
let pending = '';
const scrub = new Transform({
  decodeStrings: false,
  transform(chunk: string, _encoding, done) {
    pending += chunk;
    pending = pending.split(key).join('[key]');
    let keep = Math.min(key.length - 1, pending.length);
    while (keep && !key.startsWith(pending.slice(-keep))) keep--;
    this.push(pending.slice(0, pending.length - keep));
    pending = pending.slice(pending.length - keep);
    done();
  },
  flush(done) { this.push(pending); done(); },
});
child.stderr.setEncoding('utf8');
child.stdout.pipe(process.stdout);
child.stderr.pipe(scrub).pipe(process.stderr);
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => { /* The child can reject a prompt before standard input ends. */ });
child.on('error', () => { console.error('could not start claude'); process.exitCode = 69; });
child.on('close', code => { process.stdin.unpipe(child.stdin); process.stdin.pause(); process.exitCode ??= code ?? 1; });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  const code = signal === 'SIGINT' ? 130 : 143;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { child.kill(); process.exit(code); });
    killer.on('close', () => process.exit(code));
  } else { child.kill(signal); process.exit(code); }
});
