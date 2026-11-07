import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerAlert } from '@augur/dispatch-protocol';
import { alertPayload, cressetPayload, DesktopAlertSink, LedgerDelivery, OutboxAlertSink, WebhookAlertSink } from '../src/ledger-delivery.js';
import { Store } from '../src/store.js';
import { ViewHub } from '../src/views.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { configLines, setConfigValue } from '../src/config-edit.js';

const alert = (id = 'node:1:job.failed'): LedgerAlert => ({ version: 1, id, type: 'job.failed', at: 1, jobId: 'node:1', node: 'node', state: 'failed', route: null, sessionId: 's', summary: 'Read notes', elapsedMs: 100, usualMs: null, samples: 0 });
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'augur-delivery-'));
  const store = new Store(dir);
  cleanup.push(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const insert = (event: LedgerAlert) => store.db.prepare('insert into ledger_alerts(id,body) values(?,?)').run(event.id, JSON.stringify(event));
  return { dir, store, insert };
}

describe('ledger delivery', () => {
  it('retries only the failed sink with backoff and keeps receipts across a database reopen', async () => {
    const f = fixture(); f.insert(alert()); let now = 1;
    const success = { emit: vi.fn() }, fail = { emit: vi.fn().mockRejectedValueOnce(new Error('PRIVATE_CREDENTIAL')).mockResolvedValue(undefined) };
    const sinks = [{ name: 'outbox', sink: success }, { name: 'webhook', sink: fail }];
    const delivery = new LedgerDelivery(f.store.db, sinks, () => now);
    await delivery.tick(); expect(success.emit).toHaveBeenCalledOnce(); expect(fail.emit).toHaveBeenCalledOnce();
    expect(delivery.status()).toContainEqual({ sink: 'webhook', pending: 1, delivered: 0, failed: 1, error: 'Alert delivery failed.' });
    expect(JSON.stringify(delivery.status())).not.toContain('PRIVATE_CREDENTIAL');
    now = 1000; await delivery.tick(); expect(fail.emit).toHaveBeenCalledOnce();
    await delivery.close(); f.store.close();
    const reopened = new Store(f.dir); cleanup.push(() => reopened.close());
    const recovered = new LedgerDelivery(reopened.db, sinks, () => 1001);
    await recovered.tick(); expect(success.emit).toHaveBeenCalledOnce(); expect(fail.emit).toHaveBeenCalledTimes(2);
    await recovered.tick(); expect(fail.emit).toHaveBeenCalledTimes(2); await recovered.close();
  });

  it('bounds each pending queue and recovers deferred events from the durable alert log', async () => {
    const f = fixture(); for (let index = 0; index < 4; index++) f.insert(alert('node:' + index));
    let fail = true, now = 0;
    const emit = vi.fn(async () => { if (fail) throw new Error('offline'); });
    const delivery = new LedgerDelivery(f.store.db, [{ name: 'webhook', sink: { emit } }], () => now, 2);
    await delivery.tick();
    expect((f.store.db.prepare('select count(*) n from ledger_delivery').get() as { n: number }).n).toBe(2);
    expect(delivery.status()[0]!.pending).toBe(4);
    fail = false; now = 1000; await delivery.tick(); await delivery.tick();
    expect(delivery.status()[0]).toMatchObject({ pending: 0, delivered: 4 }); await delivery.close();
  });

  it('shares each sink worker and keeps another sink moving while one sink waits', async () => {
    const f = fixture(); f.insert(alert()); let finish!: () => void;
    const slow = { emit: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) }, fast = { emit: vi.fn() };
    const delivery = new LedgerDelivery(f.store.db, [{ name: 'desktop', sink: slow }, { name: 'outbox', sink: fast }]);
    const first = delivery.tick(), second = delivery.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(fast.emit).toHaveBeenCalledOnce(); expect(slow.emit).toHaveBeenCalledOnce();
    f.insert(alert('node:2')); const third = delivery.tick(); await Promise.resolve();
    expect(fast.emit).toHaveBeenCalledTimes(2); expect(slow.emit).toHaveBeenCalledOnce();
    finish(); await Promise.all([first, second, third]); await delivery.close();
  });

  it('does not deliver to a disabled webhook, then recovers when it is configured', async () => {
    const f = fixture(); f.insert(alert()); let enabled = false;
    const sink = { emit: vi.fn() }, delivery = new LedgerDelivery(f.store.db, [{ name: 'webhook', sink, enabled: () => enabled }]);
    await delivery.tick(); expect(sink.emit).not.toHaveBeenCalled(); enabled = true;
    await delivery.tick(); expect(sink.emit).toHaveBeenCalledOnce(); await delivery.close();
  });
});

