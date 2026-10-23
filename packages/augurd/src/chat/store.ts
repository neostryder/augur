// Saved chats: one SQLite file for the chats and their messages, and a folder for the files people attach and models make. A temporary chat uses the same
// class over an in-memory database and an in-memory file map, so closing it, or restarting the service, leaves nothing on disk.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_TIERS, type DataTier } from '@augur/core';
import type { ChatDetail, ChatFileKind, ChatFileRef, ChatMessage, ChatMessageState, ChatSummary } from '@augur/dispatch-protocol';

export interface Blobs { put(id: string, bytes: Uint8Array): void; get(id: string): Uint8Array | null; del(id: string): void }

export const diskBlobs = (dir: string): Blobs => {
  mkdirSync(dir, { recursive: true });
  const path = (id: string) => join(dir, id.replace(/[^A-Za-z0-9_-]/g, ''));
  return {
    put: (id, bytes) => writeFileSync(path(id), bytes),
    get: id => { try { return readFileSync(path(id)); } catch { return null; } },
    del: id => { try { rmSync(path(id), { force: true }); } catch { /* a file already gone is the goal */ } },
  };
};

export const memoryBlobs = (): Blobs => {
  const held = new Map<string, Uint8Array>();
  return { put: (id, bytes) => { held.set(id, bytes); }, get: id => held.get(id) ?? null, del: id => { held.delete(id); } };
};

interface ChatRow { id: string; title: string; route: string; tier: string; pinned: number; system: string; settings: string; head: string | null; created_at: number; updated_at: number }
interface MessageRow {
  id: string; chat_id: string; parent: string | null; role: string; text: string; reasoning: string | null; files: string; route: string | null;
  usage: string | null; served: string | null; state: string; error: string | null; at: number;
}
interface FileRow { id: string; chat_id: string; name: string; mime: string; bytes: number; kind: string }

export interface NewChat { route: string; tier: DataTier; title?: string; system?: string; settings?: Record<string, unknown> }
export interface ChatPatch { title?: string; route?: string; tier?: DataTier; pinned?: boolean; system?: string; settings?: Record<string, unknown>; head?: string | null }
export interface NewMessage {
  chat: string; parent: string | null; role: 'user' | 'assistant'; text?: string; files?: ChatFileRef[]; route?: string; state?: ChatMessageState;
}
export interface MessagePatch { text?: string; reasoning?: string; files?: ChatFileRef[]; usage?: ChatMessage['usage']; served?: Record<string, string>; state?: ChatMessageState; error?: string }

const json = <T>(text: string | null, fallback: T): T => { if (!text) return fallback; try { return JSON.parse(text) as T; } catch { return fallback; } };
const preview = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 120);

export class ChatStore {
  private db: DatabaseSync;

