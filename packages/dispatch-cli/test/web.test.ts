import { describe, it, expect } from 'vitest';
import { main } from '../src/cli.js';
import { UserStore, ChatStore, diskBlobs } from '@augur/augurd';
import { makeEnv } from '../../augurd/test/harness.js';
import { join } from 'node:path';
import { webCmd, type WebDeps } from '../src/web.js';

const TOKEN = 'a'.repeat(64);
function run(rest: string[], settings: Partial<WebDeps['settings']> = {}, addresses = ['http://127.0.0.1:7420/'], fingerprint: string | null = null) {
  let out = '', err = '', rotated = 0;
  const deps: WebDeps = {
    settings: { enabled: true, host: '127.0.0.1', port: 7420, tlsCert: '', tlsKey: '', tlsAuto: 'auto', ...settings },
    token: () => TOKEN, rotate: () => { rotated++; return 'b'.repeat(64); }, addresses: () => addresses, fingerprint: () => fingerprint,
  };
  const data: unknown[] = [];
  const code = webCmd(rest, (t, d) => { out += t + '\n'; data.push(d); }, deps, t => { err += t; });
  return { code, out, err, rotated, data };
}

describe('augur web', () => {
  it('says how to turn the web app on when it is off, and shows no token', () => {
    const r = run([], { enabled: false });
    expect(r.out).toContain('augur config set web.enabled true');
    expect(r.out).not.toContain(TOKEN);
  });

  it('lists a link per address with the token in the fragment', () => {
    const r = run([]);
    expect(r.out).toContain(`http://127.0.0.1:7420/#token=${TOKEN}`);
    expect(r.out).not.toContain('plain http');
  });

  it('warns about a network address with no TLS, and not with TLS or on this computer only', () => {
    const open = run([], { host: '0.0.0.0', tlsAuto: 'off' }, ['http://192.168.1.5:7420/']);
    expect(open.out).toContain('plain http');
    expect(run([], { host: '0.0.0.0', tlsCert: 'c', tlsKey: 'k' }, ['https://192.168.1.5:7420/']).out).not.toContain('plain http');
    expect(run([], { host: '0.0.0.0' }, ['https://192.168.1.5:7420/']).out).not.toContain('plain http');
  });

  it('shows the fingerprint to check when the service makes its own certificate', () => {
    const fp = 'AB:CD:EF';
    const r = run([], { host: '0.0.0.0' }, ['https://192.168.1.5:7420/'], fp);
    expect(r.out).not.toContain('plain http');
    expect(run([], { tlsAuto: 'on' }, ['https://127.0.0.1:7420/'], fp).out).toContain(fp);
    expect(run([], {}, ['http://127.0.0.1:7420/'], fp).out).not.toContain(fp);
    expect(run([], { host: '0.0.0.0', tlsAuto: 'off' }, ['http://192.168.1.5:7420/'], fp).out).not.toContain(fp);
    expect(r.out).toContain(fp);
    expect(r.data[0]).toMatchObject({ tls: true, fingerprint: fp });
    expect(run([], { host: '0.0.0.0' }, ['https://192.168.1.5:7420/']).out).toContain('makes the certificate the next time it starts');
    expect(run([], { host: '0.0.0.0', tlsAuto: 'on', tlsCert: 'c', tlsKey: 'k' }, ['https://x/'], fp).out).not.toContain(fp);
  });

  it('replaces the token on rotate and shows the new links', () => {
    const r = run(['rotate']);
    expect(r.rotated).toBe(1);
    expect(r.out).toContain('#token=' + 'b'.repeat(64));
  });

  it('refuses an unknown subcommand', () => {
    const r = run(['nope']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('augur web rotate');
  });
});


describe('chat credentials CLI', () => {
  it('edits users and devices directly while another database connection is open', async () => {
    const env = makeEnv(), users = new UserStore(join(env.dir, 'chat-users.db'));
    const chats = new ChatStore(join(env.dir, 'chat.db'), diskBlobs(join(env.dir, 'chat-files')));
    let output = '', error = '';
    const io = { out: (s: string) => { output += s; }, err: (s: string) => { error += s; }, stdin: () => '', cwd: env.root, env: { ...process.env, AUGURD_DATA: env.dir, AUGUR_HOME: env.home } };
    const run = async (args: string[]) => { output = ''; error = ''; const code = await main(['web', ...args, '--json'], io); expect(error).toBe(''); expect(code).toBe(0); return JSON.parse(output); };
    try {
      const made = await run(['user', 'add', 'alice', '--name', 'Alice', '--email', 'alice@example.com', '--models', 'a,b', '--tier', 'sensitive', '--daily', '9']);
      expect(users.resolve(made.token)?.user).toMatchObject({ id: 'alice', models: ['a', 'b'], tierCap: 'sensitive', dailyMessages: 9 });
      expect(JSON.stringify(await run(['user', 'list']))).not.toContain(made.token);
      const device = await run(['device', 'add', 'alice', 'Phone']);
      expect(users.resolve(device.token)?.device?.id).toBe(device.device.id);
      expect(await run(['device', 'list', 'alice'])).toHaveLength(1);
      expect(await run(['device', 'list'])).toHaveLength(1);
      await run(['user', 'set', 'alice', '--disable']);
      expect(users.resolve(made.token)).toBeNull();
      await run(['user', 'set', 'alice', '--enable', '--name', 'Alice B', '--email', 'b@example.com', '--models', 'c', '--tier', 'public', '--daily', '3']);
      expect(users.getUser('alice')).toMatchObject({ disabled: false, name: 'Alice B', email: 'b@example.com', models: ['c'], tierCap: 'public', dailyMessages: 3 });
      const rotated = await run(['user', 'token', 'alice']);
      expect(users.resolve(made.token)).toBeNull();
      expect(users.resolve(rotated.token)?.user.id).toBe('alice');
      await run(['device', 'revoke', 'alice', device.device.id]);
      expect(users.resolve(device.token)).toBeNull();
      chats.create({ route: 'c', tier: 'public' }, 'alice');
      await run(['user', 'remove', 'alice', '--purge']);
      expect(chats.list('alice')).toEqual([]);
      expect(users.getUser('alice')).toBeNull();
      await run(['user', 'add', 'bob', '--name', 'Bob']);
      chats.create({ route: 'c', tier: 'public' }, 'bob');
      await run(['user', 'remove', 'bob']);
      expect(chats.list('bob')).toHaveLength(1);
      expect(await main(['web', 'user', 'add', 'bad', '--name', 'Bad', '--daily', '-1'], io)).toBe(2);
      output = '';
      expect(await main(['web', 'user', 'add', 'carol', '--name', 'Carol'], io)).toBe(0);
      expect(output).toContain('Augur will not show it again.');
    } finally { chats.close(); users.close(); env.dispose(); }
  });

  it('lists chat addresses and the fingerprint while the main listener is off', () => {
    const r = run([], { enabled: false, chatPort: 7443, chatHost: '127.0.0.1', tlsAuto: 'on' }, [], 'AB:CD');
    expect(r.out).toContain('https://127.0.0.1:7443/chat/');
    expect(r.out).toContain('AB:CD');
    expect(r.out).not.toContain(TOKEN);
  });
});