describe('outbox sink', () => {
  it('retries an unwritable outbox without recording a successful delivery', async () => {
    const f = fixture(), path = join(f.dir, 'alerts-outbox.jsonl'); mkdirSync(path); f.insert(alert()); let now = 0;
    const delivery = new LedgerDelivery(f.store.db, [{ name: 'outbox', sink: new OutboxAlertSink(f.dir) }], () => now);
    await delivery.tick(); expect(delivery.status()[0]).toMatchObject({ failed: 1, delivered: 0 });
    rmSync(path, { recursive: true }); now = 1000; await delivery.tick();
    expect(delivery.status()[0]).toMatchObject({ failed: 0, delivered: 1 }); await delivery.close();
  });
  it('writes one public JSON object per line and recovers an append before its receipt', async () => {
    const { dir } = fixture(), event = Object.assign(alert(), { prompt: 'PRIVATE_PROMPT', answer: 'PRIVATE_ANSWER', key: 'PRIVATE_KEY' });
    const sink = new OutboxAlertSink(dir); await Promise.all([sink.emit(event), sink.emit(event)]); await new OutboxAlertSink(dir).emit(event);
    const text = readFileSync(join(dir, 'alerts-outbox.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1); expect(JSON.parse(text).id).toBe(event.id); expect(text).not.toContain('PRIVATE_');
  });

  it('rotates at the configured byte bound and keeps only the specified archives', async () => {
    const { dir } = fixture(), sink = new OutboxAlertSink(dir, 650, 2);
    for (let index = 0; index < 20; index++) await sink.emit(alert('node:' + index));
    const files = readdirSync(dir).filter(name => name.startsWith('alerts-outbox'));
    expect(files).toHaveLength(3);
    for (const name of files) { expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(650); for (const line of readFileSync(join(dir, name), 'utf8').trim().split('\n')) expect(JSON.parse(line).version).toBe(1); }
  });

  it('recovers a torn final append without merging it with the next object', async () => {
    const { dir } = fixture(); writeFileSync(join(dir, 'alerts-outbox.jsonl'), '{"id":');
    await new OutboxAlertSink(dir).emit(alert());
    expect(JSON.parse(readFileSync(join(dir, 'alerts-outbox.jsonl'), 'utf8')).id).toBe(alert().id);
  });
});

describe('webhook sink', () => {
  it('reads the current format for each delivery and preserves headers and transport options', async () => {
    let format: 'augur' | 'cresset' = 'cresset';
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const sink = new WebhookAlertSink(() => 'https://alerts.example/v1/events', () => 'ledger-alerts.token', async () => 'TEST_CREDENTIAL', () => format, fetcher as typeof fetch);
    const event = Object.assign(alert(), { prompt: 'PRIVATE_PROMPT', answer: 'PRIVATE_ANSWER' });
    await sink.emit(event); format = 'augur'; await sink.emit(event);
    for (const [index, expected] of [cressetPayload(event), alertPayload(event)].entries()) {
      const [url, init] = fetcher.mock.calls[index] as unknown as [string, RequestInit];
      expect(url).toBe('https://alerts.example/v1/events');
      expect(JSON.parse(init.body as string)).toEqual(expected);
      expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'Idempotency-Key': event.id, Authorization: 'Bearer TEST_CREDENTIAL' });
      expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.body).not.toContain('PRIVATE_'); expect(init.body).not.toContain('TEST_CREDENTIAL');
    }
  });

  it('sends only the contract, keeps the key in the header, and uses an idempotency key', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })), secret = vi.fn(async () => 'TEST_CREDENTIAL');
    const sink = new WebhookAlertSink(() => 'https://alerts.example/events', () => 'ledger-alerts.token', secret, () => 'augur', fetcher as typeof fetch);
    await sink.emit(Object.assign(alert(), { answer: 'PRIVATE_ANSWER' }));
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(secret).toHaveBeenCalledWith('ledger-alerts.token'); expect(url).toBe('https://alerts.example/events');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'Idempotency-Key': alert().id, Authorization: 'Bearer TEST_CREDENTIAL' });
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual(alert());
    expect(init.body).not.toContain('TEST_CREDENTIAL'); expect(init.body).not.toContain('PRIVATE_ANSWER');
  });

  it('rejects failed HTTP delivery and a missing referenced credential without leaking responses', async () => {
    const fetcher = vi.fn(async () => new Response('PRIVATE_RESPONSE', { status: 503 }));
    const sink = new WebhookAlertSink(() => 'https://alerts.example', () => '', async () => null, () => 'augur', fetcher as typeof fetch);
    await expect(sink.emit(alert())).rejects.toThrow('The webhook refused the alert.');
    const missing = new WebhookAlertSink(() => 'https://alerts.example', () => 'ledger-alerts.token', async () => null, () => 'augur', fetcher as typeof fetch);
    await expect(missing.emit(alert())).rejects.toThrow('credential is unavailable'); expect(fetcher).toHaveBeenCalledOnce();
  });
});

