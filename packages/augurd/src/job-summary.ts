import { summaryLine } from '@augur/dispatch-protocol';
import type { LedgerMetadata } from '@augur/dispatch-protocol';

export interface JobSummarizer { summarize(prompt: string, signal: AbortSignal): Promise<string> }

/** The forwarding guard keeps the prompt on this machine even when the summarize role names a peer. */
export class LocalJobSummarizer implements JobSummarizer {
  constructor(private url = 'http://127.0.0.1:8470', private request: typeof fetch = fetch, private authorization: () => Promise<string | null> = async () => null) {
    const parsed = new URL(url);
    if (!['127.0.0.1', '[::1]'].includes(parsed.hostname) || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('The job summarizer requires a loopback address.');
  }
  async summarize(prompt: string, signal: AbortSignal): Promise<string> {
    const key = await this.authorization();
    if (signal.aborted) return '';
    const response = await this.request(`${this.url}/v1/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json', 'X-Cogitator-Via': 'augur-summary', 'X-Augur-Origin': 'service', 'X-Augur-Origin-Label': 'job-summary', 'X-Augur-Summary': 'Summarize%20job%20metadata' },
      body: JSON.stringify({ model: 'summarize', stream: false, max_tokens: 48, temperature: 0,
        messages: [{ role: 'system', content: 'Describe the kind of work in one plain ASCII line of at most 120 characters. Omit names, quotations, credentials, and task data.' }, { role: 'user', content: prompt.slice(0, 8000) }] }),
    });
    if (!response.ok) return '';
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return typeof body.choices?.[0]?.message?.content === 'string' ? summaryLine(body.choices[0].message.content) : '';
  }
}

export async function fillJobSummary(prompt: string, summarizer: JobSummarizer, get: () => LedgerMetadata | undefined,
  patch: (meta: LedgerMetadata) => void, timeoutMs = 750): Promise<void> {
  if (get()?.summary) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => summarizer.summarize(prompt, controller.signal)),
      new Promise<string>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(''); }, timeoutMs); }),
    ]);
    const line = summaryLine(result), current = get();
    if (line && current && !current.summary && !current.compacted) patch({ ...current, summary: line, summarySource: 'local-model' });
  } catch { /* A summary is optional metadata. */ }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
