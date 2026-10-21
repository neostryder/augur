// One request to an OpenAI-style or Anthropic-style HTTP API, run as a job by the API adapters. Plain node, erasable TypeScript only.
// The prompt arrives on standard input. The key is read from the environment variable named by --key-env, or from the key store when --key-name
// names a secret (the Windows credential store, the macOS keychain, the Secret Service, or the user-only file named by --key-file), and is never printed.
// --mode chat (the default) sends a chat request: text attachments are added to the prompt and images travel with it. --mode embeddings sends the prompt and the
// text attachments as inputs and writes the vectors to --result-file. --mode transcribe sends the audio attachment to the transcription endpoint.
// Standard output is one JSON object: { answer, usage, served }. A failure exits non-zero with a short message on standard error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const shape = opt('--shape'), url = opt('--url'), model = opt('--model'), keyEnv = opt('--key-env');
// --key-target is the Windows credential name that jobs queued before --key-name carried; it is read the same way.
const keyName = opt('--key-name') ?? opt('--key-target')?.replace(/\.augur$/, ''), keyFile = opt('--key-file'), fileOnly = args.includes('--key-file-only');
const extraHeaders = opt('--headers-json'), mode = opt('--mode') ?? 'chat', resultFile = opt('--result-file');
interface Attached { path: string; kind: 'text' | 'image' | 'audio' }
const attachments = JSON.parse(opt('--attachments-json') ?? '[]') as Attached[];
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
const base = url.replace(/\/+$/, '');
const endpoint = mode === 'embeddings' ? `${base}/embeddings` : mode === 'transcribe' ? `${base}/audio/transcriptions` : anthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
const headers: Record<string, string> = anthropic
  ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  : { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
if (extraHeaders) { try { for (const [k, v] of Object.entries(JSON.parse(extraHeaders) as Record<string, unknown>)) if (typeof v === 'string') headers[k] = v; } catch { console.error('the headers option is not JSON'); process.exit(64); } }

const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm', '.aac': 'audio/aac' };
const mediaOf = (path: string, fallback: string): string => MEDIA[extname(path).toLowerCase()] ?? fallback;
const texts = attachments.filter(a => a.kind === 'text').map(a => ({ name: basename(a.path), text: readFileSync(a.path, 'utf8') }));
const images = attachments.filter(a => a.kind === 'image').map(a => ({ media: mediaOf(a.path, 'image/png'), data: readFileSync(a.path).toString('base64') }));
const withTexts = promptText + texts.map(t => `\n\n--- ${t.name} ---\n${t.text}`).join('');

let body: string | FormData;
if (mode === 'embeddings') {
  const inputs = [...(promptText.trim() ? [promptText.trim()] : []), ...texts.map(t => t.text)];
  if (!inputs.length) { console.error('there is nothing to embed'); process.exit(64); }
  body = JSON.stringify({ model, input: inputs });
} else if (mode === 'transcribe') {
  const audio = attachments.find(a => a.kind === 'audio');
  if (!audio) { console.error('there is no audio to transcribe'); process.exit(64); }
  const form = new FormData();
  form.append('file', new Blob([readFileSync(audio.path)], { type: mediaOf(audio.path, 'application/octet-stream') }), basename(audio.path));
  form.append('model', model);
  if (promptText.trim()) form.append('prompt', promptText.trim());
  delete headers['content-type'];
  body = form;
} else if (anthropic) {
  const content = [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media, data: i.data } })), { type: 'text', text: withTexts }];
  body = JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: images.length ? content : withTexts }] });
} else {
  const content = images.length ? [{ type: 'text', text: withTexts }, ...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.media};base64,${i.data}` } }))] : withTexts;
  body = JSON.stringify({ model, messages: [{ role: 'user', content }], ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}) });
}

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), timeoutS * 1000);
const deadline = Date.now() + timeoutS * 1000;
// Cogitator answers 503 `preempted` when a person's request needed the room, and the model it was using is not reloaded until the next request.
// That is not a failure of the route: wait the Retry-After seconds (20 when it names none) and ask again, a few times, within the job's time limit.
const PREEMPT_TRIES = 3, PREEMPT_WAIT_S = 20, PREEMPT_WAIT_MAX_S = 120;
const preempted = (r: Response, t: string): boolean => r.status === 503 && (r.headers.get('x-cogitator-retry') === 'elsewhere' || /"preempted"/.test(t));
const waitS = (r: Response): number => { const v = Number(r.headers.get('retry-after')); return Number.isFinite(v) && v > 0 ? Math.min(v, PREEMPT_WAIT_MAX_S) : PREEMPT_WAIT_S; };
let res!: Response, text = '';
for (let attempt = 1; ; attempt++) {
  // A redirect is never followed: the key rides in a header that a cross-origin redirect would carry to the new host.
  try { res = await fetch(endpoint, { method: 'POST', headers, body, signal: abort.signal, redirect: 'manual' }); text = await res.text(); }
  catch (e) { console.error(`request failed: ${(e as Error).message}`); process.exit(66); }
  if (!preempted(res, text)) break;
  const wait = waitS(res);
  if (attempt >= PREEMPT_TRIES || Date.now() + wait * 1000 >= deadline) { console.error(`preempted: the gateway gave the model to another request and asked for a retry elsewhere. ${text.slice(0, 200)}`); process.exit(69); }
  await new Promise(done => setTimeout(done, wait * 1000));
}
clearTimeout(timer);
if (res.status >= 300 && res.status < 400) { console.error(`HTTP ${res.status}: the endpoint redirected the request, and Augur does not follow a redirect with a key attached. Set the route's base URL to the address the redirect points to.`); process.exit(2); }
if (!res.ok) { console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(2); }

interface Json { [k: string]: unknown }
let data: Json;
try { data = JSON.parse(text) as Json; } catch { console.error('the response was not JSON'); process.exit(67); }
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? v as Json : {});

