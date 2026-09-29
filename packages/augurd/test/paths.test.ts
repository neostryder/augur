import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scriptPath } from '../src/paths.js';

describe('scriptPath', () => {
  it('names the TypeScript file in a source tree and the bundled file in a packaged service', () => {
    const dir = mkdtempSync(join(tmpdir(), 'augur-paths-'));
    try {
      const caller = pathToFileURL(join(dir, 'supervisor.js')).href;
      expect(scriptPath(caller, 'runner')).toBe(join(dir, 'runner.ts'));
      writeFileSync(join(dir, 'runner.mjs'), '');
      expect(scriptPath(caller, 'runner')).toBe(join(dir, 'runner.mjs'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
