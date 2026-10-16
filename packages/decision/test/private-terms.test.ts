import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { termRegex } from '@augur/core';
import { STUDENT_RE, privateTerms } from '../src/index.js';

describe('private terms', () => {
  let dir = '', was: string | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'augur-terms-')); was = process.env.AUGUR_HOME; process.env.AUGUR_HOME = dir; });
  afterEach(() => { if (was === undefined) delete process.env.AUGUR_HOME; else process.env.AUGUR_HOME = was; rmSync(dir, { recursive: true, force: true }); });

  it('match everyday words with no file, and nothing named by a school', () => {
    expect(privateTerms()).toEqual([]);
    expect(STUDENT_RE.test('grade the rubric for the roster')).toBe(true);
    expect(STUDENT_RE.test('plan the Orion release of the ACME-101 reader')).toBe(false);
  });

  it('add the terms in private-terms.json, with the hyphen optional, and drop them when the file goes', () => {
    writeFileSync(join(dir, 'private-terms.json'), JSON.stringify({ terms: ['orion', 'acme-101', 'x.y'] }));
    expect(privateTerms()).toEqual(['orion', 'acme-101', 'x.y']);
    expect(STUDENT_RE.test('the Orion release')).toBe(true);
    expect(STUDENT_RE.test('ACME101 notes')).toBe(true);
    expect(STUDENT_RE.test('xzy')).toBe(false);
    expect(STUDENT_RE.test('x.y')).toBe(true);
    rmSync(join(dir, 'private-terms.json'));
    expect(STUDENT_RE.test('the Orion release')).toBe(false);
  });

  it('ignore a broken file and entries of the wrong type', () => {
    writeFileSync(join(dir, 'private-terms.json'), '{ not json');
    expect(privateTerms()).toEqual([]);
    writeFileSync(join(dir, 'private-terms.json'), JSON.stringify({ terms: ['ok', 3, '', null] }));
    expect(privateTerms()).toEqual(['ok']);
  });

  it('build a whole-word matcher', () => {
    const re = termRegex('students?', ['acme-200']);
    expect(re.test('a student')).toBe(true);
    expect(re.test('ACME200')).toBe(true);
    expect(re.test('acme-2000')).toBe(false);
  });
});
