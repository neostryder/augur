import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureToken } from '../src/ipc.js';

describe('token file access', () => {
  it('is limited to the owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'augurd-token-'));
    try {
      const token = ensureToken(dir), path = join(dir, 'token');
      expect(token).toHaveLength(64);
      if (process.platform === 'win32') {
        const acl = execFileSync('icacls', [path], { encoding: 'utf8', windowsHide: true });
        const entries = acl.split(/\r?\n/).filter(l => /:\(/.test(l));
        // A session that runs elevated also gets SYSTEM and Administrators on files it creates. Those can read the file anyway, so only any other principal counts as a leak.
        const names = entries.map(l => l.replace(/^.*?(?:\\token\s+|^\s+)/i, '').replace(/:\(.*$/, '').trim().toLowerCase());
        expect(names.some(n => n.endsWith(userInfo().username.toLowerCase()))).toBe(true);
        expect(names.filter(n => !n.endsWith(userInfo().username.toLowerCase()) && n !== 'nt authority\\system' && n !== 'builtin\\administrators')).toEqual([]);
      } else {
        expect(statSync(path).mode & 0o077).toBe(0);
      }
      expect(ensureToken(dir)).toBe(token);
      const agent = ensureToken(dir, 'agent-token');
      expect(agent).toHaveLength(64);
      expect(agent).not.toBe(token);
      if (process.platform !== 'win32') expect(statSync(join(dir, 'agent-token')).mode & 0o077).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
