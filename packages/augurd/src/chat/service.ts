// The chat service: the model list the picker draws from, saved and temporary chats, and the streamed reply. A reply runs in its own process (call.ts) so the
// key never enters the service. Every send is checked against the same rules a job is, with the person's choice of model counting as naming it, and a
// chat's data tier only goes up: the history is sent to whatever model answers next, so a model cleared for less than the chat holds can never take it.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { DATA_TIERS, type DataTier, type PolicyFile } from '@augur/core';
import {
  CHAT_FILE_MAX_MB, CHAT_TITLE_MAX, evaluate, findModel, routeSecretName,
  type ChatDetail, type ChatEvent, type ChatFileKind, type ChatFileRef, type ChatMessage, type ChatModelInfo, type ChatSendParams, type ChatSettingDef, type ChatSummary,
  type JobRequest, type RouteConfig, type UsageSnapshot,
} from '@augur/dispatch-protocol';
import { buildEnv } from '../env.js';
import { scriptPath } from '../paths.js';
import { keyFileOnly, keyFilePath } from '../secrets.js';
import { openaiApi, anthropicApi } from '../adapters/api.js';
import { optStr } from '../adapters/util.js';
import { applySettings, cleanSettings, defaultSettings, settingsFromDocument } from './settings.js';
import { ChatStore, diskBlobs, memoryBlobs } from './store.js';

const CALL_SCRIPT = scriptPath(import.meta.url, 'chat-call', './call.ts');
const DOC_TTL_MS = 60_000;
const SAVE_EVERY_MS = 1000;
const MAX_FILES_PER_MESSAGE = 8;

/** One streamed process: its lines as objects, and a way to stop it. */
export interface CallHandle { events: AsyncIterable<Record<string, unknown>>; stop(): void }
export type Caller = (args: string[], stdin: string, env: Record<string, string>) => CallHandle;

/** Starts call.ts as a child process. Standard error is kept so a crash with no error line can still say why. */
export const spawnCaller: Caller = (args, stdin, env) => {
  const child = spawn(process.execPath, [CALL_SCRIPT, ...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { err = (err + d).slice(-2000); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin);
  async function* lines(): AsyncGenerator<Record<string, unknown>> {
    child.stdout.setEncoding('utf8');
    let buf = '', sawError = false;
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { const v = JSON.parse(line) as Record<string, unknown>; if (v.t === 'error') sawError = true; yield v; } catch { /* not a protocol line */ }
      }
    }
    const code: number | null = child.exitCode ?? await new Promise(done => child.once('close', c => done(c)));
    if (code !== 0 && !sawError) yield { t: 'error', message: err.trim().split('\n').pop() || `the reply process exited with code ${code}` };
  }
  return { events: lines(), stop: () => { try { child.kill(); } catch { /* already gone */ } } };
};

export interface ChatDeps {
  dir: string;
  routes(): Record<string, RouteConfig> | null;
  adapters: ReadonlySet<string>;
  policy(): PolicyFile | null;
  usage(): UsageSnapshot | null;
  log(message: string): void;
  caller?: Caller;
  now?: () => number;
}

const chatMode = (r: RouteConfig): boolean => (optStr(r.options, 'mode') ?? 'chat') === 'chat';
const isChatRoute = (r: RouteConfig): boolean => (r.adapter === 'openai-api' || r.adapter === 'anthropic-api') && chatMode(r);
const shapeOf = (r: RouteConfig): 'openai' | 'anthropic' => (r.adapter === 'anthropic-api' ? 'anthropic' : 'openai');

function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local') || h.endsWith('.lan');
  } catch { return false; }
}

export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const AUDIO_TYPES: Record<string, string> = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm' };
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.xml', '.yaml', '.yml', '.toml', '.ini', '.html', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.cs', '.sh', '.ps1', '.sql', '.rb', '.php', '.swift', '.kt']);

