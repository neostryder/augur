// One streamed chat request to an OpenAI-style or Anthropic-style API, run by the chat service as its own process so the key never enters the service.
// Plain node, erasable TypeScript only. The request arrives on standard input as one JSON object:
//   { system, messages: [{ role, text, files: [{ path, kind, mime }] }], body: { ...sampling fields already placed by dotted path }, maxTokens }
// The key comes from --key-env, or from the key store through --key-name, --key-file and --key-file-only, as in api-call.
// Standard output is one JSON object per line: { t: 'delta', text } | { t: 'think', text } | { t: 'usage', usage } | { t: 'served', served } | { t: 'done' }.
// A failure prints { t: 'error', message } and exits non-zero. --mode capabilities instead fetches Cogitator's capabilities document and prints it as one line.

import { readFileSync } from 'node:fs';
import { missingKeyMessage, resolveApiKey } from '../adapters/api-key.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const shape = opt('--shape'), url = opt('--url'), model = opt('--model'), keyEnv = opt('--key-env'), mode = opt('--mode') ?? 'chat';
const keyName = opt('--key-name'), keyFile = opt('--key-file'), fileOnly = args.includes('--key-file-only');
const extraHeaders = opt('--headers-json'), timeoutS = Number(opt('--timeout-s') ?? '600');

const out = (v: unknown): void => { process.stdout.write(JSON.stringify(v) + '\n'); };
const fail = (message: string, code = 2): never => { out({ t: 'error', message }); process.exit(code); };

if (!shape || !url || (mode === 'chat' && !model) || (!keyEnv && !keyName)) fail('missing --shape, --url, --model or a key source', 64);
const keySource = { ...(keyEnv ? { keyEnv } : {}), ...(keyName ? { keyName } : {}), ...(keyFile ? { keyFile } : {}), fileOnly };
const key = resolveApiKey(keySource);
if (!key) fail(missingKeyMessage(keySource), 65);

const anthropic = shape === 'anthropic';
const base = (url as string).replace(/\/+$/, '');
const headers: Record<string, string> = anthropic
  ? { 'x-api-key': key as string, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  : { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
if (extraHeaders) { try { for (const [k, v] of Object.entries(JSON.parse(extraHeaders) as Record<string, unknown>)) if (typeof v === 'string') headers[k] = v; } catch { fail('the headers option is not JSON', 64); } }

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), timeoutS * 1000);
process.on('SIGTERM', () => abort.abort());

if (mode === 'capabilities') {
  // A redirect is never followed: the key rides in a header that a cross-origin redirect would carry to the new host.
  try {
    const res = await fetch(`${base}/cogitator/capabilities`, { headers, signal: abort.signal, redirect: 'manual' });
    const text = await res.text();
    if (!res.ok) fail(`HTTP ${res.status}`, 2);
    process.stdout.write(JSON.stringify(JSON.parse(text)) + '\n');
  } catch (e) { fail(`request failed: ${(e as Error).message}`, 66); }
  process.exit(0);
}

interface InFile { path: string; kind: string; mime: string }
interface InMessage { role: 'user' | 'assistant'; text: string; files?: InFile[] }
interface Input { system?: string; messages: InMessage[]; body?: Record<string, unknown>; maxTokens?: number }
let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
let input: Input;
try { input = JSON.parse(raw) as Input; } catch { fail('the request on standard input is not JSON', 64); throw new Error('unreachable'); }

/** A message's text with its text files folded in, and its images as base64. Other files are named so the model knows they were sent. */
function parts(m: InMessage): { text: string; images: Array<{ mime: string; data: string }> } {
  let text = m.text;
  const images: Array<{ mime: string; data: string }> = [];
  for (const f of m.files ?? []) {
    try {
      if (f.kind === 'image') images.push({ mime: f.mime || 'image/png', data: readFileSync(f.path).toString('base64') });
      else if (f.kind === 'text') text += `\n\n--- ${f.path.split(/[\\/]/).pop()} ---\n${readFileSync(f.path, 'utf8')}`;
      else text += `\n\n[attached file ${f.path.split(/[\\/]/).pop()} (${f.mime}), not shown to you]`;
    } catch { text += '\n\n[an attached file could not be read]'; }
  }
  return { text, images };
}

