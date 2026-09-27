import type { GenericProviderDef, Host, ProviderPlugin } from './types.js';
import { json, num, obj, round, iso, epoch } from './util.js';

export function readPath(root: unknown, path: string): unknown {
  if (!path.startsWith('$')) throw new Error('Invalid path');
  let value: any = root;
  const parts = path.slice(1).match(/\.[A-Za-z_][\w-]*|\[[^\]]+\]/g) ?? [];
  if (parts.join('') !== path.slice(1)) throw new Error('Invalid path');
  for (const part of parts) {
    if (part.startsWith('.')) value = obj(value)[part.slice(1)];
    else {
      const step = part.slice(1, -1);
      if (/^\d+$/.test(step)) value = Array.isArray(value) ? value[Number(step)] : undefined;
      else {
        const match = /^([\w-]+)=([^\]]+)$/.exec(step);
        if (!match) throw new Error('Invalid path filter');
        value = Array.isArray(value) ? value.find(row => String(obj(row)[match[1]!]) === match[2]) : undefined;
      }
    }
  }
  return value;
}

export function readValue(expression: string, responses: Record<string, unknown>): unknown {
  const match = /^([\w-]+):(\$.*)$/.exec(expression);
  if (!match) throw new Error('Invalid value path');
  return readPath(responses[match[1]!], match[2]!);
}

export function evaluate(expression: string, responses: Record<string, unknown>): number | null {
  if (!expression.startsWith('=')) return num(readValue(expression, responses));
  const source = expression.slice(1);
  const tokens = source.match(/\s*(?:\d+(?:\.\d+)?|[A-Za-z_][\w-]*:\$(?:\.[\w-]+|\[[^\]]+\])*|[()+*/-])/g) ?? [];
  if (tokens.join('').replace(/\s/g, '') !== source.replace(/\s/g, '')) throw new Error('Invalid expression');
  const words = tokens.map(token => token.trim());
  let at = 0;
  const factor = (): number => {
    const token = words[at++];
    if (token === '-') return -factor();
    if (token === '+') return factor();
    if (token === '(') {
      const value = sum();
      if (words[at++] !== ')') throw new Error('Invalid expression');
      return value;
    }
    if (token && /^\d/.test(token)) return Number(token);
    if (token?.includes(':')) return num(readValue(token, responses)) ?? NaN;
    throw new Error('Invalid expression');
  };
  const product = (): number => {
    let value = factor();
    while (words[at] === '*' || words[at] === '/') {
      const op = words[at++]; const next = factor();
      value = op === '*' ? value * next : value / next;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (words[at] === '+' || words[at] === '-') {
      const op = words[at++]; const next = product();
      value = op === '+' ? value + next : value - next;
    }
    return value;
  };
  const result = sum();
  if (at !== words.length) throw new Error('Invalid expression');
  return Number.isFinite(result) ? result : null;
}

export function genericProvider(def: GenericProviderDef): ProviderPlugin {
  return {
    id: def.id, name: def.name, color: def.color, links: def.links ?? {}, needsLocalLogin: false,
    fields: def.auth.type === 'none' ? [] : [{ key: 'apiKey', label: 'API key', kind: 'secret', required: true }],
    async fetch(host: Host) {
      const secret = def.auth.type === 'none' ? null : await host.secret(`${def.id}.apiKey`);
      if (def.auth.type !== 'none' && !secret) throw new Error('No API key yet. Add one in settings.');
      const responses: Record<string, unknown> = {};
      await Promise.all(Object.entries(def.requests).map(async ([key, request]) => {
        const url = new URL(request.url);
        const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
        if (def.auth.type === 'bearer') headers.Authorization = `${def.auth.prefix ?? 'Bearer '}${secret}`;
        if (def.auth.type === 'header') headers[def.auth.name ?? 'X-API-Key'] = `${def.auth.prefix ?? ''}${secret}`;
        if (def.auth.type === 'query') url.searchParams.set(def.auth.name ?? 'key', secret!);
        if (request.body !== undefined) headers['Content-Type'] = 'application/json';
        responses[key] = await json(host, { url: url.toString(), method: request.method, headers, body: request.body === undefined ? undefined : JSON.stringify(request.body) });
      }));
      const string = (expr?: string): string | null => expr ? String(readValue(expr, responses) ?? '') || null : null;
      const detail = (expr?: string): string | null => {
        if (!expr) return null;
        if (!expr.includes('{')) return string(expr);
        return expr.replace(/\{([^{}|]+)(?:\|(fixed2))?\}/g, (_, path: string, format: string | undefined) => {
          const value = readValue(path, responses);
          return format === 'fixed2' && num(value) !== null ? num(value)!.toFixed(2) : String(value ?? '');
        });
      };
      return {
        plan: def.plan?.includes(':') ? string(def.plan) : def.plan,
        meters: (def.meters ?? []).filter(meter => !meter.includeIf || !!evaluate(meter.includeIf, responses)).map(meter => {
          const rawReset = meter.resetsAt ? readValue(meter.resetsAt, responses) : null;
          return { id: meter.id, label: meter.label, usedPct: meter.usedPct ? round(evaluate(meter.usedPct, responses)) : null,
            resetsAt: meter.resetsAtFormat === 'epoch_s' ? epoch(rawReset) : meter.resetsAtFormat === 'epoch_ms' ? epoch(rawReset, 1) : iso(rawReset),
            windowSeconds: meter.windowSeconds ?? null, windowKind: meter.windowKind ?? 'other', detail: detail(meter.detail) };
        }),
        money: (def.money ?? []).map(money => ({ id: money.id, label: money.label, amount: round(evaluate(money.amount, responses), 2),
          total: money.total ? round(evaluate(money.total, responses), 2) : null, currency: money.currency ?? 'USD' }))
      };
    }
  };
}