  /** `path` of null keeps everything in memory. */
  constructor(path: string | null, private blobs: Blobs, private now: () => number = Date.now) {
    this.db = new DatabaseSync(path ?? ':memory:');
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, route TEXT NOT NULL, tier TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, system TEXT NOT NULL DEFAULT '',
        settings TEXT NOT NULL DEFAULT '{}', head TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, parent TEXT, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
        reasoning TEXT, files TEXT NOT NULL DEFAULT '[]', route TEXT, usage TEXT, served TEXT, state TEXT NOT NULL, error TEXT, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, at);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_chat ON files(chat_id);
    `);
    // A reply that was streaming when the service stopped will never finish.
    this.db.prepare("UPDATE messages SET state = 'stopped' WHERE state = 'streaming'").run();
  }

  close(): void { this.db.close(); }

  private summary(r: ChatRow): ChatSummary {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(r.id) as { n: number };
    const last = this.db.prepare('SELECT text FROM messages WHERE chat_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(r.id) as { text: string } | undefined;
    return { id: r.id, title: r.title, route: r.route, tier: r.tier as DataTier, pinned: r.pinned === 1, temporary: false, createdAt: r.created_at, updatedAt: r.updated_at, messages: n.n, preview: preview(last?.text ?? '') };
  }

  create(input: NewChat): ChatSummary {
    if (!DATA_TIERS.includes(input.tier)) throw new Error('Unknown data tier.');
    const id = randomUUID(), at = this.now();
    this.db.prepare('INSERT INTO chats (id, title, route, tier, system, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.title?.trim() || 'New chat', input.route, input.tier, input.system ?? '', JSON.stringify(input.settings ?? {}), at, at);
    return this.summary(this.row(id)!);
  }

  private row(id: string): ChatRow | undefined { return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined; }

  /** Pinned chats first, then the most recently used. */
  list(): ChatSummary[] {
    return (this.db.prepare('SELECT * FROM chats ORDER BY pinned DESC, updated_at DESC').all() as unknown as ChatRow[]).map(r => this.summary(r));
  }

  get(id: string): ChatDetail | null {
    const r = this.row(id);
    if (!r) return null;
    const tree = (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY at, rowid').all(id) as unknown as MessageRow[]).map(m => this.message(m));
    return { ...this.summary(r), system: r.system, settings: json<Record<string, unknown>>(r.settings, {}), head: r.head, tree };
  }

  update(id: string, patch: ChatPatch): ChatSummary | null {
    const r = this.row(id);
    if (!r) return null;
    if (patch.tier !== undefined && !DATA_TIERS.includes(patch.tier)) throw new Error('Unknown data tier.');
    const next = {
      title: patch.title !== undefined ? patch.title.trim() || r.title : r.title, route: patch.route ?? r.route, tier: patch.tier ?? r.tier,
      pinned: patch.pinned === undefined ? r.pinned : patch.pinned ? 1 : 0, system: patch.system ?? r.system,
      settings: patch.settings ? JSON.stringify(patch.settings) : r.settings, head: patch.head === undefined ? r.head : patch.head,
    };
    this.db.prepare('UPDATE chats SET title = ?, route = ?, tier = ?, pinned = ?, system = ?, settings = ?, head = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.route, next.tier, next.pinned, next.system, next.settings, next.head, this.now(), id);
    return this.summary(this.row(id)!);
  }

  remove(id: string): boolean {
    const files = this.db.prepare('SELECT id FROM files WHERE chat_id = ?').all(id) as unknown as Array<{ id: string }>;
    const gone = this.db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0;
    if (gone) for (const f of files) this.blobs.del(f.id);
    return gone;
  }

  private message(m: MessageRow): ChatMessage {
    const usage = json<ChatMessage['usage'] | null>(m.usage, null), served = json<Record<string, string> | null>(m.served, null);
    return {
      id: m.id, parent: m.parent, role: m.role as ChatMessage['role'], text: m.text, ...(m.reasoning ? { reasoning: m.reasoning } : {}), files: json<ChatFileRef[]>(m.files, []),
      ...(m.route ? { route: m.route } : {}), ...(usage ? { usage } : {}), ...(served ? { served } : {}), state: m.state as ChatMessageState, ...(m.error ? { error: m.error } : {}), at: m.at,
    };
  }

  addMessage(input: NewMessage): ChatMessage {
    const id = randomUUID(), at = this.now();
    this.db.prepare('INSERT INTO messages (id, chat_id, parent, role, text, files, route, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.chat, input.parent, input.role, input.text ?? '', JSON.stringify(input.files ?? []), input.route ?? null, input.state ?? 'done', at);
    this.db.prepare('UPDATE chats SET head = ?, updated_at = ? WHERE id = ?').run(id, at, input.chat);
    return this.message(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow);
  }

  getMessage(id: string): (ChatMessage & { chat: string }) | null {
    const m = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow | undefined;
    return m ? { ...this.message(m), chat: m.chat_id } : null;
  }

  updateMessage(id: string, patch: MessagePatch): void {
    const m = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow | undefined;
    if (!m) return;
    this.db.prepare('UPDATE messages SET text = ?, reasoning = ?, files = ?, usage = ?, served = ?, state = ?, error = ? WHERE id = ?').run(
      patch.text ?? m.text, patch.reasoning ?? m.reasoning, patch.files ? JSON.stringify(patch.files) : m.files, patch.usage ? JSON.stringify(patch.usage) : m.usage,
      patch.served ? JSON.stringify(patch.served) : m.served, patch.state ?? m.state, patch.error ?? m.error, id);
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(this.now(), m.chat_id);
  }

  /** The messages from the root down to `head`, oldest first: the branch a model is shown. */
  path(chat: string, head: string | null): ChatMessage[] {
    const out: ChatMessage[] = [];
    const seen = new Set<string>();
    for (let id = head; id && !seen.has(id); ) {
      seen.add(id);
      const m = this.getMessage(id);
      if (!m || m.chat !== chat) break;
      out.push(m);
      id = m.parent;
    }
    return out.reverse();
  }

  addFile(chat: string, input: { name: string; mime: string; kind: ChatFileKind }, bytes: Uint8Array): ChatFileRef {
    const id = `f_${randomUUID()}`;
    this.blobs.put(id, bytes);
    this.db.prepare('INSERT INTO files (id, chat_id, name, mime, bytes, kind) VALUES (?, ?, ?, ?, ?, ?)').run(id, chat, input.name, input.mime, bytes.byteLength, input.kind);
    return { id, name: input.name, mime: input.mime, bytes: bytes.byteLength, kind: input.kind };
  }

  file(id: string): { ref: ChatFileRef; chat: string; bytes: Uint8Array } | null {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
    const bytes = r ? this.blobs.get(id) : null;
    return r && bytes ? { ref: { id: r.id, name: r.name, mime: r.mime, bytes: r.bytes, kind: r.kind as ChatFileKind }, chat: r.chat_id, bytes } : null;
  }

  /** Chats whose title or any message contains `query`, newest first. Case-insensitive; LIKE wildcards in the query are literal. */
  search(query: string, limit = 30): Array<ChatSummary & { snippet: string }> {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    const rows = this.db.prepare(`
      SELECT c.*, (SELECT m.text FROM messages m WHERE m.chat_id = c.id AND m.text LIKE ? ESCAPE '\\' ORDER BY m.at LIMIT 1) AS hit
      FROM chats c WHERE c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.text LIKE ? ESCAPE '\\')
      ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ?`).all(like, like, like, limit) as unknown as Array<ChatRow & { hit: string | null }>;
    return rows.map(r => {
      const text = r.hit ?? r.title, at = text.toLowerCase().indexOf(q.toLowerCase());
      const from = Math.max(0, at - 40);
      return { ...this.summary(r), snippet: preview(text.slice(from, from + 160)) };
    });
  }
}