/** What a file is, by its name first and the type the browser gave second. */
export function classifyFile(name: string, mime: string): { kind: ChatFileKind; mime: string } {
  const ext = extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: 'image', mime: IMAGE_TYPES[ext]! };
  if (AUDIO_TYPES[ext]) return { kind: 'audio', mime: AUDIO_TYPES[ext]! };
  if (TEXT_EXT.has(ext) || /^text\//.test(mime)) return { kind: 'text', mime: /^text\//.test(mime) ? mime : 'text/plain' };
  return { kind: 'file', mime: mime || 'application/octet-stream' };
}

/** A short title from the first words of a message. */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  const words = t.split(' ').slice(0, 8).join(' ');
  return (words.length > CHAT_TITLE_MAX ? words.slice(0, CHAT_TITLE_MAX - 1).trimEnd() + '...' : words);
}

export class ChatService {
  readonly saved: ChatStore;
  readonly temp: ChatStore;
  private docs = new Map<string, { at: number; value: unknown }>();
  private running = new Map<string, () => void>();
  private caller: Caller;
  private now: () => number;

  constructor(private d: ChatDeps) {
    this.now = d.now ?? Date.now;
    this.saved = new ChatStore(join(d.dir, 'chat.db'), diskBlobs(join(d.dir, 'chat-files')), this.now);
    this.temp = new ChatStore(null, memoryBlobs(), this.now);
    this.caller = d.caller ?? spawnCaller;
  }

  close(): void { for (const stop of this.running.values()) stop(); this.saved.close(); this.temp.close(); }

  // ---- models ----

  private keyArgs(name: string, r: RouteConfig): { args: string[]; env: Record<string, string> } {
    const o = r.options;
    if (optStr(o, 'keySource') === 'store') return { args: ['--key-name', routeSecretName(name), '--key-file', keyFilePath(), ...(keyFileOnly() ? ['--key-file-only'] : [])], env: {} };
    const envName = optStr(o, 'apiKeyEnv') as string;
    return { args: ['--key-env', envName], env: process.env[envName] ? { [envName]: process.env[envName] as string } : {} };
  }

  private headers(r: RouteConfig): string[] {
    const h = JSON.parse(optStr(r.options, 'headersJson') ?? '{}') as Record<string, string>;
    return [...(optStr(r.options, 'requestClass') === 'cogitator' ? ['--headers-json', JSON.stringify({ ...h, 'x-cogitator-class': 'interactive' })] : Object.keys(h).length ? ['--headers-json', JSON.stringify(h)] : [])];
  }

  /** Cogitator's capabilities document for a route, cached for a minute. Null when the route is not Cogitator's or the call fails. */
  private async capabilities(name: string, r: RouteConfig): Promise<Record<string, unknown> | null> {
    if (optStr(r.options, 'requestClass') !== 'cogitator') return null;
    const hit = this.docs.get(name);
    if (hit && this.now() - hit.at < DOC_TTL_MS) return hit.value as Record<string, unknown> | null;
    let value: Record<string, unknown> | null = null;
    try {
      const k = this.keyArgs(name, r);
      const handle = (this.caller)(['--mode', 'capabilities', '--shape', 'openai', '--url', optStr(r.options, 'baseUrl') as string, ...k.args, ...this.headers(r), '--timeout-s', '10'], '{}',
        buildEnv([], k.env));
      for await (const ev of handle.events) if (ev.t !== 'error' && typeof ev === 'object' && 'schema' in ev) value = ev;
    } catch { value = null; }
    this.docs.set(name, { at: this.now(), value });
    return value;
  }

