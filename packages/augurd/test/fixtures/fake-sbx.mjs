// Stands in for `sbx exec ...` in tests: runs the fake harness in the job folder and prints what mcode or opencode would.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2);
const inside = a[a.indexOf('-w') + 1] ?? '';
const host = inside.replace(/^\/([a-z])\//, (_, d) => `${d.toUpperCase()}:/`);
const mcode = a.includes('mcode');
let prompt;
if (mcode) prompt = readFileSync(0, 'utf8');
else {
  const message = a[a.length - 1] ?? '';
  const m = /file (\S+) in the current directory/.exec(message);
  prompt = m ? readFileSync(join(host, m[1]), 'utf8') : message;
}
const fake = fileURLToPath(new URL('./fake-harness.mjs', import.meta.url));
const run = spawnSync(process.execPath, [fake], { cwd: host, input: prompt, encoding: 'utf8' });
process.stdout.write('Sandbox fake started successfully\n');
if (mcode) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, type: 'exec.result', status: run.status === 0 ? 'succeeded' : 'failed', output: 'done', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 } }) + '\n');
} else {
  const tier = /READ-ONLY TASK/.test(prompt) ? 'read' : 'other';
  process.stdout.write(JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: `done (${tier})` } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 1010, input: 10, output: 5, reasoning: 1, cache: { write: 0, read: 995 } }, cost: 0.0005 } }) + '\n');
}
process.exit(run.status ?? 1);
