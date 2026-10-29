import { join } from 'node:path';
import type { Adapter, AdapterCapabilities, AttachmentKind, ExtractInput, Extraction, JobRequest, LaunchPlan, PlanContext, RouteConfig, Served, UsageReport } from '@augur/dispatch-protocol';
import { routeSecretName } from '@augur/dispatch-protocol';
import { keyMayGoTo } from '@augur/core';
import { scriptPath } from '../paths.js';
import { keyFileOnly, keyFilePath } from '../secrets.js';
import { optNum, optStr } from './util.js';

const SCRIPT = scriptPath(import.meta.url, 'api-call');
const CAPS: AdapterCapabilities = { permissionRequests: false, sessions: false, reportsUsage: true, sandboxed: false, isolatesWorkspace: false, enforcesReadOnly: true };

/**
 * A bare model over HTTP: one prompt in, one text answer out, no tools and no files. It runs as a job like any other, so it can be timed out and cancelled.
 * Route options: `baseUrl`, `model`, `keySource` (`env`, the default, or `store`), `apiKeyEnv` (the environment variable that holds the key, for `env`), `maxTokens`, `timeoutS`,
 * `mode` (`chat`, the default, `embeddings`, `transcribe` or `moderation`; the last three are for an OpenAI-style endpoint and its embed, transcribe and moderate activities), `maxImageMb` and `maxAudioMb`,
 * `headersJson` (extra request headers, never secrets), `requestClass` (`cogitator` sends the source, route, activity and priority class, `none` or nothing sends none) and `maxInput` (the largest prompt, in characters, the supervisor accepts).
 */
/** Names a route may not set as a plain header: they carry credentials, and a credential belongs in the key store. */
const SECRET_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i;

/** Null when `text` is a JSON object of header names to plain string values with no credential header. */
export function headerProblem(text: string): string | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return 'headersJson must be a JSON object'; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'headersJson must be a JSON object';
  for (const [k, val] of Object.entries(v)) {
    if (!/^[A-Za-z0-9-]+$/.test(k) || typeof val !== 'string' || /[\r\n]/.test(val)) return `headersJson header ${k} must have a plain text value`;
    if (SECRET_HEADERS.test(k)) return `headersJson cannot set ${k}. Keep keys in the key store.`;
  }
  return null;
}

/** The priority class a job sends to Cogitator: normal for a person typing at a terminal or an urgent job, low for everything else, so background work never pushes a loaded model out. */
export function requestClass(request: JobRequest): 'low' | 'normal' {
  return request.urgent === true || (request.caller.kind === 'cli' && request.caller.interactive === true) ? 'normal' : 'low';
}

/** What a Cogitator route sends so the gateway can tell Augur's calls from anyone else's: the source, the route, the activity and the priority class. */
export function cogitatorHeaders(request: JobRequest): Record<string, string> {
  return { 'x-cogitator-source': 'augur', 'x-augur-route': request.route, 'x-cogitator-activity': request.activity, 'x-cogitator-class': requestClass(request) };
}

const MODES = ['chat', 'embeddings', 'transcribe', 'moderation'];
const KINDS: Record<string, AttachmentKind[]> = { chat: ['text', 'image'], embeddings: ['text'], transcribe: ['audio'], moderation: ['text', 'image'] };

/** The gateway's `x-cogitator-*` headers as the fields a job record keeps. */
export function servedOf(h: Record<string, string>): Served {
  const at = Number(h['chain-position']);
  return { ...(h.host ? { host: h.host } : {}), ...(h.model ? { model: h.model } : {}), ...(Number.isInteger(at) && at >= 0 ? { chainPosition: at } : {}), ...(h.degraded ? { degraded: h.degraded === 'true' || h.degraded === '1' } : {}) };
}

