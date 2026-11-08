import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';

it('verifyNamed defaults to off and preserves an explicit enforce value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'augur-config-'));
  try {
    expect(DEFAULT_CONFIG.verifyNamed).toBe('off');
    expect(loadConfig(dir).verifyNamed).toBe('off');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ verifyNamed: 'enforce' }));
    expect(loadConfig(dir).verifyNamed).toBe('enforce');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
