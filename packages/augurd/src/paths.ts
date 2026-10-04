import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the service keeps its store, job folders and token. Windows first; other platforms use the XDG-style default. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUGURD_DATA) return env.AUGURD_DATA;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Augur', 'dispatch');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'augur', 'dispatch');
}

const APP_ID = 'com.neostryder.augur';

/** The window app's settings and data folders (Tauri's app_config_dir and app_data_dir for Augur). AUGUR_APP_DIR puts both in one folder. */
export function appDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): { config: string; data: string } {
  if (env.AUGUR_APP_DIR) return { config: env.AUGUR_APP_DIR, data: env.AUGUR_APP_DIR };
  if (platform === 'win32') { const d = join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_ID); return { config: d, data: d }; }
  if (platform === 'darwin') { const d = join(home, 'Library', 'Application Support', APP_ID); return { config: d, data: d }; }
  return { config: join(env.XDG_CONFIG_HOME ?? join(home, '.config'), APP_ID), data: join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_ID) };
}

/** Augur's own folder, where usage.json and policy.json are written and where the user's routes live. */
export function augurHome(env: NodeJS.ProcessEnv = process.env): string { return env.AUGUR_HOME ?? join(homedir(), '.augur'); }

export function pipeName(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUGURD_PIPE) return env.AUGURD_PIPE;
  if (process.platform === 'win32') return `\\\\.\\pipe\\augurd-${userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return join(dir, 'augurd.sock');
}

/**
 * A script the service starts as its own process (the job runner, the API caller). In the source tree it is the TypeScript file beside the caller;
 * in the packaged service the bundler puts `<name>.mjs` next to the service, and that is used when it exists.
 */
export function scriptPath(callerUrl: string, name: string, sourceRelative = `./${name}.ts`): string {
  const bundled = fileURLToPath(new URL(`./${name}.mjs`, callerUrl));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL(sourceRelative, callerUrl));
}