function make(id: string, shape: 'openai' | 'anthropic'): Adapter {
  return {
    id, transport: 'api', capabilities: CAPS, envAllow: [],
    attachmentKinds(route: RouteConfig) { return KINDS[optStr(route.options, 'mode') ?? 'chat'] ?? []; },
    validate(route: RouteConfig) {
      if (!optStr(route.options, 'baseUrl')) return 'route option baseUrl is required';
      const base = optStr(route.options, 'baseUrl') as string;
      if (!keyMayGoTo(base)) return 'baseUrl must start with https://, or with http:// for this computer or a machine on the home network only, since the key is sent with every request';
      if (!optStr(route.options, 'model')) return 'route option model is required';
      const source = optStr(route.options, 'keySource') ?? 'env';
      if (source !== 'env' && source !== 'store') return 'keySource must be env or store';
      if (source === 'env' && !optStr(route.options, 'apiKeyEnv')) return 'route option apiKeyEnv (the environment variable that holds the key) is required';
      const mode = optStr(route.options, 'mode');
      if (mode !== undefined && !MODES.includes(mode)) return 'mode must be chat, embeddings, transcribe or moderation';
      if (mode !== undefined && mode !== 'chat' && shape === 'anthropic') return 'an Anthropic-style route can only chat';
      for (const k of ['maxImageMb', 'maxAudioMb']) { const v = route.options?.[k]; if (v !== undefined && !(typeof v === 'number' && v > 0)) return `${k} must be a number of megabytes above zero`; }
      const headers = optStr(route.options, 'headersJson');
      if (headers !== undefined) { const bad = headerProblem(headers); if (bad) return bad; }
      const cls = optStr(route.options, 'requestClass');
      if (cls !== undefined && cls !== 'cogitator' && cls !== 'none') return 'requestClass must be cogitator or none, or left out';
      const max = route.options?.maxInput;
      if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max > 0)) return 'maxInput must be a whole number of characters above zero';
      return null;
    },
    plan(request: JobRequest, route: RouteConfig, ctx: PlanContext): LaunchPlan {
      if ((request.tools !== 'read' && request.tools !== 'none') || request.output !== 'text_only') throw new Error('an API route returns text only. Use tools none or read and output text_only.');
      const mode = optStr(route.options, 'mode') ?? 'chat', files = ctx.attachments ?? [];
      if (request.activity === 'embed' !== (mode === 'embeddings')) throw new Error(mode === 'embeddings' ? 'an embeddings route takes only the embed activity.' : 'the embed activity needs a route whose mode is embeddings.');
      if (request.activity === 'transcribe' !== (mode === 'transcribe')) throw new Error(mode === 'transcribe' ? 'a transcribe route takes only the transcribe activity.' : 'the transcribe activity needs a route whose mode is transcribe.');
      if (request.activity === 'moderate' !== (mode === 'moderation')) throw new Error(mode === 'moderation' ? 'a moderation route takes only the moderate activity.' : 'the moderate activity needs a route whose mode is moderation.');
      if (mode === 'transcribe' && files.filter(f => f.kind === 'audio').length !== 1) throw new Error('transcribe takes exactly one audio file.');
      const o = route.options, headers = { ...(optStr(o, 'requestClass') === 'cogitator' ? cogitatorHeaders(request) : {}), ...JSON.parse(optStr(o, 'headersJson') ?? '{}') as Record<string, string> };
      const args = [SCRIPT, '--shape', shape, '--url', optStr(o, 'baseUrl') as string, '--model', optStr(o, 'model') as string,
        ...(optStr(o, 'keySource') === 'store'
          ? ['--key-name', routeSecretName(request.route), '--key-file', keyFilePath(), ...(keyFileOnly() ? ['--key-file-only'] : [])]
          : ['--key-env', optStr(o, 'apiKeyEnv') as string]),
        ...(headers ? ['--headers-json', JSON.stringify(headers)] : []),
        ...(mode !== 'chat' ? ['--mode', mode] : []), ...(files.length ? ['--attachments-json', JSON.stringify(files.map(f => ({ path: f.path, kind: f.kind })))] : []),
        ...(mode === 'embeddings' ? ['--result-file', join(ctx.jobDir, 'vectors.json')] : []),
        '--max-tokens', String(optNum(o, 'maxTokens') ?? 4096), '--timeout-s', String(optNum(o, 'timeoutS') ?? request.timeoutS ?? 900)];
      return { command: process.execPath, args, cwd: request.cwd, env: {}, stdin: ctx.prompt };
    },
    extract(input: ExtractInput): Extraction {
      type Out = { answer?: string; usage?: Omit<UsageReport, 'source'> | null; served?: Record<string, string> };
      let r: Out | null;
      try { r = JSON.parse(input.stdout) as Out; } catch { r = null; }
      if (!r) return { answer: null, usage: null, failure: input.stderr.trim().split(String.fromCharCode(10)).pop() || 'the API call returned no result' };
      return { answer: r.answer?.trim() || null, usage: r.usage ? { ...r.usage, source: 'reported' } : null, ...(r.served ? { served: servedOf(r.served) } : {}) };
    },
  };
}

export const openaiApi = make('openai-api', 'openai');
export const anthropicApi = make('anthropic-api', 'anthropic');
