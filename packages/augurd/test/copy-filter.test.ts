import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyFilterWithCaps } from '../src/supervisor.js';

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'augur-copy-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('the working-directory copy for a sandboxed job', () => {
  it('leaves out secrets and build folders and copies the rest', () => {
    const src = tmp(), dst = join(tmp(), 'ws');
    mkdirSync(join(src, 'node_modules'));
    writeFileSync(join(src, 'node_modules', 'x.js'), 'x');
    writeFileSync(join(src, 'a.txt'), 'a');
    writeFileSync(join(src, '.env'), 'KEY=1');
    cpSync(src, dst, { recursive: true, filter: copyFilterWithCaps() });
    expect(existsSync(join(dst, 'a.txt'))).toBe(true);
    expect(existsSync(join(dst, '.env'))).toBe(false);
    expect(existsSync(join(dst, 'node_modules'))).toBe(false);
  });

  it('skips a link back into itself, so a loop cannot form', () => {
    const src = tmp(), dst = join(tmp(), 'ws');
    writeFileSync(join(src, 'a.txt'), 'a');
    try { symlinkSync(src, join(src, 'loop'), 'junction'); } catch { return; }
    cpSync(src, dst, { recursive: true, filter: copyFilterWithCaps() });
    expect(existsSync(join(dst, 'a.txt'))).toBe(true);
    expect(existsSync(join(dst, 'loop'))).toBe(false);
  });

  it('refuses a folder past the file cap with a reason that suggests a smaller one', () => {
    const src = tmp(), dst = join(tmp(), 'ws');
    for (let i = 0; i < 6; i++) writeFileSync(join(src, `f${i}.txt`), '');
    expect(() => cpSync(src, dst, { recursive: true, filter: copyFilterWithCaps(5) })).toThrow(/pass a smaller cwd/);
  });
});
