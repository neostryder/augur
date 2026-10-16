// `augur login`: Augur's own sign-in to Claude and Codex, for a computer where the provider's CLI is not signed in, or has no browser to sign in with.
// The link opens in any browser on any device. Claude then shows a code to paste back here; Codex shows a code to type there, and this command waits.
import type { LoginStart } from '@augur/core';
import { EXIT_CODES } from '@augur/dispatch-protocol';

export const LOGIN_HELP = `augur login <claude|codex> [--stdin]    sign Augur in to a provider with a session of its own; open the link on any device. Claude: paste the code the page gives you (typing is hidden, or use --stdin). Codex: enter the code shown here on the page, and this command waits
augur login status                      which login Augur uses for each provider: its own, the provider CLI's, or none
augur logout <claude|codex>             remove the session Augur holds; the provider CLI's login is left alone`;

export interface LoginIo {
  err(text: string): void;
  stdin(): string;
  interactive?: boolean;
  readSecret?(prompt: string): Promise<string>;
}

export interface LoginDeps {
  call(method: string, args: unknown[]): Promise<unknown>;
  sleep(ms: number): Promise<unknown>;
  now(): number;
}

const PROVIDERS = ['claude', 'codex'];
const NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const SOURCE: Record<string, string> = { own: 'signed in through Augur', cli: "using the provider CLI's login" };

export async function loginCmd(rest: string[], flags: { stdin: boolean }, io: LoginIo, say: (human: string, data: unknown) => void, deps: LoginDeps, logout = false): Promise<number> {
  const [first] = rest;
  if (!logout && first === 'status') {
    const status = await deps.call('signInStatus', []) as Record<string, 'own' | 'cli' | null>;
    say(PROVIDERS.map(p => `${NAME[p]}: ${status[p] ? SOURCE[status[p] as string] : 'not signed in'}`).join('\n'), status);
    return EXIT_CODES.completed;
  }
  if (!first || !PROVIDERS.includes(first)) { io.err(`${LOGIN_HELP}\n`); return EXIT_CODES.usage; }
  if (logout) {
    await deps.call('signOut', [first]);
    say(`${NAME[first]}: Augur removed its own session. The provider CLI's login is unchanged.`, { provider: first, signedIn: false });
    return EXIT_CODES.completed;
  }
  const start = await deps.call('signInBegin', [first]) as LoginStart;
  const minutes = Math.round(start.expiresInS / 60);
  if (start.mode === 'paste') {
    // The link goes to the error stream so a pipe can still carry the code in on standard input.
    io.err(`Open this link in a browser on any device and sign in to ${NAME[first]}. The link works for ${minutes} minutes:\n\n${start.url}\n\n`);
    let code: string;
    if (flags.stdin) code = io.stdin().trim();
    else if (io.interactive && io.readSecret) code = (await io.readSecret('Paste the code the page shows (typing is hidden): ')).trim();
    else { io.err('There is no terminal here to type the code into. Run this in a terminal, or pass the code on standard input with --stdin.\n'); return EXIT_CODES.usage; }
    await deps.call('signInComplete', [start.id, code]);
  } else {
    io.err(`Open ${start.url} in a browser on any device and enter this code within ${minutes} minutes:\n\n${start.code}\n\nWaiting for you to approve it...\n`);
    const until = deps.now() + start.expiresInS * 1000;
    for (;;) {
      if ((await deps.call('signInComplete', [start.id]) as { done: boolean }).done) break;
      if (deps.now() > until) { io.err('The code expired before it was approved. Run augur login codex again.\n'); return EXIT_CODES.failed; }
      await deps.sleep(5000);
    }
  }
  say(`${NAME[first]}: Augur is signed in with its own session and no longer reads the provider CLI's login.`, { provider: first, signedIn: true });
  return EXIT_CODES.completed;
}
