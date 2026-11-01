export const MAX_SCHEMA_BYTES = 64 * 1024;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateRunOptions(request: { effort?: unknown; schema?: unknown }): string | null {
  if (request.effort !== undefined && (typeof request.effort !== 'string' || !/^[A-Za-z0-9-]{1,16}$/.test(request.effort))) return 'effort must be 1 to 16 letters, digits or hyphens.';
  if (request.schema !== undefined) {
    if (!object(request.schema)) return 'schema must be a JSON object.';
    try { if (new TextEncoder().encode(JSON.stringify(request.schema)).length > MAX_SCHEMA_BYTES) return 'schema must be at most 64 KB.'; }
    catch { return 'schema must be a JSON object.'; }
  }
  return null;
}

export function schemaPrompt(prompt: string, schema: Record<string, unknown> | undefined, adapter: string): string {
  return schema && adapter !== 'codex-exec' && adapter !== 'grok-exec'
    ? prompt + '\n\nReply with only a JSON document matching this JSON Schema. Do not wrap it in a code fence.\n' + JSON.stringify(schema)
    : prompt;
}

function jsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > 64) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i], depth + 1));
  if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k], depth + 1));
  return false;
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'object': return object(value);
    case 'array': return Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}

function mismatch(value: unknown, schema: unknown, path = '$', depth = 0): string | null {
  if (schema === false) return path + ' is disallowed.';
  if (!object(schema)) return null;
  if (depth > 64) return 'validation nesting exceeds 64 levels.';
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => matchesType(value, t))) return path + ' has the wrong type.';
  if (Array.isArray(schema.enum) && !schema.enum.some(v => jsonEqual(value, v))) return path + ' is outside enum.';
  if (object(value)) {
    if (Array.isArray(schema.required)) for (const key of schema.required) {
      if (typeof key === 'string' && !Object.hasOwn(value, key)) return path + ' is missing a required property.';
    }
    if (object(schema.properties)) for (const [key, rule] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const problem = mismatch(value[key], rule, path + '.properties', depth + 1);
      if (problem) return problem;
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) for (const item of value) {
    const problem = mismatch(item, schema.items, path + '.items', depth + 1);
    if (problem) return problem;
  }
  return null;
}

export function validateSchemaAnswer(answer: string, schema: Record<string, unknown>): { answer: string; warning?: string } {
  let value: unknown;
  try { value = JSON.parse(answer); }
  catch {
    const fence = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(answer);
    if (!fence) return { answer, warning: 'schema: answer is not valid JSON.' };
    try { value = JSON.parse(fence[1] as string); answer = (fence[1] as string).trim(); }
    catch { return { answer, warning: 'schema: answer is not valid JSON after removing a code fence.' }; }
  }
  const problem = mismatch(value, schema);
  return { answer, ...(problem ? { warning: 'schema: ' + problem } : {}) };
}
