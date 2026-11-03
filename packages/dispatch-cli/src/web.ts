// `augur web`: where the web app is served and the links that open it. The web app is the same view of the engine the desktop panel is, shown in a
// browser on any device that can reach this computer. It is off until web.enabled is set.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatUserCreate, ChatUserPatch } from '@augur/dispatch-protocol';
import { UserStore, ChatStore, diskBlobs, webAddresses, isLoopbackHost, webTlsMode, type WebSettings } from '@augur/augurd';

export const WEB_HELP = `augur web                               show whether the web app is on, with a link for each address (each link carries the web token)
augur web rotate                        make a new web token; browsers that used the old one ask for the new one
augur web user add <id> --name <name> [--email <e>] [--models a,b,c] [--tier public|internal|sensitive|regulated] [--daily <n>]
augur web user list
augur web user set <id> [--name <name>] [--email <e>] [--models a,b,c] [--tier <tier>] [--daily <n>] [--enable | --disable]
augur web user remove <id> [--purge]
augur web user token <id>
augur web device add <user> <label>
augur web device list [<user>]
augur web device revoke <user> <device-id>`;

export interface WebDeps {
  settings: Pick<WebSettings, 'enabled' | 'host' | 'port' | 'tlsCert' | 'tlsKey' | 'tlsAuto'> & Partial<Pick<WebSettings, 'chatHost' | 'chatPort'>>;
  dir?: string;
  flags?: Map<string, string | true>;
  /** The web token, made on first use. */
  token(): string;
  rotate(): string;
  addresses(): string[];
  /** SHA-256 fingerprint of the self-signed certificate the service made, or null before its first https start. */
  fingerprint?(): string | null;
}

export function webCmd(rest: string[], say: (human: string, data: unknown) => void, deps: WebDeps, err: (text: string) => void): number {
  const [sub] = rest;
  if (sub === 'user' || sub === 'device') return chatUsersCmd(rest, say, deps, err);
  if (sub !== undefined && sub !== 'rotate') { err(`${WEB_HELP}\n`); return 2; }
  if (sub === 'rotate') {
    const token = deps.rotate();
    say(`Augur made a new web token. Every browser that used the old one now asks for the new one.\n${linksOf(deps.addresses(), token).join('\n')}`, { rotated: true, token });
    return 0;
  }
  const { settings } = deps;
  const chat = settings.chatPort ? { host: settings.chatHost ?? '0.0.0.0', port: settings.chatPort, links: webAddresses({ ...settings, host: settings.chatHost ?? '0.0.0.0', port: settings.chatPort }).map(a => `${a}chat/`), fingerprint: webTlsMode({ ...settings, host: settings.chatHost ?? '0.0.0.0' }) !== 'none' ? deps.fingerprint?.() ?? null : null } : null;
  const chatText = chat ? `\nChat listens at ${chat.host}:${chat.port}. Its addresses are:\n${chat.links.join('\n')}${chat.fingerprint ? `\nThe chat certificate fingerprint (SHA-256) is ${chat.fingerprint}.` : ''}` : '';
  if (!settings.enabled) {
    say('The web app is off. Turn it on with "augur config set web.enabled true", then restart the service.' + chatText, { enabled: false, ...(chat ? { chat } : {}) });
    return 0;
  }
  const token = deps.token(), links = linksOf(deps.addresses(), token);
  const mode = webTlsMode(settings), auto = mode === 'auto', secure = mode !== 'none';
  const note = !isLoopbackHost(settings.host) && !secure
    ? '\nThe web app is open to the network over plain http because web.tlsAuto is off, so anyone who can watch the traffic can read the token. Set web.tlsAuto to auto or on to serve https, or set web.tlsCert and web.tlsKey to your own certificate, then restart the service.'
    : '';
  const print = auto ? deps.fingerprint?.() ?? null : null;
  const trust = auto
    ? print
      ? `\nThe certificate is self-signed, so each browser warns about it once. Before you continue past the warning, check that the SHA-256 fingerprint it shows matches this one:\n${print}`
      : '\nThe service makes the certificate the next time it starts. Restart it with augur service stop and augur service start, then run augur web again to see the fingerprint to check.'
    : '';
  say(`The web app is on at ${settings.host}:${settings.port}. Open one of these links in a browser:\n${links.join('\n')}${note}${trust}${chatText}`, { ...(chat ? { chat } : {}), enabled: true, host: settings.host, port: settings.port, tls: secure, links, ...(print ? { fingerprint: print } : {}) });
  return 0;
}

