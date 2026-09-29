import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/** Where the service keeps its store, job folders and token. Windows first; other platforms use the XDG-style default. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUGURD_DATA) return env.AUGURD_DATA;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Augur', 'dispatch');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'augur', 'dispatch');
}

/** Augur's own folder, where usage.json and policy.json are written and where the user's routes live. */
export function augurHome(env: NodeJS.ProcessEnv = process.env): string { return env.AUGUR_HOME ?? join(homedir(), '.augur'); }

export function pipeName(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUGURD_PIPE) return env.AUGURD_PIPE;
  if (process.platform === 'win32') return `\\\\.\\pipe\\augurd-${userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return join(dir, 'augurd.sock');
}