function expectCressetShape(payload: ReturnType<typeof cressetPayload>) {
  const limits = { host: 255, component: 120, title: 120, description: 1000, owner: 128, next_step: 500, fingerprint: 256, evidence_tail: 2000 } as const;
  expect(Object.keys(payload).sort()).toEqual([...Object.keys(limits), 'class', 'severity', 'assessment', 'first_seen', 'last_seen', 'count', 'kind'].sort());
  for (const [key, limit] of Object.entries(limits)) {
    const value = payload[key as keyof typeof limits];
    expect(typeof value).toBe('string'); expect(value.length).toBeGreaterThan(0); expect(value.length).toBeLessThanOrEqual(limit);
    expect(value).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  }
  expect(payload.class).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  expect(Number.isInteger(payload.severity)).toBe(true); expect(payload.severity).toBeGreaterThanOrEqual(1); expect(payload.severity).toBeLessThanOrEqual(5);
  expect(['real', 'false_alarm', 'unknown']).toContain(payload.assessment);
  expect(Number.isSafeInteger(payload.count)).toBe(true); expect(payload.count).toBeGreaterThan(0); expect(payload.kind).toBe('alert');
  for (const value of [payload.first_seen, payload.last_seen]) {
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
    expect(Number.isFinite(Date.parse(value))).toBe(true);
  }
}

