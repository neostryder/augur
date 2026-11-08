import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { cleanSettings, applySettings, defaultSettings, settingsFromDocument } from '../src/chat/settings.js';
import { ChatStore, memoryBlobs } from '../src/chat/store.js';
import { makeEnv } from './harness.js';

const store = (now = () => 1000) => new ChatStore(null, memoryBlobs(), now);

describe('chat store', () => {
  it('scopes stored chats, search, mutations, and file access by owner', () => {
    const s = store();
    try {
      const a = s.create({ route: 'r', tier: 'internal', title: 'private' }, 'alice');
      const b = s.create({ route: 'r', tier: 'internal', title: 'private' }, 'bob');
      const f = s.addFile(a.id, { name: 'a.txt', mime: 'text/plain', kind: 'text' }, new Uint8Array([65]), 'alice');
      expect(s.list()).toEqual([]);
      expect(s.list('alice').map(c => c.id)).toEqual([a.id]);
      expect(s.search('private', 30, 'bob').map(c => c.id)).toEqual([b.id]);
      expect(s.get(a.id, 'bob')).toBeNull();
      expect(s.update(a.id, { title: 'Changed' }, 'bob')).toBeNull();
      expect(s.remove(a.id, 'bob')).toBe(false);
      expect(s.file(f.id, 'bob')).toBeNull();
      expect(() => s.addFile(a.id, { name: 'x', mime: '', kind: 'file' }, new Uint8Array([1]), 'bob')).toThrow('No such chat.');
      expect(s.remove(a.id, 'alice')).toBe(true);
      expect(s.file(f.id, 'alice')).toBeNull();
    } finally { s.close(); }
  });

  it('migrates existing chats to the owner and reopens the migrated database', () => {
    const env = makeEnv(), path = join(env.dir, 'chat.db'), db = new DatabaseSync(path);
    db.exec(`CREATE TABLE chats (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, route TEXT NOT NULL, tier TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
      system TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}', head TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); INSERT INTO chats (id, title, route, tier, created_at, updated_at) VALUES ('legacy', 'Legacy', 'r', 'internal', 1, 1);`);
    db.close();
    try {
      const s = new ChatStore(path, memoryBlobs());
      try {
        expect(s.get('legacy')?.title).toBe('Legacy');
        expect(s.get('legacy', 'alice')).toBeNull();
        expect(s.dailyUsage('alice', 0)).toBe(0);
        s.incrementDailyUsage('alice', 0);
        s.incrementDailyUsage('alice', 0);
        expect(s.dailyUsage('alice', 0)).toBe(2);
        expect(s.dailyUsage('bob', 0)).toBe(0);
        expect(s.dailyUsage('alice', 86400000)).toBe(0);
      } finally { s.close(); }
      const reopened = new ChatStore(path, memoryBlobs());
      try {
        expect(reopened.list().map(c => c.id)).toEqual(['legacy']);
        expect(reopened.dailyUsage('alice', 0)).toBe(2);
      } finally { reopened.close(); }
    } finally { env.dispose(); }
  });

  it('keeps a branching tree and walks the path to any head', () => {
    const s = store(), c = s.create({ route: 'r', tier: 'internal' });
    const u1 = s.addMessage({ chat: c.id, parent: null, role: 'user', text: 'hello' });
    const a1 = s.addMessage({ chat: c.id, parent: u1.id, role: 'assistant', text: 'hi' });
    const u2 = s.addMessage({ chat: c.id, parent: a1.id, role: 'user', text: 'again' });
    const alt = s.addMessage({ chat: c.id, parent: u1.id, role: 'assistant', text: 'other answer' });
    expect(s.path(c.id, u2.id).map(m => m.text)).toEqual(['hello', 'hi', 'again']);
    expect(s.path(c.id, alt.id).map(m => m.text)).toEqual(['hello', 'other answer']);
    expect(s.get(c.id)!.tree.length).toBe(4);
    expect(s.get(c.id)!.head).toBe(alt.id);
  });

  it('lists pinned chats first and finds text by search, escaping wildcards', () => {
    let t = 1;
    const s = store(() => t++), a = s.create({ route: 'r', tier: 'internal', title: 'Alpha' }), b = s.create({ route: 'r', tier: 'internal', title: 'Beta' });
    s.addMessage({ chat: a.id, parent: null, role: 'user', text: '100% sure about the cat' });
    s.update(a.id, { pinned: true });
    expect(s.list().map(c => c.title)).toEqual(['Alpha', 'Beta']);
    expect(s.search('cat').map(c => c.id)).toEqual([a.id]);
    expect(s.search('%').map(c => c.id)).toEqual([a.id]);
    expect(s.search('_').length).toBe(0);
    expect(b.id).not.toBe(a.id);
  });

  it('removes a chat with its messages and files', () => {
    const s = store(), c = s.create({ route: 'r', tier: 'internal' });
    const f = s.addFile(c.id, { name: 'a.png', mime: 'image/png', kind: 'image' }, new Uint8Array([1, 2, 3]));
    expect(s.file(f.id)?.bytes.length).toBe(3);
    expect(s.remove(c.id)).toBe(true);
    expect(s.file(f.id)).toBeNull();
    expect(s.get(c.id)).toBeNull();
  });
});

describe('chat settings', () => {
  it('sends only values the person changed and that fit the definition', () => {
    const defs = defaultSettings('openai');
    const clean = cleanSettings(defs, { temperature: '5', top_p: '', max_tokens: 12.9, reasoning_effort: 'extreme', stop: 'a\n\nb', bogus: 1 });
    expect(clean).toEqual({ temperature: 2, max_tokens: 12, stop: ['a', 'b'] });
  });

  it('places values by key and returns the system prompt apart', () => {
    const body: Record<string, unknown> = {};
    const r = applySettings(defaultSettings('anthropic'), { system: 'Be brief.', temperature: 0.3, top_k: 40 }, body);
    expect(r.system).toBe('Be brief.');
    expect(body).toEqual({ temperature: 0.3, top_k: 40 });
  });

  it('honors a dotted path from a capabilities document and drops malformed entries', () => {
    const defs = settingsFromDocument([
      { key: 'thinking', label: 'Thinking', type: 'boolean', via: 'chat_template_kwargs.enable_thinking', tooltip: 't' },
      { key: 'bad key', label: 'x', type: 'number' }, { key: 'k', label: 'x', type: 'nope' }, 'junk',
    ]);
    expect(defs.map(d => d.key)).toEqual(['thinking']);
    const body: Record<string, unknown> = {};
    applySettings(defs, { thinking: 'true' }, body);
    expect(body).toEqual({ chat_template_kwargs: { enable_thinking: true } });
  });

  it('never lets a capabilities path reach the prototype chain', () => {
    const defs = settingsFromDocument([
      { key: 'a', label: 'A', type: 'boolean', via: '__proto__.polluted', tooltip: 't' },
      { key: 'b', label: 'B', type: 'boolean', via: 'x.constructor.prototype.polluted', tooltip: 't' },
    ]);
    const body: Record<string, unknown> = {};
    applySettings(defs, { a: true, b: true }, body);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(body).toEqual({});
  });
});
