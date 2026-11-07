import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerAlert } from '@augur/dispatch-protocol';
import { DesktopAlertSink, LedgerDelivery, OutboxAlertSink, WebhookAlertSink } from '../src/ledger-delivery.js';
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
  it('sends only the contract, keeps the key in the header, and uses an idempotency key', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })), secret = vi.fn(async () => 'TEST_CREDENTIAL');
    const sink = new WebhookAlertSink(() => 'https://alerts.example/events', () => 'ledger-alerts.token', secret, fetcher as typeof fetch);
    await sink.emit(Object.assign(alert(), { answer: 'PRIVATE_ANSWER' }));
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(secret).toHaveBeenCalledWith('ledger-alerts.token'); expect(url).toBe('https://alerts.example/events');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'Idempotency-Key': alert().id, Authorization: 'Bearer TEST_CREDENTIAL' });
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).not.toContain('TEST_CREDENTIAL'); expect(init.body).not.toContain('PRIVATE_ANSWER');
  });

  it('rejects failed HTTP delivery and a missing referenced credential without leaking responses', async () => {
    const fetcher = vi.fn(async () => new Response('PRIVATE_RESPONSE', { status: 503 }));
    const sink = new WebhookAlertSink(() => 'https://alerts.example', () => '', async () => null, fetcher as typeof fetch);
    await expect(sink.emit(alert())).rejects.toThrow('The webhook refused the alert.');
    const missing = new WebhookAlertSink(() => 'https://alerts.example', () => 'ledger-alerts.token', async () => null, fetcher as typeof fetch);
    await expect(missing.emit(alert())).rejects.toThrow('credential is unavailable'); expect(fetcher).toHaveBeenCalledOnce();
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
  it('round trips switches and thresholds through config.json and the existing setting editor', () => {
    const { dir } = fixture();
    for (const [key, value] of Object.entries({ 'ledgerAlerts.stalled': 'false', 'ledgerAlerts.failed': 'false', 'ledgerAlerts.overUsualTime': 'false', 'ledgerAlerts.usualMultiple': '5', 'ledgerAlerts.minSamples': '12', 'ledgerAlerts.webhookUrl': 'https://alerts.example/events', 'ledgerAlerts.webhookKeyName': 'ledger-alerts.token', stallMinutes: '7' })) expect(setConfigValue(dir, key, value).ok).toBe(true);
    expect(loadConfig(dir)).toMatchObject({ stallMinutes: 7, ledgerAlerts: { stalled: false, failed: false, overUsualTime: false, usualMultiple: 5, minSamples: 12, webhookUrl: 'https://alerts.example/events', webhookKeyName: 'ledger-alerts.token' } });
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
