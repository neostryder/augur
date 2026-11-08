// Stands in for `mcode exec --input - --cwd <folder> ...` in tests: runs the fake harness in that folder and prints the result line mcode would.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2);
const cwd = a[a.indexOf('--cwd') + 1] ?? process.cwd();
const prompt = readFileSync(0, 'utf8');
const fake = fileURLToPath(new URL('./fake-harness.mjs', import.meta.url));
const run = spawnSync(process.execPath, [fake], { cwd, input: prompt, encoding: 'utf8' });
process.stdout.write(JSON.stringify({ schemaVersion: 1, type: 'exec.result', status: run.status === 0 ? 'succeeded' : 'failed', output: 'done', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 } }) + '\n');
process.exit(run.status ?? 1);