const linksOf = (addresses: string[], token: string): string[] => addresses.map(a => `${a}#token=${token}`);

function chatUsersCmd(rest: string[], say: (human: string, data: unknown) => void, deps: WebDeps, err: (text: string) => void): number {
  if (!deps.dir) { err('The service data folder is unavailable.\n'); return 2; }
  const [kind, action, id, label] = rest, flags = deps.flags ?? new Map<string, string | true>();
  const value = (key: string): string | undefined => { const v = flags.get(key); return typeof v === 'string' ? v : undefined; };
  const need = (v: string | undefined, name: string): string => { if (!v) throw new Error(`The command needs ${name}.`); return v; };
  mkdirSync(deps.dir, { recursive: true });
  const users = new UserStore(join(deps.dir, 'chat-users.db'));
  try {
    const patch: ChatUserPatch = {};
    if (value('name') !== undefined) patch.name = value('name')!;
    if (value('email') !== undefined) patch.email = value('email') || null;
    if (value('models') !== undefined) patch.models = value('models')!.split(',').map(s => s.trim()).filter(Boolean);
    if (value('tier') !== undefined) patch.tierCap = value('tier') as ChatUserPatch['tierCap'];
    if (value('daily') !== undefined) { if (!/^\d+$/.test(value('daily')!)) throw new Error('The daily message limit must be a nonnegative integer.'); patch.dailyMessages = Number(value('daily')); }
    if (flags.has('enable') && flags.has('disable')) throw new Error('The command cannot enable and disable the same user.');
    if (flags.has('enable') || flags.has('disable')) patch.disabled = flags.has('disable');
    const once = (data: { token: string }) => say(`Augur created the token below. Augur will not show it again.\n${data.token}`, data);
    if (kind === 'user') {
      if (action === 'add') { once(users.addUser({ ...patch, id: need(id, 'a user id'), name: need(value('name'), '--name') } as ChatUserCreate)); return 0; }
      if (action === 'list') { const all = users.listUsers(); say(all.map(u => `The user ${u.id} is ${u.disabled ? 'disabled' : 'enabled'} (${u.name}).`).join('\n') || 'Augur has no chat users.', all); return 0; }
      if (action === 'set') { const user = users.updateUser(need(id, 'a user id'), patch); say(`Augur updated the user ${user.id}.`, user); return 0; }
      if (action === 'token') { once(users.rotateUserToken(need(id, 'a user id'))); return 0; }
      if (action === 'remove') {
        const user = need(id, 'a user id');
        if (!users.getUser(user)) throw new Error('The user does not exist.');
        users.updateUser(user, { disabled: true });
        if (flags.has('purge')) {
          const chats = new ChatStore(join(deps.dir, 'chat.db'), diskBlobs(join(deps.dir, 'chat-files')));
          try { for (const chat of chats.list(user)) chats.remove(chat.id, user); } finally { chats.close(); }
        }
        const removed = users.removeUser(user);
        say(`Augur removed the user ${user}.`, { removed }); return 0;
      }
    } else {
      if (action === 'add') { once(users.addDevice(need(id, 'a user id'), need(label, 'a device label'))); return 0; }
      if (action === 'list') {
        const user = id ? users.getUser(id) : null;
        if (id && !user) throw new Error('The user does not exist.');
        const devices = (user ? [user] : users.listUsers()).flatMap(u => u.devices);
        say(devices.map(d => `The device ${d.id} belongs to ${d.user} (${d.label}) and is ${d.revoked ? 'revoked' : 'active'}.`).join('\n') || 'Augur has no chat devices.', devices); return 0;
      }
      if (action === 'revoke') { const revoked = users.revokeDevice(need(id, 'a user id'), need(label, 'a device id')); if (!revoked) throw new Error('The device does not exist.'); say('Augur revoked the device.', { revoked }); return 0; }
    }
    err(`${WEB_HELP}\n`); return 2;
  } catch (e) { err(`${(e as Error).message}\n`); return 2; }
  finally { users.close(); }
}
