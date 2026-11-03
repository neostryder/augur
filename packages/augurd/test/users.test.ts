import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { UserStore } from '../src/chat/users.js';
import { makeEnv, type Env } from './harness.js';

const stores: UserStore[] = [], envs: Env[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const e of envs.splice(0)) e.dispose(); });
const store = (now?: () => number) => { const s = new UserStore(null, now); stores.push(s); return s; };

describe('chat users', () => {
  it('starts with no grants, normalizes email, and never exposes stored credentials', () => {
    const s = store(), made = s.addUser({ id: 'alice', name: 'Alice', email: 'Alice@Example.COM' });
    expect(made.user).toMatchObject({ models: [], tierCap: 'internal', dailyMessages: null, disabled: false, email: 'alice@example.com', devices: [] });
    expect(/^augc_[A-Za-z0-9_-]{43}$/.test(made.token)).toBe(true);
    expect(s.resolve(made.token)?.user.id).toBe('alice');
    expect(JSON.stringify(s.listUsers()).includes(made.token)).toBe(false);
    expect(JSON.stringify(s.listUsers())).not.toMatch(/hash/);
    expect(s.resolve('unknown')).toBeNull();
    expect(() => s.addUser({ id: 'bob', name: 'Bob', email: 'ALICE@example.com' })).toThrow(/email already/);
  });

  it('rotates a user credential and revokes devices independently', () => {
    const s = store(), made = s.addUser({ id: 'alice', name: 'Alice' }), d = s.addDevice('alice', 'Phone');
    expect(s.resolve(d.token)?.device?.id).toBe(d.device.id);
    const rotated = s.rotateUserToken('alice');
    expect(s.resolve(made.token)).toBeNull();
    expect(s.resolve(rotated.token)?.user.id).toBe('alice');
    expect(s.resolve(d.token)?.user.id).toBe('alice');
    const bob = s.addUser({ id: 'bob', name: 'Bob' });
    expect(s.revokeDevice(bob.user.id, d.device.id)).toBe(false);
    expect(s.revokeDevice('alice', d.device.id)).toBe(true);
    expect(s.resolve(d.token)).toBeNull();
    expect(s.getUser('alice')!.devices[0]!.revoked).toBe(true);
  });

  it('updates last seen at most once a minute', () => {
    let at = 1000;
    const s = store(() => at);
    s.addUser({ id: 'alice', name: 'Alice' });
    const d = s.addDevice('alice', 'Phone');
    expect(s.resolve(d.token)?.device?.lastSeen).toBe(1000);
    at += 59_999;
    expect(s.resolve(d.token)?.device?.lastSeen).toBe(1000);
    at++;
    expect(s.resolve(d.token)?.device?.lastSeen).toBe(at);
  });

  it('disables every credential and cascades device removal', () => {
    const s = store(), made = s.addUser({ id: 'alice', name: 'Alice' }), d = s.addDevice('alice', 'Phone');
    s.updateUser('alice', { name: 'A', models: ['text'], tierCap: 'public', dailyMessages: 2, disabled: true });
    expect(s.resolve(made.token)).toBeNull();
    expect(s.resolve(d.token)).toBeNull();
    s.updateUser('alice', { disabled: false, dailyMessages: null, email: null });
    expect(s.resolve(made.token)?.user).toMatchObject({ name: 'A', models: ['text'], tierCap: 'public', dailyMessages: null });
    expect(s.removeUser('alice')).toBe(true);
    expect(s.resolve(d.token)).toBeNull();
    s.addUser({ id: 'alice', name: 'Alice' });
    expect(s.getUser('alice')!.devices).toEqual([]);
  });

  it('validates user fields and device labels', () => {
    const s = store();
    for (const id of ['', 'Alice', '-alice', 'a/b', 'a'.repeat(33)]) expect(() => s.addUser({ id, name: 'Alice' })).toThrow(/slug/);
    s.addUser({ id: 'alice', name: 'Alice' });
    for (const p of [{ name: '' }, { email: 'bad' }, { models: ['text', 'text'] }, { models: [''] }, { models: 'text' }, { tierCap: 'private' }, { dailyMessages: -1 }, { dailyMessages: 1.2 }, { disabled: 1 }, { token: 'x' }]) {
      expect(() => s.updateUser('alice', p as never)).toThrow();
    }
    expect(() => s.addDevice('alice', '')).toThrow(/device label/);
    expect(() => s.addDevice('missing', 'Phone')).toThrow('No such user.');
    expect(() => s.rotateUserToken('missing')).toThrow('No such user.');
    expect(() => s.addUser({ id: 'alice', name: 'Alice' })).toThrow(/already exists/);
  });

  it('persists only digests and resolves credentials after reopening', () => {
    const env = makeEnv();
    envs.push(env);
    const path = join(env.dir, 'chat-users.db'), s = new UserStore(path);
    const made = s.addUser({ id: 'alice', name: 'Alice' }), d = s.addDevice('alice', 'Phone');
    s.close();
    const db = new DatabaseSync(path);
    try {
      for (const table of ['users', 'devices']) {
        const row = db.prepare(`SELECT token_hash FROM ${table}`).get() as { token_hash: string };
        expect(/^[a-f0-9]{64}$/.test(row.token_hash)).toBe(true);
        expect(row.token_hash === made.token || row.token_hash === d.token).toBe(false);
      }
    } finally { db.close(); }
    const reopened = new UserStore(path);
    stores.push(reopened);
    expect(reopened.resolve(made.token)?.user.id).toBe('alice');
    expect(reopened.resolve(d.token)?.device?.label).toBe('Phone');
  });
});