const turns = input.messages.map(m => ({ role: m.role, ...parts(m) }));
let body: Record<string, unknown>;
if (anthropic) {
  body = {
    ...input.body, model, max_tokens: (input.body?.max_tokens as number | undefined) ?? input.maxTokens ?? 4096, stream: true,
    ...(input.system ? { system: input.system } : {}),
    messages: turns.map(t => ({ role: t.role, content: t.images.length
      ? [...t.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: t.text }] : t.text })),
  };
} else {
  body = {
    ...input.body, model, stream: true, stream_options: { include_usage: true },
    messages: [...(input.system ? [{ role: 'system', content: input.system }] : []),
      ...turns.map(t => ({ role: t.role, content: t.images.length
        ? [{ type: 'text', text: t.text }, ...t.images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] : t.text }))],
  };
}

const endpoint = anthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
const preempted = (r: Response, t: string): boolean => r.status === 503 && (r.headers.get('x-cogitator-retry') === 'elsewhere' || /"preempted"/.test(t));
let res!: Response;
for (let attempt = 1; ; attempt++) {
  try { res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal, redirect: 'manual' }); }
  catch (e) { fail(`request failed: ${(e as Error).message}`, 66); }
  if (res.status !== 503) break;
  const text = await res.text();
  if (!preempted(res, text) || attempt >= 3) fail(`HTTP 503: ${text.slice(0, 200)}`, 2);
  const wait = Number(res.headers.get('retry-after'));
  await new Promise(done => setTimeout(done, (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 60) : 15) * 1000));
}
if (res.status >= 300 && res.status < 400) fail(`HTTP ${res.status}: the endpoint redirected the request, and Augur does not follow a redirect with a key attached.`, 2);
if (!res.ok) fail(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, 2);

const served: Record<string, string> = {};
res.headers.forEach((v, k) => { if (k.startsWith('x-cogitator-')) served[k.slice('x-cogitator-'.length)] = v; });
if (Object.keys(served).length) out({ t: 'served', served });

// Some local models write their reasoning inline between <think> tags. It is routed to the reasoning stream, tags split across chunks included.
let inThink = false, carry = '';
function emit(text: string): void {
  let s = carry + text;
  carry = '';
  while (s) {
    const tag = inThink ? '</think>' : '<think>', at = s.indexOf(tag);
    if (at >= 0) {
      const before = s.slice(0, at);
      if (before) out({ t: inThink ? 'think' : 'delta', text: before });
      inThink = !inThink;
      s = s.slice(at + tag.length);
      continue;
    }
    // Hold back a tail that could be the start of the tag.
    let hold = 0;
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) { hold = n; break; }
    const send = s.slice(0, s.length - hold);
    if (send) out({ t: inThink ? 'think' : 'delta', text: send });
    carry = s.slice(s.length - hold);
    s = '';
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {});
let inTokens = 0, outTokens = 0, cost: number | undefined, sawUsage = false;

function handle(data: Record<string, unknown>): void {
  if (anthropic) {
    const type = data.type;
    if (type === 'message_start') { const u = obj(obj(data.message).usage); inTokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens); outTokens = num(u.output_tokens); sawUsage = true; }
    else if (type === 'content_block_delta') {
      const d = obj(data.delta);
      if (d.type === 'text_delta' && typeof d.text === 'string') emit(d.text);
      else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') out({ t: 'think', text: d.thinking });
    } else if (type === 'message_delta') { const u = obj(data.usage); if (u.output_tokens !== undefined) { outTokens = num(u.output_tokens); sawUsage = true; } }
    else if (type === 'error') fail(String(obj(data.error).message ?? 'the API reported an error'), 2);
    return;
  }
  const u = obj(data.usage);
  if (Object.keys(u).length) { inTokens = num(u.prompt_tokens); outTokens = num(u.completion_tokens); if (typeof u.cost === 'number') cost = u.cost; sawUsage = true; }
  if (data.error) fail(String(obj(data.error).message ?? 'the API reported an error'), 2);
  const delta = obj(obj((Array.isArray(data.choices) ? data.choices : [])[0]).delta);
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string' && reasoning) out({ t: 'think', text: reasoning });
  if (typeof delta.content === 'string' && delta.content) emit(delta.content);
}

const reader = (res.body as ReadableStream<Uint8Array>).getReader(), dec = new TextDecoder();
let buf = '';
try {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { handle(JSON.parse(payload) as Record<string, unknown>); } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    }
  }
} catch (e) { if ((e as Error).name === 'AbortError') fail('the reply was stopped or timed out', 70); fail(`the stream broke: ${(e as Error).message}`, 71); }
clearTimeout(timer);
if (carry) out({ t: inThink ? 'think' : 'delta', text: carry });
if (sawUsage) out({ t: 'usage', usage: { inputTokens: inTokens, outputTokens: outTokens, ...(cost !== undefined ? { costUsd: cost } : {}) } });
out({ t: 'done' });