describe('Cresset payload', () => {
  it.each([
    { type: 'job.failed', state: 'failed', category: 'failed', severity: 2, action: 'failed' },
    { type: 'job.stalled', state: 'stalled', category: 'stalled', severity: 3, action: 'stalled' },
    { type: 'job.over-usual-time', state: 'running', category: 'over_usual_time', severity: 4, action: 'exceeded its usual time' },
  ] as const)('maps every field for $type', ({ type, state, category, severity, action }) => {
    const event: LedgerAlert = { ...alert(), type, state, route: 'local', elapsedMs: 720000, usualMs: 60000, samples: 12 };
    const payload = cressetPayload(event);
    expect(payload).toEqual({
      host: 'node', component: 'augur.job:local', class: category, severity, title: 'Read notes',
      description: `The job ${action} on node node using route local, with state ${state} and elapsed time 12 min. There are 12 completed duration samples with a usual time of 1 min.`,
      assessment: 'unknown', owner: 'Augur', next_step: 'Open the job in the Augur job ledger (node:1).',
      fingerprint: `augur:node:local:${type}`, evidence_tail: 'jobId=node:1 alertId=node:1:job.failed',
      first_seen: '1970-01-01T00:00:00.001Z', last_seen: '1970-01-01T00:00:00.001Z', count: 1, kind: 'alert',
    });
    expectCressetShape(payload);
  });

  it('bounds every variable text field at its schema limit', () => {
    const payload = cressetPayload({ ...alert(), node: 'n'.repeat(300), route: 'r'.repeat(3000), summary: 's'.repeat(200), jobId: 'j'.repeat(2500), id: 'i'.repeat(2500) });
    expect(payload.host).toBe('n'.repeat(255)); expect(payload.component).toBe('augur.job:' + 'r'.repeat(110)); expect(payload.title).toBe('s'.repeat(120));
    expect(payload.description).toHaveLength(1000); expect(payload.next_step).toHaveLength(500); expect(payload.fingerprint).toHaveLength(256); expect(payload.evidence_tail).toHaveLength(2000);
    expectCressetShape(payload);
  });

  it.each(['job.failed', 'job.stalled', 'job.over-usual-time'] as const)('supplies a title and omits an absent route for %s', type => {
    for (const route of [null, '', '\n\u0000']) {
      const payload = cressetPayload({ ...alert(), type, route, summary: '' });
      expect(payload.title).toBe(`Augur job ${type.slice(4).replaceAll('-', ' ')}.`);
      expect(payload.component).toBe('augur.job'); expect(payload.fingerprint).toBe(`augur:node:none:${type}`);
      expect(payload.description).not.toContain('using route'); expect(payload.description).not.toContain('usual time of');
      expectCressetShape(payload);
    }
  });

  it('sanitizes controls in all supplied text and replaces empty identifiers and summaries', () => {
    const controls = Array.from({ length: 160 }, (_, index) => index).filter(index => index < 32 || index >= 127).map(index => String.fromCharCode(index)).join('');
    const payload = cressetPayload({ ...alert(), node: controls, route: '\u0000local\n', summary: controls, jobId: '\rjob\t1\u007f', id: '\u0085alert\u001f' });
    expect(payload.host).toBe('unknown'); expect(payload.title).toBe('Augur job failed.'); expect(payload.component).toBe('augur.job:local');
    expect(payload.next_step).toBe('Open the job in the Augur job ledger (job 1).'); expect(payload.evidence_tail).toBe('jobId=job 1 alertId=alert');
    for (const value of Object.values(payload)) if (typeof value === 'string') expect(value).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expectCressetShape(payload);
    const empty = cressetPayload({ ...alert(), node: '', jobId: '', id: '', summary: '   ' });
    expect(empty.evidence_tail).toBe('jobId=unknown alertId=unknown'); expectCressetShape(empty);
  });

  it.each([[100, '100 ms'], [5000, '5 sec'], [720000, '12 min'], [7200000, '2 hr'], [86400000, '1 day'], [172800000, '2 days']] as const)('formats %s milliseconds as human text', (elapsedMs, expected) => {
    expect(cressetPayload({ ...alert(), elapsedMs }).description).toContain(`elapsed time ${expected}.`);
  });

  it('excludes unrelated prompt-like fields and session metadata from the body', () => {
    const event = Object.assign(alert(), { sessionId: 'PRIVATE_SESSION_PROMPT', prompt: 'PRIVATE_PROMPT', answer: 'PRIVATE_ANSWER', error: 'PRIVATE_ERROR', metadata: { text: 'PRIVATE_TEXT' } });
    const payload = cressetPayload(event);
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_'); expect(payload.description).not.toContain(event.summary); expectCressetShape(payload);
  });
});

