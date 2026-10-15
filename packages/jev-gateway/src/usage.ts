// The gateway's usage record: one JSON line per request, with no request text and no answers. The summary reads it back.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UsageRow {
  at: string;
  consumer: string;
  route: 'hosted' | 'laya' | 'refused';
  tier: string;
  tierSource: string;
  modelAsked: string | null;
  modelSent: string | null;
  modelAnswered: string | null;
  status: number;
  ms: number;
  images: boolean;
  longContext: boolean;
  /** The upstream's own usage figures, when it reported any. */
  usage?: unknown;
  attempts?: number;
  server?: string;
  /** Why a request was refused or failed, in words with no request text in them. */
  reason?: string;
}

export interface UsageSummary {
  days: number;
  requests: number;
  byConsumer: Record<string, { requests: number; hosted: number; laya: number; refused: number; failed: number }>;
  byModel: Record<string, number>;
  inputTokens: number;
  p50Ms: number | null;
}

export class UsageLog {
  constructor(private path: () => string) {}

  write(row: UsageRow): void {
    try {
      const p = this.path();
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, JSON.stringify(row) + '\n');
    } catch { /* the record is best effort and never fails a request */ }
  }

  summary(days: number, now = Date.now()): UsageSummary {
    const out: UsageSummary = { days, requests: 0, byConsumer: {}, byModel: {}, inputTokens: 0, p50Ms: null };
    const p = this.path();
    if (!existsSync(p)) return out;
    const since = now - days * 86400_000, times: number[] = [];
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { return out; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r: UsageRow;
      try { r = JSON.parse(line) as UsageRow; } catch { continue; }
      const at = Date.parse(r.at);
      if (!(at >= since)) continue;
      out.requests++;
      const c = (out.byConsumer[r.consumer] ??= { requests: 0, hosted: 0, laya: 0, refused: 0, failed: 0 });
      c.requests++;
      if (r.route === 'refused') c.refused++; else if (r.status >= 400) c.failed++; else if (r.route === 'hosted') c.hosted++; else c.laya++;
      if (r.modelAnswered) out.byModel[r.modelAnswered] = (out.byModel[r.modelAnswered] ?? 0) + 1;
      const u = r.usage as { input_tokens?: unknown; prompt_tokens?: unknown } | undefined;
      const tokens = typeof u?.input_tokens === 'number' ? u.input_tokens : typeof u?.prompt_tokens === 'number' ? u.prompt_tokens : 0;
      out.inputTokens += tokens;
      if (r.status < 400) times.push(r.ms);
    }
    if (times.length) { times.sort((a, b) => a - b); out.p50Ms = times[Math.floor(times.length / 2)] as number; }
    return out;
  }
}
