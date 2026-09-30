import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_KEYS, configLines, loadConfig, setConfigValue } from '../src/index.js';

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'augur-config-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('config editing', () => {
  it('lists every setting with its default before anything is written', () => {
    const lines = configLines(fresh());
    expect(lines.map(l => l.key)).toEqual(CONFIG_KEYS.map(k => k.key));
    expect(lines.every(l => l.value === l.default)).toBe(true);
    expect(lines.find(l => l.key === 'requirePick')).toMatchObject({ value: 'true', weakens: true });
  });

  it('stores a value where the loader reads it, keeping every other key', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ retentionDays: 7, decision: { backend: 'laya', servers: [{ name: 'a', url: 'http://127.0.0.1:8010' }] }, somethingElse: 1 }));
    expect(setConfigValue(dir, 'maxConcurrent', '3')).toEqual({ ok: true, value: '3' });
    expect(setConfigValue(dir, 'decision.shadow', 'jev')).toEqual({ ok: true, value: 'jev' });
    expect(setConfigValue(dir, 'learn.recordTasks', 'true')).toEqual({ ok: true, value: 'true' });
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ retentionDays: 7, somethingElse: 1, maxConcurrent: 3, decision: { backend: 'laya', shadow: 'jev', servers: [{ name: 'a' }] }, learn: { recordTasks: true } });
    expect(loadConfig(dir)).toMatchObject({ maxConcurrent: 3, retentionDays: 7, decision: { backend: 'laya', shadow: 'jev' } });
  });

  it('turns a shadow classifier off by writing none', () => {
    const dir = fresh();
    setConfigValue(dir, 'decision.shadow', 'jev');
    expect(setConfigValue(dir, 'decision.shadow', 'none')).toEqual({ ok: true, value: 'none' });
    expect(loadConfig(dir).decision.shadow).toBeNull();
  });

  it('refuses a value the loader would quietly replace with its default', () => {
    const dir = fresh();
    for (const [key, value] of [['maxConcurrent', '0'], ['maxConcurrent', '65'], ['maxConcurrent', 'many'], ['retentionDays', '1.5'], ['persistPrompts', 'yes'], ['verifyNamed', 'sometimes'], ['adapters', 'codex-exec,nope'], ['adapters', ''], ['nothing', '1']] as const) {
      expect(setConfigValue(dir, key, value), `${key}=${value}`).toMatchObject({ ok: false });
    }
    expect(configLines(dir).every(l => l.value === l.default)).toBe(true);
  });

  it('takes a list of adapters once each', () => {
    const dir = fresh();
    expect(setConfigValue(dir, 'adapters', 'codex-exec, grok-exec,codex-exec')).toEqual({ ok: true, value: 'codex-exec,grok-exec' });
  });
});
