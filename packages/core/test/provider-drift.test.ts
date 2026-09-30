import { describe, expect, it } from 'vitest';
import { builtinProviders } from '../src/providers/index.js';
import type { Host, HttpResponse, ProviderResult } from '../src/types.js';

// Every provider is fed answers its API would never normally send. It may refuse with an error; it may not return a reading with a NaN percentage,
// an unparseable reset time or a negative amount, which would reach the tray icon and the alerts as real numbers.
const BODIES: unknown[] = [null, {}, [], 'text', 7, { data: null }, { error: 'x' }, { data: {} }, { data: [] }, { usage: {}, limits: [] }, [{}], { message: 'rate limited' }];

function host(body: unknown): Host {
  const res: HttpResponse = { status: 200, headers: {}, body: JSON.stringify(body) };
  return {
    platform: 'windows', http: async () => res, secret: async () => 'test-key', now: () => new Date('2026-09-29T20:00:00Z'),
    readHomeFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: 9e12 }, tokens: { access_token: 't', account_id: 'a' }, access_token: 't' }),
    run: async () => ({ code: 0, stdout: 'test-key', stderr: '' }), webSession: async () => (body && typeof body === 'object' ? body as Record<string, unknown> : null),
    copilotUsage: async () => res,
  } as Host;
}

function sane(result: ProviderResult, id: string, body: unknown) {
  const at = `${id} with ${JSON.stringify(body)}`;
  for (const m of result.meters) {
    if (m.usedPct !== null) expect(Number.isFinite(m.usedPct), `${at}: ${m.id} percent`).toBe(true);
    if (m.resetsAt) expect(Number.isNaN(Date.parse(m.resetsAt)), `${at}: ${m.id} reset`).toBe(false);
    if (m.windowSeconds != null) expect(Number.isFinite(m.windowSeconds), `${at}: ${m.id} window`).toBe(true);
  }
  for (const c of result.money) {
    for (const v of [c.amount, c.total]) if (v !== null && v !== undefined) expect(Number.isFinite(v), `${at}: ${c.id} amount`).toBe(true);
  }
}

describe('providers given answers that do not match what they expect', () => {
  for (const plugin of builtinProviders) {
    it(`${plugin.id} refuses or returns only finite numbers`, async () => {
      for (const body of BODIES) {
        let result: ProviderResult | null = null;
        try { result = await plugin.fetch(host(body), Object.fromEntries(plugin.fields.map(f => [f.key, 'x'])) as never); }
        catch (e) { expect(e, `${plugin.id} with ${JSON.stringify(body)}`).toBeInstanceOf(Error); expect((e as Error).message.length, `${plugin.id} with ${JSON.stringify(body)} threw an empty error`).toBeGreaterThan(0); }
        if (result) sane(result, plugin.id, body);
      }
    });
  }
});
