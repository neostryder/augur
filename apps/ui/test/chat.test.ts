import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDetail, ChatMeResponse, ChatModelInfo } from '@augur/dispatch-protocol';
import { adminApi, api, fileUrl, send, setToken, Unauthorized, Unregistered } from '../src/chat/api';
import { MULTI_USER } from '../src/chat/copy';
import { cappedTier, identify, TIERS, tiersFor } from '../src/chat/session';
import { fits, noAssignedModels, sendMessage, setTier, state } from '../src/chat/state';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null }); });

const user: ChatMeResponse = { kind: 'user', user: { id: 'pat', name: 'Pat', models: [], tierCap: 'internal', dailyMessages: null } };
const fetcher = vi.fn<typeof fetch>();
const reply = (value: unknown, status = 200): void => { fetcher.mockResolvedValueOnce(new Response(JSON.stringify(value), { status })); };

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('location', { href: 'https://chat.example/chat/' });
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  setToken('');
  state.identity = null;
  state.current = null;
  state.streaming = null;
  state.toast = null;
  state.needsToken = false;
});

afterEach(() => { setToken(''); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('chat credentials', () => {
  it('omits Authorization for an Access identity and sends a stored token', async () => {
    reply(user);
    await api.me();
    expect(fetcher.mock.calls[0]![0]).toBe('https://chat.example/api/chat/me');
    expect(fetcher.mock.calls[0]![1]!.headers).not.toHaveProperty('Authorization');
    localStorage.setItem('augur.webToken', 'test-credential');
    reply({ kind: 'owner' });
    await api.me();
    expect(fetcher.mock.calls[1]![1]!.headers).toEqual({ Authorization: 'Bearer test-credential' });
    setToken('');
    reply(user);
    await api.me();
    expect(fetcher.mock.calls[2]![1]!.headers).not.toHaveProperty('Authorization');
  });

  it('omits Authorization from JSON, upload, file and streaming requests without a token', async () => {
    reply({});
    await api.create({ route: 'local' });
    reply({});
    await api.upload('chat', new File(['text'], 'note.txt', { type: 'text/plain' }));
    const makeUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    fetcher.mockResolvedValueOnce(new Response('file'));
    await fileUrl('access-file');
    fetcher.mockResolvedValueOnce(new Response(''));
    await send({ chat: 'chat', text: 'Hello' }, () => undefined, new AbortController().signal);
    for (const [, init] of fetcher.mock.calls) expect(init!.headers).not.toHaveProperty('Authorization');
    expect(fetcher.mock.calls[0]![1]!.headers).toHaveProperty('Content-Type', 'application/json');
    makeUrl.mockRestore();
  });

  it('sends explicit credentials for chat requests', async () => {
    setToken('test-credential');
    reply({ models: [] });
    await api.models();
    expect(fetcher.mock.calls[0]![1]!.headers).toHaveProperty('Authorization', 'Bearer test-credential');
  });
});

describe('chat boot', () => {
  it.each([{ kind: 'owner' } as ChatMeResponse, user, { ...user, via: 'access' } as ChatMeResponse])('opens a recognized identity: %j', async identity => {
    reply(identity);
    await expect(identify()).resolves.toEqual({ screen: 'chat', identity });
  });

  it('opens the token gate for HTTP 401', async () => {
    reply({ error: 'Missing or wrong token.' }, 401);
    await expect(identify()).resolves.toEqual({ screen: 'gate', message: MULTI_USER.GATE.rejected });
  });

  it('ends at the access message for HTTP 403', async () => {
    fetcher.mockResolvedValueOnce(new Response('This person is not set up for Augur Chat.', { status: 403 }));
    await expect(identify()).resolves.toEqual({ screen: 'unregistered', message: MULTI_USER.GATE.unregistered });
  });

  it('shows a service error for network and server failures', async () => {
    fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(identify()).resolves.toEqual({ screen: 'error', message: MULTI_USER.GATE.unavailable });
    reply({ error: 'Unavailable' }, 503);
    expect((await identify()).screen).toBe('error');
  });
});

describe('user tiers', () => {
  it.each(TIERS)('offers only tiers at or below %s', tierCap => {
    const identity = { ...user, user: { ...user.user, tierCap } };
    expect(tiersFor(identity)).toEqual(TIERS.slice(0, TIERS.indexOf(tierCap) + 1));
    expect(cappedTier('regulated', identity)).toBe(tierCap);
    expect(cappedTier('public', identity)).toBe('public');
  });

  it('offers all four tiers for the owner', () => {
    expect(tiersFor({ kind: 'owner' })).toEqual(TIERS);
    expect(cappedTier('regulated', { kind: 'owner' })).toBe('regulated');
  });

  it('blocks a tier above the cap even for a route that supports it', async () => {
    state.identity = user;
    state.draft.tier = 'internal';
    const route: ChatModelInfo = { route: 'local', label: 'Local', model: 'local/test', shape: 'openai', vision: false, local: true, tierMax: 'regulated', usable: true, settings: [] };
    expect(fits(route, 'internal')).toBe(true);
    expect(fits(route, 'sensitive')).toBe(false);
    await setTier('regulated');
    expect(state.draft.tier).toBe('internal');
    expect(fetcher).not.toHaveBeenCalled();
    expect(noAssignedModels()).toBe(true);
    state.identity = { kind: 'owner' };
    expect(noAssignedModels()).toBe(false);
  });
});

describe('owner admin calls', () => {
  it('uses the main listener admin paths, methods and request bodies', async () => {
    setToken('test-owner-credential');
    const calls: Array<[() => Promise<unknown>, string, string, unknown?]> = [
      [() => adminApi.users(), 'users', 'GET'],
      [() => adminApi.routes(), 'routes', 'GET'],
      [() => adminApi.createUser({ id: 'pat', name: 'Pat' }), 'users', 'POST', { id: 'pat', name: 'Pat' }],
      [() => adminApi.patchUser('pat/id', { tierCap: 'public' }), 'users/pat%2Fid', 'PATCH', { tierCap: 'public' }],
      [() => adminApi.deleteUser('pat/id'), 'users/pat%2Fid', 'DELETE'],
      [() => adminApi.deleteUser('pat/id', true), 'users/pat%2Fid?purge=1', 'DELETE'],
      [() => adminApi.rotateUserToken('pat/id'), 'users/pat%2Fid/token', 'POST', {}],
      [() => adminApi.addDevice('pat/id', 'Phone'), 'users/pat%2Fid/devices', 'POST', { label: 'Phone' }],
      [() => adminApi.revokeDevice('pat/id', 'device/id'), 'users/pat%2Fid/devices/device%2Fid', 'DELETE'],
    ];
    for (const [invoke, path, method, body] of calls) {
      reply({ users: [], routes: [] });
      await invoke();
      const [url, init] = fetcher.mock.calls.at(-1)!;
      expect(url).toBe(`https://chat.example/api/admin/chat/${path}`);
      expect(init!.method ?? 'GET').toBe(method);
      expect(init!.body).toBe(body === undefined ? undefined : JSON.stringify(body));
      expect(init!.headers).toHaveProperty('Authorization', 'Bearer test-owner-credential');
    }
  });

  it.each([401, 404])('returns a plain Error for admin HTTP %s', async status => {
    fetcher.mockResolvedValueOnce(new Response('No such call.', { status }));
    const error = await adminApi.users().catch(e => e);
    expect(error.constructor).toBe(Error);
    expect(error).not.toBeInstanceOf(Unauthorized);
    expect(error).not.toBeInstanceOf(Unregistered);
    expect(error.message).toBe('No such call.');
  });
});

describe('server refusals', () => {
  it.each(['This user has reached the daily message limit.', 'This user cannot use that route.'])('keeps the refusal sentence: %s', async error => {
    reply({ error }, 403);
    await expect(api.create({ route: 'local' })).rejects.toThrow(error);
    reply({ error }, 429);
    await expect(send({ chat: 'chat', text: 'Hello' }, () => undefined, new AbortController().signal)).rejects.toThrow(error);
  });

  it.each(['This user has reached the daily message limit.', 'This user cannot use that route.'])('puts the streamed refusal in a toast and keeps the draft: %s', async message => {
    vi.useFakeTimers();
    const chat: ChatDetail = { id: 'chat', title: 'Chat', route: 'local', tier: 'internal', pinned: false, temporary: false, createdAt: 1, updatedAt: 1, messages: 0, preview: '', system: '', settings: {}, head: null, tree: [] };
    state.current = chat;
    state.identity = user;
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ t: 'error', message }) + '\n'));
    reply(chat);
    await expect(sendMessage({ text: 'Hello' })).resolves.toBe(false);
    expect(state.toast?.text).toBe(message);
    expect(state.toast?.kind).toBe('error');
    expect(state.needsToken).toBe(false);
  });
});
