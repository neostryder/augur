import { describe, expect, it } from 'vitest';
import { MAX_SCHEMA_BYTES, schemaPrompt, validateRunOptions, validateSchemaAnswer } from '../src/run-options.js';

const schema = { type: 'object', properties: { count: { type: 'integer' }, tags: { type: 'array', items: { type: 'string', enum: ['yes', 'no'] } } }, required: ['count', 'tags'] };

describe('per-call option validation', () => {
  it('accepts short effort tokens and refuses other values', () => {
    for (const effort of ['low', 'xhigh', 'custom-2', 'x'.repeat(16)]) expect(validateRunOptions({ effort })).toBeNull();
    for (const effort of ['', 'x'.repeat(17), 'high_low', 'high;exit', 'high\n', 1, null]) expect(validateRunOptions({ effort })).toContain('effort');
  });

  it('accepts schema objects up to the byte cap', () => {
    expect(validateRunOptions({})).toBeNull();
    expect(validateRunOptions({ schema })).toBeNull();
    const exact = { description: 'x'.repeat(MAX_SCHEMA_BYTES - JSON.stringify({ description: '' }).length) };
    expect(validateRunOptions({ schema: exact })).toBeNull();
    expect(validateRunOptions({ schema: { ...exact, description: exact.description + 'x' } })).toContain('64 KB');
    expect(validateRunOptions({ schema: { description: '\u00e9'.repeat(40000) } })).toContain('64 KB');
    for (const value of [[], null, 'schema.json', 42, true]) expect(validateRunOptions({ schema: value })).toContain('JSON object');
  });
});

describe('schema prompts', () => {
  it('appends instructions for a fallback adapter and leaves native prompts alone', () => {
    const prompt = schemaPrompt('task', schema, 'exec');
    expect(prompt).toContain('task\n\nReply with only a JSON document matching this JSON Schema.');
    expect(prompt.endsWith(JSON.stringify(schema))).toBe(true);
    expect(schemaPrompt('task', schema, 'codex-exec')).toBe('task');
    expect(schemaPrompt('task', schema, 'grok-exec')).toBe('task');
    expect(schemaPrompt('task', undefined, 'exec')).toBe('task');
  });
});

describe('schema answers', () => {
  it('accepts valid JSON matching the common subset', () => {
    const answer = JSON.stringify({ count: 2, tags: ['yes'] });
    expect(validateSchemaAnswer(answer, schema)).toEqual({ answer });
    expect(validateSchemaAnswer('null', { type: ['string', 'null'] }).warning).toBeUndefined();
    expect(validateSchemaAnswer('true', { type: 'boolean' }).warning).toBeUndefined();
    expect(validateSchemaAnswer('1.5', { type: 'number' }).warning).toBeUndefined();
    expect(validateSchemaAnswer('{"b":2,"a":1}', { enum: [{ a: 1, b: 2 }] }).warning).toBeUndefined();
  });

  it('warns on type, required, items and enum mismatches', () => {
    for (const answer of ['[]', '{}', '{"count":1.5,"tags":[]}', '{"count":1,"tags":[2]}', '{"count":1,"tags":["maybe"]}']) expect(validateSchemaAnswer(answer, schema).warning).toMatch(/^schema:/);
    expect(validateSchemaAnswer('null', { type: 'object' }).warning).toContain('wrong type');
    expect(validateSchemaAnswer('1', { enum: ['1'] }).warning).toContain('enum');
    expect(validateSchemaAnswer('{}', { required: ['toString'] }).warning).toContain('required');
  });

  it('strips one surrounding fence and retries parsing once', () => {
    const fence = String.fromCharCode(96).repeat(3), answer = '{"count":2,"tags":["no"]}';
    expect(validateSchemaAnswer(fence + 'json\n' + answer + '\n' + fence, schema)).toEqual({ answer });
    expect(validateSchemaAnswer(fence + '\r\n' + answer + '\r\n' + fence, schema)).toEqual({ answer });
    for (const invalid of ['bad', fence + 'json\n{\n' + fence, 'preface\n' + fence + '\n' + answer + '\n' + fence, fence + '\n' + fence + '\n' + answer + '\n' + fence + '\n' + fence]) expect(validateSchemaAnswer(invalid, schema).warning).toMatch(/^schema:/);
  });
});
