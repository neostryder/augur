// Opens a web page in the computer's browser. A machine with no browser set up (a bare terminal install) gets false back, and the app
// shows the address instead so it can be copied.
import { spawn } from 'node:child_process';

/** The program and arguments that open an address. No shell is involved, so no character in the address is syntax. */
export function openCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
}

export function openUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!/^https?:\/\/[^\s"<>\\^`{|}\x00-\x1f]+$/i.test(url)) return Promise.resolve(false);
  const [cmd, args] = openCommand(url, platform);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