  /** The routes a chat can use, with what the rules say about each. */
  async models(): Promise<ChatModelInfo[]> {
    const out: ChatModelInfo[] = [];
    const policy = this.d.policy();
    for (const [name, r] of Object.entries(this.d.routes() ?? {})) {
      if (!isChatRoute(r) || !this.d.adapters.has(r.adapter)) continue;
      const shape = shapeOf(r), baseUrl = optStr(r.options, 'baseUrl') ?? '';
      let settings: ChatSettingDef[] = defaultSettings(shape), vision = shape === 'anthropic' ? true : r.options?.vision === true, contextTokens: number | undefined;
      if (r.options?.vision === false) vision = false;
      const doc = await this.capabilities(name, r);
      const entry = Array.isArray(doc?.models) ? (doc.models as Array<Record<string, unknown>>).find(m => m.id === optStr(r.options, 'model')) : undefined;
      if (entry) {
        const fromDoc = settingsFromDocument(entry.settings);
        if (fromDoc.length) settings = fromDoc;
        const input = (entry.modalities as { input?: unknown } | undefined)?.input;
        if (Array.isArray(input)) vision = input.includes('image');
        if (typeof entry.context_tokens === 'number') contextTokens = entry.context_tokens;
      }
      const found = policy ? findModel(policy, r.model) : null;
      const probe = this.clearance(name, r, 'public');
      out.push({
        route: name, label: optStr(r.options, 'label') ?? ((entry?.title as string | undefined) || r.model), model: r.model, shape, vision, local: isLocalUrl(baseUrl),
        tierMax: found?.model.dataTier ?? null, usable: probe === null, ...(probe ? { why: probe } : {}), ...(contextTokens ? { contextTokens } : {}), settings,
      });
    }
    return out.sort((a, b) => Number(b.usable) - Number(a.usable) || Number(b.local) - Number(a.local) || a.label.localeCompare(b.label));
  }

  /** Null when the rules let this route take a chat at `tier`, otherwise the reason it cannot. */
  private clearance(name: string, r: RouteConfig, tier: DataTier): string | null {
    const adapter = r.adapter === 'anthropic-api' ? anthropicApi : openaiApi;
    const request: JobRequest = { route: name, activity: 'research', dataTier: tier, tools: 'read', output: 'text_only', cwd: homedir(), prompt: { text: '' }, named: true, caller: { kind: 'cli', interactive: true } as JobRequest['caller'] };
    const decision = evaluate(request, { policy: this.d.policy(), usage: this.d.usage(), route: r, capabilities: adapter.capabilities });
    return decision.allow ? null : decision.rejection.reason;
  }

  // ---- chats ----

  private storeOf(id: string): ChatStore | null { return this.saved.get(id) ? this.saved : this.temp.get(id) ? this.temp : null; }

