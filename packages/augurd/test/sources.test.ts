import { describe, expect, it } from 'vitest';
import { validPolicyFile } from '../src/sources.js';

const model = { id: 'gpt-6-sol', status: 'confirmed', activities: { write_code: 'often' }, dataTier: 'sensitive', askFirst: false, output: 'write_files', sandbox: false, pause: null };
const file = (m: unknown = model) => ({ schema: 1, providers: { codex: { thresholds: { warnPct: 90, denyPct: 98, minBalance: null }, models: { 'codex/sol': m } } } });

describe('policy.json validation', () => {
  it('accepts a well-formed file', () => expect(validPolicyFile(file())).toBe(true));
  it('rejects the whole file when one model is malformed', () => {
    expect(validPolicyFile(file({ ...model, dataTier: 'secret' }))).toBe(false);
    expect(validPolicyFile(file({ ...model, askFirst: 'no' }))).toBe(false);
    expect(validPolicyFile(file({ ...model, activities: undefined }))).toBe(false);
    expect(validPolicyFile(file({ ...model, pause: { weights: null } }))).toBe(false);
    expect(validPolicyFile({ schema: 2, providers: {} })).toBe(false);
  });
});
