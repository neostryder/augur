import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_LABEL, UNIT_NAME, disableLogin, enableLogin, launchAgent, loginState, startViaLogin, systemdUnit } from '../src/login.js';

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), 'augur-login-')); homes.push(h); return h; };
const target = { node: '/opt/Augur Folder/service/augur-node', script: '/opt/Augur Folder/service/augurd.mjs', path: '/home/n/.local/bin:/usr/bin:/odd$dir%x' };
/** Stands in for systemctl and launchctl. `systemctl --user enable` links the unit as systemd does, so the state reads as enabled. */
const recorder = (code = 0, h = '') => {
  const calls: string[] = [];
  return { calls, run: async (command: string, args: string[]) => {
    calls.push([command, ...args].join(' '));
    if (code === 0 && command === 'systemctl' && args[1] === 'enable') {
      const wants = join(h, '.config', 'systemd', 'user', 'default.target.wants');
      mkdirSync(wants, { recursive: true }); writeFileSync(join(wants, UNIT_NAME), '');
    }
    return { code, stdout: '', stderr: code ? 'no bus' : '' };
  } };
};

describe('starting the service at login', () => {
  it('writes a systemd unit that quotes paths with spaces and escapes specifiers and variables', () => {
    const unit = systemdUnit(target);
    expect(unit).toContain('ExecStart="/opt/Augur Folder/service/augur-node" "/opt/Augur Folder/service/augurd.mjs"');
    expect(unit).toContain('Environment="PATH=/home/n/.local/bin:/usr/bin:/odd$$dir%%x"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('writes a launch agent with escaped values that restarts only after a crash', () => {
    const plist = launchAgent({ ...target, path: '/usr/bin:/a&b' });
    expect(plist).toContain(`<key>Label</key><string>${AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/Augur Folder/service/augur-node</string><string>/opt/Augur Folder/service/augurd.mjs</string>');
    expect(plist).toContain('<string>/usr/bin:/a&amp;b</string>');
    expect(plist).toContain('<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>');
  });

  it('on Linux writes the unit, enables it with systemctl --user, and removes it again', async () => {
    const h = home(), r = recorder(0, h), opts = { platform: 'linux' as const, home: h, run: r.run };
    expect(loginState(opts)).toMatchObject({ supported: true, enabled: false });
    expect(await enableLogin(target, opts)).toMatchObject({ ok: true });
    const file = join(h, '.config', 'systemd', 'user', UNIT_NAME);
    expect(readFileSync(file, 'utf8')).toContain('augurd.mjs');
    expect(r.calls).toEqual(['systemctl --user daemon-reload', `systemctl --user enable --now ${UNIT_NAME}`]);
    expect(loginState(opts).enabled).toBe(true);
    expect(await startViaLogin(opts)).toBe(true);
    expect(r.calls.at(-1)).toBe(`systemctl --user start ${UNIT_NAME}`);
    expect(await disableLogin(opts)).toMatchObject({ ok: true });
    expect(existsSync(file)).toBe(false);
    expect(r.calls).toContain(`systemctl --user disable --now ${UNIT_NAME}`);
  });

  it('removes the unit and says why when systemd does not answer, so status never claims a login start', async () => {
    const h = home(), r = recorder(1, h), opts = { platform: 'linux' as const, home: h, run: r.run };
    const result = await enableLogin(target, opts);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('no bus') });
    expect(existsSync(join(h, '.config', 'systemd', 'user', UNIT_NAME))).toBe(false);
    expect(loginState(opts).enabled).toBe(false);
  });

  it('on macOS loads the agent into the user session with launchctl, replacing any loaded copy', async () => {
    const h = home(), r = recorder(), opts = { platform: 'darwin' as const, home: h, uid: 501, run: r.run };
    expect(await enableLogin(target, opts)).toMatchObject({ ok: true });
    const file = join(h, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
    expect(existsSync(file)).toBe(true);
    expect(r.calls).toEqual([`launchctl bootout gui/501/${AGENT_LABEL}`, `launchctl bootstrap gui/501 ${file}`]);
    expect(await startViaLogin(opts)).toBe(true);
    expect(r.calls.at(-1)).toBe(`launchctl kickstart gui/501/${AGENT_LABEL}`);
    await disableLogin(opts);
    expect(existsSync(file)).toBe(false);
  });

  it('on Windows leaves login start to the app', async () => {
    const r = recorder(), opts = { platform: 'win32' as const, home: home(), run: r.run };
    expect(loginState(opts)).toMatchObject({ supported: false, enabled: false });
    expect(await enableLogin(target, opts)).toMatchObject({ ok: false, message: expect.stringContaining('Start at login') });
    expect(await startViaLogin(opts)).toBe(false);
    expect(r.calls).toEqual([]);
  });
});
