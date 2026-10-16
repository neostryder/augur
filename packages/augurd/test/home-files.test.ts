import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWrite, isCredentialFile } from '../src/home-files.js';

describe('login files', () => {
  it('name the three token files and nothing else', () => {
    for (const f of ['.claude/.credentials.json', '.codex/auth.json', '.grok/auth.json']) expect(isCredentialFile(f)).toBe(true);
    for (const f of ['.codex/models_cache.json', 'policy.json', '.codex/auth.json.bak']) expect(isCredentialFile(f)).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('are rewritten readable by their owner only, even over a file that was open to others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'augur-home-'));
    try {
      const file = join(dir, 'new', 'auth.json');
      atomicWrite(file, '{}', 0o600);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'new')).mode & 0o777).toBe(0o700);
      chmodSync(file, 0o644);
      atomicWrite(file, '{"a":1}', 0o600);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
