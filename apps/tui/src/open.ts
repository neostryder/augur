// Opens a web page in the computer's browser. A machine with no browser set up (a bare terminal install) gets false back, and the app
// shows the address instead so it can be copied.
import { spawn } from 'node:child_process';

export function openUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(false);
  const [cmd, args] = platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
