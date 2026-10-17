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

  it('stores a Jev gateway address, refuses one that is not http or https, and clears it when emptied', () => {
    const dir = fresh();
    expect(setConfigValue(dir, 'decision.gateway', 'http://127.0.0.1:8020')).toEqual({ ok: true, value: 'http://127.0.0.1:8020' });
    expect(loadConfig(dir).decision.gateway).toBe('http://127.0.0.1:8020');
    for (const bad of ['127.0.0.1:8020', 'ftp://host', 'not a url']) expect(setConfigValue(dir, 'decision.gateway', bad), bad).toMatchObject({ ok: false });
    expect(setConfigValue(dir, 'decision.gateway', '')).toMatchObject({ ok: true });
    expect(loadConfig(dir).decision.gateway).toBeUndefined();
  });

  it('refuses a value the loader would quietly replace with its default', () => {
    const dir = fresh();
    for (const [key, value] of [['maxConcurrent', '0'], ['maxConcurrent', '65'], ['maxConcurrent', 'many'], ['retentionDays', '1.5'], ['persistPrompts', 'yes'], ['verifyNamed', 'sometimes'], ['adapters', 'codex-exec,nope'], ['adapters', ''], ['nothing', '1']] as const) {
      expect(setConfigValue(dir, key, value), `${key}=${value}`).toMatchObject({ ok: false });
    }
    expect(configLines(dir).every(l => l.value === l.default)).toBe(true);
  });

  it('stores the charter folder and the ambient choice', () => {
    const dir = fresh();
    expect(configLines(dir).find(l => l.key === 'runner.charterDir')).toMatchObject({ value: '', default: '', kind: 'text' });
    expect(configLines(dir).find(l => l.key === 'runner.ambient')).toMatchObject({ value: 'keep', default: 'keep', kind: 'choice', choices: ['keep', 'trim'] });
    expect(setConfigValue(dir, 'runner.charterDir', 'C:/charter')).toEqual({ ok: true, value: 'C:/charter' });
    expect(setConfigValue(dir, 'runner.ambient', 'trim')).toEqual({ ok: true, value: 'trim' });
    expect(loadConfig(dir).runner).toEqual({ charterDir: 'C:/charter', ambient: 'trim', failover: 'off' });
    expect(setConfigValue(dir, 'runner.ambient', 'loud')).toMatchObject({ ok: false });
    expect(loadConfig(dir).runner.ambient).toBe('trim');
    expect(setConfigValue(dir, 'runner.charterDir', '  ')).toEqual({ ok: true, value: '' });
    expect(loadConfig(dir).runner.charterDir).toBe('');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ runner: { ambient: 'nope', charterDir: 4 }, retentionDays: 9 }));
    expect(loadConfig(dir).runner).toEqual({ charterDir: '', ambient: 'keep', failover: 'off' });
    expect(loadConfig(dir).retentionDays).toBe(9);
  });

  it('stores whether a failed job is retried on a fallback route', () => {
    const dir = fresh();
    expect(configLines(dir).find(l => l.key === 'runner.failover')).toMatchObject({ value: 'off', default: 'off', kind: 'choice', choices: ['off', 'on'] });
    expect(setConfigValue(dir, 'runner.failover', 'on')).toEqual({ ok: true, value: 'on' });
    expect(loadConfig(dir).runner.failover).toBe('on');
    expect(setConfigValue(dir, 'runner.failover', 'sometimes')).toMatchObject({ ok: false });
    expect(loadConfig(dir).runner.failover).toBe('on');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ runner: { failover: 'yes', ambient: 'trim' } }));
    expect(loadConfig(dir).runner).toEqual({ charterDir: '', ambient: 'trim', failover: 'off' });
  });

  it('takes a list of adapters once each', () => {
    const dir = fresh();
    expect(setConfigValue(dir, 'adapters', 'codex-exec, grok-exec,codex-exec')).toEqual({ ok: true, value: 'codex-exec,grok-exec' });
  });
});
