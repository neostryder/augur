import { validNode, validNodeJobPage } from '@augur/dispatch-protocol';
import { keyMayGoTo } from '@augur/core';
import type { JobLedger } from './job-ledger.js';

export interface LedgerEndpoint { node: string; url: string; keyName?: string }

export class JobPoller {
  private pending = new Map<string, Promise<void>>();
  private controllers = new Set<AbortController>();
  private closed = false;
  constructor(private ledger: JobLedger, private endpoints: () => LedgerEndpoint[], private request: typeof fetch = fetch, private authorization: (endpoint: LedgerEndpoint) => Promise<string | null> = async () => null) {}

  poll(): Promise<void> { return Promise.all(this.endpoints().map(endpoint => this.pollNode(endpoint))).then(() => {}); }

  private pollNode(endpoint: LedgerEndpoint): Promise<void> {
    if (this.closed || !validNode(endpoint.node)) return Promise.resolve();
    const existing = this.pending.get(endpoint.node);
    if (existing) return existing;
    const run = this.pull(endpoint).finally(() => this.pending.delete(endpoint.node));
    this.pending.set(endpoint.node, run);
    return run;
  }

  private async pull(endpoint: LedgerEndpoint): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const base = new URL(endpoint.url);
      if (!keyMayGoTo(endpoint.url) || base.username || base.password) throw new Error();
      const key = await this.authorization(endpoint);
      // Bounded batches let a large backlog catch up without monopolizing the service.
      for (let batch = 0; batch < 10 && !this.closed; batch++) {
        const since = this.ledger.cursor(endpoint.node), url = new URL('/api/v1/jobs', base);
        url.searchParams.set('since', since);
        const response = await this.request(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
        if (!response.ok) throw new Error();
        const text = await response.text();
        if (text.length > 4 * 1024 * 1024) throw new Error();
        const page: unknown = JSON.parse(text);
        if (this.closed) return;
        if (!validNodeJobPage(page) || (page.more && page.next === since)) throw new Error();
        this.ledger.ingest(endpoint.node, page);
        if (!page.more) return;
      }
    } catch { if (!this.closed) this.ledger.unreachable(endpoint.node); }
    finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }

  close(): void { this.closed = true; for (const controller of this.controllers) controller.abort(); }
}