describe('desktop sink', () => {
  it('carries the qualified job id to the existing notification request and retries an absent desktop', async () => {
    const hub = new ViewHub(), sink = new DesktopAlertSink(() => hub);
    await expect(sink.emit(alert())).rejects.toThrow('disconnected');
    const sent: Array<Record<string, unknown>> = [];
    hub.add({ kind: 'window', caps: ['notify'] }, message => { const event = message as Record<string, unknown>; sent.push(event); hub.reply(String(event.rid), null); });
    await sink.emit(alert());
    expect(sent[0]).toMatchObject({ method: 'notify', params: { title: 'job.failed', jobId: 'node:1', alertId: alert().id } });
  });
});

describe('job alert settings', () => {
  it('normalizes missing or unknown formats and rejects invalid choices in the editor', () => {
    const { dir } = fixture();
    expect(DEFAULT_CONFIG.ledgerAlerts.webhookFormat).toBe('augur'); expect(loadConfig(dir).ledgerAlerts.webhookFormat).toBe('augur');
    for (const webhookFormat of ['unknown', '', null, 42, true]) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ ledgerAlerts: { webhookFormat } }));
      expect(loadConfig(dir).ledgerAlerts.webhookFormat).toBe('augur');
    }
    for (const value of ['unknown', '', 'Cresset']) expect(setConfigValue(dir, 'ledgerAlerts.webhookFormat', value).ok).toBe(false);
    for (const value of ['cresset', 'augur']) {
      expect(setConfigValue(dir, 'ledgerAlerts.webhookFormat', value)).toMatchObject({ ok: true, value });
      expect(loadConfig(dir).ledgerAlerts.webhookFormat).toBe(value);
      expect(configLines(dir).find(line => line.key === 'ledgerAlerts.webhookFormat')).toMatchObject({ value, default: 'augur', kind: 'choice', choices: ['augur', 'cresset'] });
    }
  });

  it('round trips switches and thresholds through config.json and the existing setting editor', () => {
    const { dir } = fixture();
    for (const [key, value] of Object.entries({ 'ledgerAlerts.stalled': 'false', 'ledgerAlerts.failed': 'false', 'ledgerAlerts.overUsualTime': 'false', 'ledgerAlerts.usualMultiple': '5', 'ledgerAlerts.minSamples': '12', 'ledgerAlerts.webhookUrl': 'https://alerts.example/events', 'ledgerAlerts.webhookKeyName': 'ledger-alerts.token', 'ledgerAlerts.webhookFormat': 'cresset', stallMinutes: '7' })) expect(setConfigValue(dir, key, value).ok).toBe(true);
    expect(loadConfig(dir)).toMatchObject({ stallMinutes: 7, ledgerAlerts: { stalled: false, failed: false, overUsualTime: false, usualMultiple: 5, minSamples: 12, webhookUrl: 'https://alerts.example/events', webhookKeyName: 'ledger-alerts.token', webhookFormat: 'cresset' } });
    expect(configLines(dir).find(line => line.key === 'ledgerAlerts.usualMultiple')).toMatchObject({ value: '5', default: '3' });
    expect(DEFAULT_CONFIG.ledgerAlerts.minSamples).toBe(8);
  });

  it('refuses inline credentials, queries, insecure webhook URLs, bad references, and invalid thresholds', () => {
    const { dir } = fixture();
    for (const value of ['http://alerts.example', 'https://user:pass@alerts.example', 'https://alerts.example?key=value', 'https://alerts.example/#key']) expect(setConfigValue(dir, 'ledgerAlerts.webhookUrl', value).ok).toBe(false);
    expect(setConfigValue(dir, 'ledgerAlerts.webhookKeyName', 'RAW_KEY_VALUE').ok).toBe(false);
    expect(setConfigValue(dir, 'ledgerAlerts.webhookKeyName', 'cogitator.manageKey').ok).toBe(false);
    for (const value of ['0', '-1', '1.5', '10001']) expect(setConfigValue(dir, 'ledgerAlerts.minSamples', value).ok).toBe(false);
    expect(readFileSync(join(dir, 'state.db')).includes(Buffer.from('RAW_KEY_VALUE'))).toBe(false);
  });
});
