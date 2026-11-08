import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionTitles, cleanTitle, desktopSessionsRoot } from '../src/session-titles.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function store() {
  const root = mkdtempSync(join(tmpdir(), 'augur-sessions-')); dirs.push(root);
  const folder = join(root, 'org', 'account'); mkdirSync(folder, { recursive: true });
  const put = (name: string, body: object, mtime?: number) => { const file = join(folder, name); writeFileSync(file, JSON.stringify(body)); if (mtime) utimesSync(file, mtime, mtime); };
  return { root, folder, put };
}

describe('session titles from the desktop app', () => {
  it('strips a leading status emoji and keeps the words', () => {
    expect(cleanTitle('\u2699\uFE0F Augur')).toBe('Augur');
    expect(cleanTitle('  \uD83D\uDE4B  GCU BIT-200 ')).toBe('GCU BIT-200');
    expect(cleanTitle('\uD83E\uDDF5')).toBeUndefined();
    expect(cleanTitle(7)).toBeUndefined();
  });

  it('finds a title by the current or an earlier CLI session id and ignores other files', () => {
    const s = store(); const now = 1000;
    s.put('local_a.json', { cliSessionId: 'cli-a', priorCliSessionIds: ['old-a'], title: '\u2699\uFE0F Augur' });
    s.put('notes.json', { cliSessionId: 'cli-n', title: 'Skip' });
    const titles = new SessionTitles(s.root, () => now);
    expect(titles.lookup('cli-a')).toBe('Augur');
    expect(titles.lookup('old-a')).toBe('Augur');
    expect(titles.lookup('cli-n')).toBeUndefined();
    expect(titles.lookup(undefined)).toBeUndefined();
  });

  it('rescans after the interval and picks up a changed title', () => {
    const s = store(); let now = 1000;
    s.put('local_a.json', { cliSessionId: 'cli-a', title: 'One' }, 100);
    const titles = new SessionTitles(s.root, () => now, 30000);
    expect(titles.lookup('cli-a')).toBe('One');
    s.put('local_a.json', { cliSessionId: 'cli-a', title: 'Two' }, 200);
    now += 29999; expect(titles.lookup('cli-a')).toBe('One');
    now += 1; expect(titles.lookup('cli-a')).toBe('Two');
  });

  it('reads a missing folder or a broken file as no title', () => {
    const s = store();
    expect(new SessionTitles(join(s.root, 'absent')).lookup('x')).toBeUndefined();
    writeFileSync(join(s.folder, 'local_bad.json'), '{');
    expect(new SessionTitles(s.root).lookup('x')).toBeUndefined();
  });

  it('puts the session folder where each platform keeps it', () => {
    expect(desktopSessionsRoot({ APPDATA: 'C:/Users/me/AppData/Roaming' }, 'win32', 'C:/Users/me').replace(/\\/g, '/')).toBe('C:/Users/me/AppData/Roaming/Claude/claude-code-sessions');
    expect(desktopSessionsRoot({}, 'darwin', '/Users/me').replace(/\\/g, '/')).toBe('/Users/me/Library/Application Support/Claude/claude-code-sessions');
    expect(desktopSessionsRoot({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/me').replace(/\\/g, '/')).toBe('/cfg/Claude/claude-code-sessions');
  });
});
