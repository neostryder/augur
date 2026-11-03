import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DATA_TIERS } from '@augur/core';
import type { ChatDevice, ChatDeviceCreated, ChatUser, ChatUserCreate, ChatUserCreated, ChatUserPatch } from '@augur/dispatch-protocol';

interface UserRow {
  id: string; name: string; email: string | null; models: string; tier_cap: ChatUser['tierCap']; daily_messages: number | null;
  disabled: number; created_at: number;
}
interface DeviceRow { id: string; user_id: string; label: string; created_at: number; last_seen: number | null; revoked: number }

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const token = (): string => 'augc_' + randomBytes(32).toString('base64url');
const slug = (id: string): void => { if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('The user id must be a lowercase slug of at most 32 characters.'); };
const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`The ${field} must contain between 1 and 200 printable characters.`);
  return value.trim();
};

export class UserStore {
  private db: DatabaseSync;

  /** A null path keeps credentials in memory. */
  constructor(path: string | null, private now: () => number = Date.now) {
    this.db = new DatabaseSync(path ?? ':memory:');
    this.db.exec(`
      PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, models TEXT NOT NULL DEFAULT '[]', tier_cap TEXT NOT NULL DEFAULT 'internal',
        daily_messages INTEGER, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, last_seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close(): void { this.db.close(); }

  private device(r: DeviceRow): ChatDevice { return { id: r.id, user: r.user_id, label: r.label, createdAt: r.created_at, lastSeen: r.last_seen, revoked: r.revoked === 1 }; }

  private user(r: UserRow): ChatUser {
    const devices = (this.db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at, id').all(r.id) as unknown as DeviceRow[]).map(d => this.device(d));
    return { id: r.id, name: r.name, email: r.email, models: JSON.parse(r.models) as string[], tierCap: r.tier_cap, dailyMessages: r.daily_messages, disabled: r.disabled === 1, createdAt: r.created_at, devices };
  }

  private patch(input: ChatUserPatch): ChatUserPatch {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The user settings must be an object.');
    for (const key of Object.keys(input)) if (!['name', 'email', 'models', 'tierCap', 'dailyMessages', 'disabled'].includes(key)) throw new Error('The user settings contain an unknown field.');
    const out = { ...input };
    if (input.name !== undefined) out.name = text(input.name, 'name');
    if (input.email !== undefined && input.email !== null) {
      if (typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new Error('The email must be a valid address.');
      out.email = input.email.toLowerCase();
    }
    if (input.models !== undefined && (!Array.isArray(input.models) || input.models.some(m => typeof m !== 'string' || !m.trim() || m.length > 200 || /[\x00-\x20\x7f]/.test(m)) || new Set(input.models).size !== input.models.length)) throw new Error('The route allowlist must contain distinct route names.');
    if (input.tierCap !== undefined && !DATA_TIERS.includes(input.tierCap)) throw new Error('The tier cap must be a known data tier.');
    if (input.dailyMessages !== undefined && input.dailyMessages !== null && (!Number.isSafeInteger(input.dailyMessages) || input.dailyMessages < 0)) throw new Error('The daily message limit must be a nonnegative integer or null.');
    if (input.disabled !== undefined && typeof input.disabled !== 'boolean') throw new Error('The disabled setting must be a boolean.');
    return out;
  }

  addUser(input: ChatUserCreate): ChatUserCreated {
    if (!input || typeof input !== 'object') throw new Error('The user must be an object.');
    slug(input.id);
    const { id, ...fields } = input, p = this.patch(fields), name = text(p.name, 'name');
    if (this.getUser(id)) throw new Error('That user id already exists.');
    if (p.email && this.db.prepare('SELECT id FROM users WHERE email = ?').get(p.email)) throw new Error('That email already belongs to a user.');
    const secret = token();
    this.db.prepare('INSERT INTO users (id, name, email, models, tier_cap, daily_messages, disabled, created_at, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, p.email ?? null, JSON.stringify(p.models ?? []), p.tierCap ?? 'internal', p.dailyMessages ?? null, p.disabled ? 1 : 0, this.now(), hash(secret));
    return { user: this.getUser(id)!, token: secret };
  }

  listUsers(): ChatUser[] { return (this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as UserRow[]).map(r => this.user(r)); }

  getUser(id: string): ChatUser | null { slug(id); const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined; return r ? this.user(r) : null; }

  updateUser(id: string, input: ChatUserPatch): ChatUser {
    const user = this.getUser(id);
    if (!user) throw new Error('No such user.');
    const p = this.patch(input), next = { ...user, ...p };
    if (next.email && this.db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(next.email, id)) throw new Error('That email already belongs to a user.');
    this.db.prepare('UPDATE users SET name = ?, email = ?, models = ?, tier_cap = ?, daily_messages = ?, disabled = ? WHERE id = ?')
      .run(next.name, next.email, JSON.stringify(next.models), next.tierCap, next.dailyMessages, next.disabled ? 1 : 0, id);
    return this.getUser(id)!;
  }

  removeUser(id: string): boolean { slug(id); return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0; }

  rotateUserToken(id: string): { token: string } {
    if (!this.getUser(id)) throw new Error('No such user.');
    const secret = token();
    this.db.prepare('UPDATE users SET token_hash = ? WHERE id = ?').run(hash(secret), id);
    return { token: secret };
  }

  addDevice(id: string, label: string): ChatDeviceCreated {
    if (!this.getUser(id)) throw new Error('No such user.');
    const clean = text(label, 'device label'), deviceId = randomUUID(), secret = token();
    this.db.prepare('INSERT INTO devices (id, user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(deviceId, id, clean, hash(secret), this.now());
    return { device: this.device(this.db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as unknown as DeviceRow), token: secret };
  }

  revokeDevice(id: string, device: string): boolean {
    slug(id);
    if (typeof device !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(device)) throw new Error('The device id must be a UUID.');
    return this.db.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND user_id = ?').run(device, id).changes > 0;
  }

  resolve(secret: string): { user: ChatUser; device?: ChatDevice } | null {
    if (typeof secret !== 'string' || !/^augc_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    const digest = hash(secret), r = this.db.prepare('SELECT * FROM users WHERE token_hash = ?').get(digest) as UserRow | undefined;
    if (r) return r.disabled ? null : { user: this.user(r) };
    const d = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked = 0').get(digest) as DeviceRow | undefined;
    if (!d) return null;
    const user = this.getUser(d.user_id);
    if (!user || user.disabled) return null;
    const at = this.now();
    if (d.last_seen === null || at - d.last_seen >= 60_000) {
      this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(at, d.id);
      d.last_seen = at;
    }
    user.devices = user.devices.map(device => device.id === d.id ? this.device(d) : device);
    return { user, device: this.device(d) };
  }
}
