// One text request to an OpenAI-style or Anthropic-style HTTP API, run as a job by the API adapters. Plain node, erasable TypeScript only.
// The prompt arrives on standard input. The key is read from the environment variable named by --key-env, or from the key store when --key-name
// names a secret (the Windows credential store, the macOS keychain, the Secret Service, or the user-only file named by --key-file), and is never printed.
// Standard output is one JSON object: { answer, usage }. A failure exits non-zero with a short message on standard error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const shape = opt('--shape'), url = opt('--url'), model = opt('--model'), keyEnv = opt('--key-env');
// --key-target is the Windows credential name that jobs queued before --key-name carried; it is read the same way.
const keyName = opt('--key-name') ?? opt('--key-target')?.replace(/\.augur$/, ''), keyFile = opt('--key-file'), fileOnly = args.includes('--key-file-only');
const maxTokens = Number(opt('--max-tokens') ?? '4096'), timeoutS = Number(opt('--timeout-s') ?? '900');
if (!shape || !url || !model || (!keyEnv && !keyName)) { console.error('missing --shape, --url, --model or --key-env'); process.exit(64); }

const read = (command: string, argv: string[]): string | null => {
  try { return execFileSync(command, argv, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); } catch { return null; }
};

function fromFile(name: string): string | null {
  if (!keyFile || !existsSync(keyFile)) return null;
  try { const v = (JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, unknown>)[name]; return typeof v === 'string' && v ? v : null; } catch { return null; }
}

/** The credential reader sits beside this file in an install, and in native/bin in the source tree. */
function storedKey(name: string): string | null {
  if (fileOnly) return fromFile(name);
  if (process.platform === 'win32') {
    const here = dirname(fileURLToPath(import.meta.url));
    const helper = [join(here, 'credread.exe'), join(here, '..', '..', 'native', 'bin', 'credread.exe')].find(existsSync);
    return helper ? read(helper, [`${name}.augur`]) : null;
  }
  if (process.platform === 'darwin') return read('security', ['find-generic-password', '-s', 'augur', '-a', name, '-w'])?.replace(/\n$/, '') || null;
  return read('secret-tool', ['lookup', 'service', 'augur', 'username', name]) || fromFile(name);
}

const key = keyName ? storedKey(keyName) : process.env[keyEnv as string];
if (!key) { console.error(keyName ? 'no key is stored for this route in the key store' : `environment variable ${keyEnv} is not set for this job`); process.exit(65); }

let promptText = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) promptText += chunk;

const anthropic = shape === 'anthropic';
const endpoint = anthropic ? `${url.replace(/\/+$/, '')}/v1/messages` : `${url.replace(/\/+$/, '')}/chat/completions`;
const headers: Record<string, string> = anthropic
  ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  : { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const body = anthropic
  ? { model, max_tokens: maxTokens, messages: [{ role: 'user', content: promptText }] }
  : { model, messages: [{ role: 'user', content: promptText }], ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}) };

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), timeoutS * 1000);
let res: Response;
try { res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal }); }
catch (e) { console.error(`request failed: ${(e as Error).message}`); process.exit(66); }
clearTimeout(timer);
const text = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(2); }

interface Json { [k: string]: unknown }
let data: Json;
try { data = JSON.parse(text) as Json; } catch { console.error('the response was not JSON'); process.exit(67); }
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? v as Json : {});

let answer = '';
let usage: Json | null = null;
if (anthropic) {
  const blocks = Array.isArray(data.content) ? data.content as Json[] : [];
  answer = blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n');
  const u = obj(data.usage);
  const read = num(u.cache_read_input_tokens), write = num(u.cache_creation_input_tokens);
  usage = { inputTokens: num(u.input_tokens) + read + write, outputTokens: num(u.output_tokens), ...(read ? { cachedReadTokens: read } : {}), ...(write ? { cachedWriteTokens: write } : {}) };
} else {
  const choice = obj((Array.isArray(data.choices) ? data.choices : [])[0]);
  answer = String(obj(choice.message).content ?? '');
  const u = obj(data.usage);
  if (Object.keys(u).length) {
    const read = num(obj(u.prompt_tokens_details).cached_tokens), reasoning = num(obj(u.completion_tokens_details).reasoning_tokens);
    usage = { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens), ...(read ? { cachedReadTokens: read } : {}), ...(reasoning ? { reasoningTokens: reasoning } : {}),
      ...(typeof u.cost === 'number' ? { costUsd: u.cost, currency: 'USD' } : {}) };
  }
}
process.stdout.write(JSON.stringify({ answer, usage }));
