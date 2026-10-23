import { describe, expect, it } from 'vitest';
import { cleanSettings, applySettings, defaultSettings, settingsFromDocument } from '../src/chat/settings.js';
import { ChatStore, memoryBlobs } from '../src/chat/store.js';

const store = (now = () => 1000) => new ChatStore(null, memoryBlobs(), now);

describe('chat store', () => {
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
});