let answer = '';
let usage: Json | null = null;
if (mode === 'embeddings') {
  const rows = (Array.isArray(data.data) ? data.data as Json[] : []).map(r => Array.isArray(r.embedding) ? r.embedding as number[] : []);
  if (!rows.length || !rows[0]!.length) { console.error('the response held no embeddings'); process.exit(68); }
  if (resultFile) writeFileSync(resultFile, JSON.stringify({ model: String(data.model ?? model), dimensions: rows[0]!.length, vectors: rows }));
  answer = `Embedded ${rows.length} input${rows.length === 1 ? '' : 's'}, ${rows[0]!.length} numbers each.${resultFile ? ` The vectors are in ${resultFile}.` : ''}`;
  const u = obj(data.usage);
  usage = { inputTokens: num(u.prompt_tokens) || num(u.total_tokens), outputTokens: 0 };
} else if (mode === 'transcribe') {
  answer = String(data.text ?? '');
  const u = obj(data.usage);
  if (Object.keys(u).length) usage = { inputTokens: num(u.input_tokens) || num(u.prompt_tokens), outputTokens: num(u.output_tokens) || num(u.completion_tokens) };
} else if (anthropic) {
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
    usage = { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens), ...(read ? { cachedReadTokens: read } : {}), ...(reasoning ? { reasoningTokens: reasoning, reasoningInOutput: true } : {}),
      ...(typeof u.cost === 'number' ? { costUsd: u.cost, currency: 'USD' } : {}) };
  }
}
// What the gateway says about where the answer came from, such as the machine and the link of the chain that served it.
const served: Record<string, string> = {};
res.headers.forEach((v, k) => { if (k.startsWith('x-cogitator-')) served[k.slice('x-cogitator-'.length)] = v; });
process.stdout.write(JSON.stringify({ answer, usage, ...(Object.keys(served).length ? { served } : {}) }));
