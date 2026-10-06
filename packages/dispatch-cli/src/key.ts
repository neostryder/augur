// `augur key`: puts an API key in the key store without it ever passing through a chat, a command line or a file in the project.
// The value comes from a hidden prompt, from an environment variable the person set in their own shell, or from standard input. It is never printed.
import { appDirs, createKeyStore, checkSecretName } from '@augur/augurd';
import type { KeyStore } from '@augur/augurd';
import { EXIT_CODES, routeSecretName } from '@augur/dispatch-protocol';

export interface KeyIo {
  err(text: string): void;
  stdin(): string;
  env: NodeJS.ProcessEnv;
  interactive?: boolean;
  /** Reads one line with no echo. Left out when no person can type, such as under an agent. */
  readSecret?(prompt: string): Promise<string>;
}

const ROUTE = /^[a-z][a-z0-9_-]*$/;

/** A route name stands for that route's key. A `provider.field` name is a provider's own key, as the settings page saves it. */
export function secretNameFor(name: string): string {
  if (name.includes('.')) { checkSecretName(name); return name; }
  if (!ROUTE.test(name)) throw new Error(`"${name}" is not a route name: it starts with a lowercase letter and holds lowercase letters, digits, - and _`);
  return routeSecretName(name);
}

const KINDS: Record<string, string> = { windows: 'the Windows credential store', keychain: 'the macOS keychain', 'secret-service': 'the Secret Service', file: 'a file only this user can read' };

export const KEY_HELP = `augur key set <route|provider.field> [--env <NAME>|--stdin]    store a key; a hidden prompt at a terminal, or the named environment variable, or standard input
augur key status <route|provider.field>    whether a key is stored, never the key itself
augur key remove <route|provider.field>    delete the stored key`;

export async function keyCmd(rest: string[], flags: { env?: string; stdin: boolean }, io: KeyIo, say: (human: string, data: unknown) => void, store?: KeyStore): Promise<number> {
  const [action, name, extra] = rest;
  if (action !== 'set' && action !== 'status' && action !== 'remove') { io.err(`${KEY_HELP}\n`); return EXIT_CODES.usage; }
  if (!name) { io.err(`augur key ${action} needs a route name or a provider.field name\n`); return EXIT_CODES.usage; }
  // A key typed after the name would sit in shell history and in any chat the command came from, so it is refused outright.
  if (extra !== undefined) { io.err('A key is never given on the command line. Use the hidden prompt, --env <NAME> or --stdin.\n'); return EXIT_CODES.usage; }
  let secret: string;
  try { secret = secretNameFor(name); } catch (e) { io.err(`${(e as Error).message}\n`); return EXIT_CODES.usage; }
  const keys = store ?? createKeyStore({ dir: appDirs(io.env).config, ...(io.env.AUGUR_KEYSTORE === 'file' ? { kind: 'file' as const } : {}) });
  try {
    if (action === 'status') { const has = await keys.has(secret); say(`${name}: ${has ? 'a key is stored' : 'no key is stored'}.`, { name, secret, stored: has }); return has ? EXIT_CODES.completed : EXIT_CODES.rejected; }
    if (action === 'remove') { await keys.delete(secret); say(`${name}: the stored key was removed.`, { name, secret, stored: false }); return EXIT_CODES.completed; }
    const value = await readValue(flags, io, name);
    if (typeof value !== 'string') { io.err(`${value.error}\n`); return EXIT_CODES.usage; }
    await keys.set(secret, value);
    say(`${name}: a key of ${value.length} characters is stored in ${KINDS[keys.kind] ?? keys.kind}. Run augur test ${name.includes('.') ? '<route>' : name} to check it works.`, { name, secret, stored: true, length: value.length, store: keys.kind });
    return EXIT_CODES.completed;
  } catch (e) { io.err(`${(e as Error).message}\n`); return EXIT_CODES.failed; }
}

async function readValue(flags: { env?: string; stdin: boolean }, io: KeyIo, name: string): Promise<string | { error: string }> {
  let raw: string | undefined;
  if (flags.env) {
    raw = io.env[flags.env];
    if (!raw) return { error: `The environment variable ${flags.env} is not set here. Set it in your own terminal first, then run this again.` };
  } else if (flags.stdin) raw = io.stdin();
  else if (io.interactive && io.readSecret) raw = await io.readSecret(`Key for ${name} (typing is hidden): `);
  else return { error: 'No terminal is attached to type a key into. Run this in your own terminal, or put the key in an environment variable and pass --env <NAME>, or pipe it with --stdin.' };
  const value = (raw ?? '').replace(/^﻿/, '').trim();
  if (!value) return { error: 'The key was empty, so nothing was stored.' };
  if (/[\r\n]/.test(value)) return { error: 'A key is one line. Nothing was stored.' };
  return value;
}

/** Reads a line from the terminal with no echo. Ctrl-C cancels, Backspace deletes. */
export function readSecretFromTerminal(prompt: string, input: NodeJS.ReadStream = process.stdin, out: NodeJS.WriteStream = process.stderr): Promise<string> {
  return new Promise((resolve, reject) => {
    out.write(prompt);
    let value = '';
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (fn: () => void) => { input.setRawMode?.(false); input.pause(); input.off('data', onData); out.write('\n'); fn(); };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('Cancelled. Nothing was stored.')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}
