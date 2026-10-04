// Starts the service when the user logs in: a systemd user unit on Linux, a launch agent on macOS. On Windows the Augur app starts the service, and
// the app itself starts at login from its Settings. The entry runs the packaged runtime on the packaged service file, with the PATH of the shell
// that enabled it, so harness commands installed under the home folder are found.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWrite } from './home-files.js';
import { runHelper } from './keystore.js';

export const UNIT_NAME = 'augurd.service';
export const AGENT_LABEL = 'com.neostryder.augurd';

export interface LoginTarget { node: string; script: string; path: string }
export interface LoginOptions { platform?: NodeJS.Platform; home?: string; uid?: number; run?: typeof runHelper }
export interface LoginState { supported: boolean; enabled: boolean; file: string | null; how: string }

/** systemd reads % as a specifier and $ as a variable in ExecStart, so both are doubled; a quoted word keeps its spaces. */
const unitWord = (s: string) => `"${s.replace(/%/g, '%%').replace(/\$/g, '$$$$').replace(/(["\\])/g, '\\$1')}"`;

export function systemdUnit(t: LoginTarget): string {
  return [
    '[Unit]',
    'Description=Augur background service: usage readings, alerts and jobs',
    '',
    '[Service]',
    `ExecStart=${unitWord(t.node)} ${unitWord(t.script)}`,
    `Environment=${unitWord(`PATH=${t.path}`)}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** launchd restarts the agent after a crash only, so `augur service stop` leaves it stopped until the next login. */
export function launchAgent(t: LoginTarget): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(t.node)}</string><string>${xml(t.script)}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(t.path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function entryFile(platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'linux') return join(home, '.config', 'systemd', 'user', UNIT_NAME);
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
  return null;
}

export function loginState(opts: LoginOptions = {}): LoginState {
  const platform = opts.platform ?? process.platform, file = entryFile(platform, opts.home ?? homedir());
  if (!file) return { supported: false, enabled: false, file: null, how: 'On Windows, the Augur app starts the service. Its Settings page has Start at login for the app.' };
  // A systemd unit starts at login only once it is enabled, which links it into default.target.wants; a launch agent loads by being in the folder.
  const enabled = existsSync(file) && (platform !== 'linux' || existsSync(wantsLink(file)));
  return { supported: true, enabled, file, how: platform === 'linux' ? 'a systemd user unit' : 'a launch agent' };
}

const wantsLink = (unitFile: string) => join(dirname(unitFile), 'default.target.wants', UNIT_NAME);

/** Writes the entry and starts it now. A failure names the step that failed. A unit systemd would not enable is removed again; a launch agent stays, as launchd loads it at the next login. */
export async function enableLogin(t: LoginTarget, opts: LoginOptions = {}): Promise<{ ok: boolean; message: string; file: string | null }> {
  const platform = opts.platform ?? process.platform, run = opts.run ?? runHelper, file = entryFile(platform, opts.home ?? homedir());
  if (!file) return { ok: false, message: loginState(opts).how, file: null };
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, platform === 'linux' ? systemdUnit(t) : launchAgent(t));
  if (platform === 'linux') {
    const why = (r: { code: number; stderr: string }) => r.stderr.trim() || `exit ${r.code}`;
    const reload = await run('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0) { rmSync(file, { force: true }); return { ok: false, file: null, message: `Could not reach systemd for this user (${why(reload)}). Nothing was changed.` }; }
    const on = await run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
    if (on.code === 0) return { ok: true, file, message: 'The service is running, and it starts each time you log in.' };
    if (existsSync(wantsLink(file))) return { ok: false, file, message: `Login start is set up, but the service could not start right now: ${why(on)}` };
    rmSync(file, { force: true });
    return { ok: false, file: null, message: `systemd refused to enable ${UNIT_NAME} (${why(on)}). Nothing was changed.` };
  }
  const domain = `gui/${opts.uid ?? process.getuid?.() ?? 0}`;
  await run('launchctl', ['bootout', `${domain}/${AGENT_LABEL}`]);
  const on = await run('launchctl', ['bootstrap', domain, file]);
  return on.code === 0 ? { ok: true, file, message: 'The service is running, and it starts each time you log in.' }
    : { ok: false, file, message: `The launch agent file is in place, but launchctl could not load it (${on.stderr.trim() || `exit ${on.code}`}). It loads at your next login.` };
}

/** Removes the entry. The running service is stopped with it, as the entry is what keeps it running. */
export async function disableLogin(opts: LoginOptions = {}): Promise<{ ok: boolean; message: string }> {
  const platform = opts.platform ?? process.platform, run = opts.run ?? runHelper, file = entryFile(platform, opts.home ?? homedir());
  if (!file) return { ok: false, message: loginState(opts).how };
  if (platform === 'linux') {
    await run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
    rmSync(file, { force: true });
    await run('systemctl', ['--user', 'daemon-reload']);
  } else {
    await run('launchctl', ['bootout', `gui/${opts.uid ?? process.getuid?.() ?? 0}/${AGENT_LABEL}`]);
    rmSync(file, { force: true });
  }
  return { ok: true, message: 'The service no longer starts when you log in.' };
}

/** Starts the service through its login entry, so systemd or launchd owns the process. False when there is no entry or the manager refused. */
export async function startViaLogin(opts: LoginOptions = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform, run = opts.run ?? runHelper, state = loginState(opts);
  if (!state.enabled) return false;
  const r = platform === 'linux' ? await run('systemctl', ['--user', 'start', UNIT_NAME])
    : await run('launchctl', ['kickstart', `gui/${opts.uid ?? process.getuid?.() ?? 0}/${AGENT_LABEL}`]);
  return r.code === 0;
}
