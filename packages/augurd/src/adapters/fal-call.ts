// One video job on fal's queue, run as a job by the fal adapter. Plain node, erasable TypeScript only.
// The prompt arrives on standard input. The key comes from the environment variable named by --key-env, or from the key store when --key-name names a secret, and is never printed.
// The key is sent only to queue.fal.run. The finished video is downloaded from the address fal returns, with no key, into --out-dir.
// The job is refused before it is submitted when its estimated cost passes --max-usd. Standard output is one JSON object: { answer, usage }. A failure exits non-zero with a short message on standard error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const endpoint = opt('--endpoint'), keyEnv = opt('--key-env'), keyName = opt('--key-name'), keyFile = opt('--key-file'), fileOnly = args.includes('--key-file-only');
const outDir = opt('--out-dir'), resolution = opt('--resolution') ?? '768P', expansion = opt('--expansion') ?? 'balanced';
const duration = Number(opt('--duration') ?? '5'), timeoutS = Number(opt('--timeout-s') ?? '900'), maxUsd = Number(opt('--max-usd') ?? '0.5');
const rates = JSON.parse(opt('--rates-json') ?? '{}') as Record<string, number>;
interface Attached { path: string; kind: 'text' | 'image' | 'audio' }
const attachments = JSON.parse(opt('--attachments-json') ?? '[]') as Attached[];
if (!endpoint || !outDir || (!keyEnv && !keyName)) { console.error('missing --endpoint, --out-dir or --key-env'); process.exit(64); }

// --queue-base exists for the tests: it is honored only for a loopback address, so a key can never be pointed at another host. The adapter never passes it.
const base = opt('--queue-base');
const QUEUE = base && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/$/.test(base) ? base : 'https://queue.fal.run/';

const read = (command: string, argv: string[]): string | null => {
  try { return execFileSync(command, argv, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); } catch { return null; }
};
function fromFile(name: string): string | null {
  if (!keyFile || !existsSync(keyFile)) return null;
  try { const v = (JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, unknown>)[name]; return typeof v === 'string' && v ? v : null; } catch { return null; }
}
// The same lookup api-call.ts makes. The two scripts each stand alone, so the few lines are repeated.
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

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.trim()) { console.error('the prompt is empty'); process.exit(64); }

const rate = rates[resolution];
if (typeof rate !== 'number' || !(rate >= 0)) { console.error(`no price per second is set for ${resolution}, so the cost cannot be checked. Set usdPerSecondJson on the route.`); process.exit(3); }
const estimate = Math.round(rate * duration * 10000) / 10000;
if (maxUsd > 0 && estimate > maxUsd) { console.error(`this job is estimated at $${estimate.toFixed(4)}, over the route's limit of $${maxUsd} per job, so it was not sent`); process.exit(3); }

const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm', '.aac': 'audio/aac' };
const dataUri = (path: string): string => `data:${MEDIA[extname(path).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(path).toString('base64')}`;
const images = attachments.filter(a => a.kind === 'image'), audio = attachments.find(a => a.kind === 'audio');
const input: Record<string, unknown> = { prompt: prompt.trim(), duration, resolution, prompt_expansion_mode: expansion,
  ...(images[0] ? { image_url: dataUri(images[0].path) } : {}), ...(images[1] ? { end_image_url: dataUri(images[1].path) } : {}), ...(audio ? { target_audio_url: dataUri(audio.path) } : {}) };

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), timeoutS * 1000);
const authValue = `Key ${key}`;
interface Json { [k: string]: unknown }
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? v as Json : {});

let cancelUrl: string | null = null;
async function cancelled(): Promise<void> {
  if (!cancelUrl) return;
  try { await fetch(cancelUrl, { method: 'PUT', headers: { authorization: authValue }, redirect: 'manual', signal: AbortSignal.timeout(10000) }); } catch { /* the job is ending either way */ }
}

/** A request to fal's queue. A redirect is never followed, since the key rides in a header, and an address fal returns is used only when it is on the queue host. */
async function queue(url: string, method: string, body?: string): Promise<Json> {
  if (!url.startsWith(QUEUE)) { console.error('fal returned an address outside its queue, so it was not used'); process.exit(66); }
  // X-Fal-No-Retry keeps fal from running a failed request again, which would bill it again.
  const headers: Record<string, string> = { authorization: authValue, ...(body ? { 'content-type': 'application/json', 'x-fal-no-retry': '1' } : {}) };
  let res: Response;
  try { res = await fetch(url, { method, headers, ...(body ? { body } : {}), signal: abort.signal, redirect: 'manual' }); }
  catch (e) { const timedOut = abort.signal.aborted; console.error(timedOut ? 'the job timed out' : `request failed: ${(e as Error).message}`); await cancelled(); process.exit(timedOut ? 5 : 66); }
  const text = await res.text();
  if (res.status >= 300 && res.status < 400) { console.error(`HTTP ${res.status}: fal redirected the request, and Augur does not follow a redirect with a key attached.`); process.exit(2); }
  if (!res.ok) { console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(2); }
  try { return obj(JSON.parse(text)); } catch { return {}; }
}

const submitted = await queue(`${QUEUE}${endpoint}`, 'POST', JSON.stringify(input));
const statusUrl = String(submitted.status_url ?? ''), responseUrl = String(submitted.response_url ?? '');
cancelUrl = typeof submitted.cancel_url === 'string' && submitted.cancel_url.startsWith(QUEUE) ? submitted.cancel_url : null;
if (!statusUrl || !responseUrl) { console.error('fal did not return a request to follow'); process.exit(66); }

for (let wait = 2000; ; wait = Math.min(wait + 1000, 8000)) {
  await new Promise(r => setTimeout(r, wait));
  const s = await queue(statusUrl, 'GET');
  if (s.status === 'COMPLETED') {
    if (s.error) { console.error(`fal reported a failure: ${String(s.error).slice(0, 300)}`); process.exit(4); }
    break;
  }
}

const result = await queue(responseUrl, 'GET'), video = obj(result.video), videoUrl = String(video.url ?? '');
if (!/^https:\/\//.test(videoUrl) && !videoUrl.startsWith(QUEUE)) { console.error('the result held no video address'); process.exit(68); }
let file: Response;
try { file = await fetch(videoUrl, { signal: abort.signal, redirect: 'follow' }); } catch (e) { console.error(`the video could not be downloaded: ${(e as Error).message}`); process.exit(66); }
if (!file.ok) { console.error(`the video download returned HTTP ${file.status}`); process.exit(2); }
const bytes = Buffer.from(await file.arrayBuffer());
clearTimeout(timer);
const ext = extname(String(video.file_name ?? '')) || (String(video.content_type ?? '').includes('webm') ? '.webm' : '.mp4');
const path = join(outDir, `video${ext}`);
writeFileSync(path, bytes);
const answer = `Made a ${duration} second ${resolution} video with ${endpoint}. It is saved at ${path}. Estimated cost $${estimate.toFixed(4)}.`;
process.stdout.write(JSON.stringify({ answer, usage: { inputTokens: 0, outputTokens: 0, costUsd: estimate, currency: 'USD' } }));