  list(): ChatSummary[] { return [...this.saved.list(), ...this.temp.list().map(c => ({ ...c, temporary: true }))].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt); }

  search(query: string): Array<ChatSummary & { snippet: string }> { return [...this.saved.search(query), ...this.temp.search(query).map(c => ({ ...c, temporary: true }))]; }

  get(id: string): ChatDetail | null {
    const s = this.storeOf(id);
    const c = s?.get(id);
    return c ? { ...c, temporary: s === this.temp } : null;
  }

  create(input: { route: string; tier?: DataTier; temporary?: boolean; title?: string; system?: string; settings?: Record<string, unknown> }): ChatSummary {
    const r = this.d.routes()?.[input.route];
    if (!r || !isChatRoute(r)) throw new Error('That route cannot chat.');
    const tier = input.tier ?? 'sensitive';
    const why = this.clearance(input.route, r, tier);
    if (why) throw new Error(why);
    const store = input.temporary ? this.temp : this.saved;
    const made = store.create({ route: input.route, tier, ...(input.title ? { title: input.title } : {}), ...(input.system ? { system: input.system } : {}), ...(input.settings ? { settings: input.settings } : {}) });
    return { ...made, temporary: store === this.temp };
  }

  update(id: string, patch: { title?: string; route?: string; tier?: DataTier; pinned?: boolean; system?: string; settings?: Record<string, unknown>; head?: string | null }): ChatSummary {
    const store = this.storeOf(id), chat = store?.get(id);
    if (!store || !chat) throw new Error('No such chat.');
    if (patch.tier !== undefined && DATA_TIERS.indexOf(patch.tier) < DATA_TIERS.indexOf(chat.tier) && chat.messages > 0) throw new Error('A chat that has messages cannot be set to a lower data tier, since what it holds has already been sent.');
    const tier = patch.tier ?? chat.tier, route = patch.route ?? chat.route;
    if (patch.route !== undefined || patch.tier !== undefined) {
      const r = this.d.routes()?.[route];
      if (!r || !isChatRoute(r)) throw new Error('That route cannot chat.');
      const why = this.clearance(route, r, tier);
      if (why) throw new Error(why);
    }
    if (patch.head !== undefined && patch.head !== null && store.getMessage(patch.head)?.chat !== id) throw new Error('That message is not in this chat.');
    const next = store.update(id, { ...patch, ...(patch.title !== undefined ? { title: patch.title.slice(0, CHAT_TITLE_MAX) } : {}) });
    return { ...next!, temporary: store === this.temp };
  }

  remove(id: string): boolean {
    this.running.get(id)?.();
    const store = this.storeOf(id);
    return store ? store.remove(id) : false;
  }

  /** Stops the reply being written for a chat, if there is one. */
  stop(id: string): boolean { const stop = this.running.get(id); stop?.(); return !!stop; }

  // ---- files ----

  upload(chat: string, name: string, mime: string, bytes: Uint8Array): ChatFileRef {
    const store = this.storeOf(chat);
    if (!store) throw new Error('No such chat.');
    if (bytes.byteLength === 0) throw new Error('That file is empty.');
    if (bytes.byteLength > CHAT_FILE_MAX_MB * 1048576) throw new Error(`A file may be at most ${CHAT_FILE_MAX_MB} MB.`);
    const cleanName = name.replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 120) || 'file';
    const c = classifyFile(cleanName, mime);
    return store.addFile(chat, { name: cleanName, mime: c.mime, kind: c.kind }, bytes);
  }

  file(id: string): { ref: ChatFileRef; bytes: Uint8Array } | null {
    const hit = this.saved.file(id) ?? this.temp.file(id);
    return hit ? { ref: hit.ref, bytes: hit.bytes } : null;
  }

  // ---- the reply ----

  async *send(params: ChatSendParams): AsyncGenerator<ChatEvent> {
    const store = this.storeOf(params.chat), chat = store?.get(params.chat);
    if (!store || !chat) { yield { t: 'error', message: 'No such chat.' }; return; }
    if (this.running.has(chat.id)) { yield { t: 'error', message: 'This chat is already writing a reply.' }; return; }
    const routeName = params.route ?? chat.route, route = this.d.routes()?.[routeName];
    if (!route || !isChatRoute(route)) { yield { t: 'error', message: 'That route cannot chat.' }; return; }
    const why = this.clearance(routeName, route, chat.tier);
    if (why) { yield { t: 'error', message: why }; return; }
    const info = (await this.models()).find(m => m.route === routeName);
    if (!info) { yield { t: 'error', message: 'That route is not available.' }; return; }

    // Where the new messages hang. A retry answers an existing user message again; anything else adds a user message under `parent`, or the head.
    let user: ChatMessage;
    if (params.retry) {
      const m = store.getMessage(params.retry);
      if (!m || m.chat !== chat.id || m.role !== 'user') { yield { t: 'error', message: 'That message cannot be answered again.' }; return; }
      user = m;
    } else {
      const text = params.text ?? '';
      const files = (params.files ?? []).slice(0, MAX_FILES_PER_MESSAGE).map(id => store.file(id)).filter((f): f is NonNullable<typeof f> => !!f && f.chat === chat.id).map(f => f.ref);
      if (!text.trim() && !files.length) { yield { t: 'error', message: 'There is nothing to send.' }; return; }
      const parent = params.parent === undefined ? chat.head : params.parent;
      if (parent && store.getMessage(parent)?.chat !== chat.id) { yield { t: 'error', message: 'That message is not in this chat.' }; return; }
      user = store.addMessage({ chat: chat.id, parent, role: 'user', text, files });
    }
    const assistant = store.addMessage({ chat: chat.id, parent: user.id, role: 'assistant', route: routeName, state: 'streaming' });
    yield { t: 'start', user, assistant };

    const thread = store.path(chat.id, user.id);
    if (!info.vision && thread.some(m => m.files.some(f => f.kind === 'image'))) {
      const message = `${info.label} cannot see images. Pick a model that can, or start the chat again without them.`;
      store.updateMessage(assistant.id, { state: 'error', error: message });
      yield { t: 'error', message };
      return;
    }

    // Files go to a folder only this reply reads, and the folder goes when the reply ends.
    const scratch = join(this.d.dir, 'chat-tmp', assistant.id);
    mkdirSync(scratch, { recursive: true });
    const wire = thread.map(m => ({ role: m.role, text: m.text, files: m.files.filter(f => f.kind === 'image' || f.kind === 'text').flatMap(f => {
      const hit = store.file(f.id);
      if (!hit) return [];
      const path = join(scratch, f.id + extname(f.name));
      writeFileSync(path, hit.bytes);
      return [{ path, kind: f.kind, mime: f.mime }];
    }) }));
    const body: Record<string, unknown> = {};
    const { system } = applySettings(info.settings, cleanSettings(info.settings, chat.settings), body);
    const k = this.keyArgs(routeName, route);
    const handle = this.caller(['--shape', info.shape, '--url', optStr(route.options, 'baseUrl') as string, '--model', optStr(route.options, 'model') as string, ...k.args, ...this.headers(route),
      '--timeout-s', String(typeof route.options?.timeoutS === 'number' ? route.options.timeoutS : 600)],
    JSON.stringify({ system, messages: wire.filter(m => m.text || m.files.length), body, maxTokens: typeof route.options?.maxTokens === 'number' ? route.options.maxTokens : undefined }), buildEnv([], k.env));

    let text = '', reasoning = '', usage: ChatMessage['usage'], served: Record<string, string> | undefined, failed: string | null = null, stopped = false, lastSave = 0;
    this.running.set(chat.id, () => { stopped = true; handle.stop(); });
    const save = (state?: ChatMessage['state']) => store.updateMessage(assistant.id, { text, reasoning, ...(usage ? { usage } : {}), ...(served ? { served } : {}), ...(state ? { state } : {}), ...(failed ? { error: failed } : {}) });
    try {
      for await (const ev of handle.events) {
        if (ev.t === 'delta' && typeof ev.text === 'string') { text += ev.text; yield { t: 'delta', text: ev.text }; }
        else if (ev.t === 'think' && typeof ev.text === 'string') { reasoning += ev.text; yield { t: 'think', text: ev.text }; }
        else if (ev.t === 'usage') { usage = ev.usage as ChatMessage['usage']; yield { t: 'usage', usage: usage! }; }
        else if (ev.t === 'served') served = ev.served as Record<string, string>;
        else if (ev.t === 'error') failed = String(ev.message ?? 'the reply failed');
        if (this.now() - lastSave > SAVE_EVERY_MS) { save(); lastSave = this.now(); }
      }
    } catch (e) { failed = (e as Error).message; }
    finally { this.running.delete(chat.id); try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the folder goes with the next sweep */ } }

    const state: ChatMessage['state'] = stopped ? 'stopped' : failed ? 'error' : 'done';
    save(state);
    if (state === 'done' && chat.title === 'New chat' && !params.retry) {
      const title = titleFrom(user.text);
      store.update(chat.id, { title });
      yield { t: 'title', title };
    }
    const final = store.getMessage(assistant.id)!;
    if (failed && !stopped) yield { t: 'error', message: failed };
    yield { t: 'done', message: final };
  }
}

export { isChatRoute };
