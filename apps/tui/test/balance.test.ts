import { describe, expect, it } from 'vitest';
import { balanceReport, surplusWindowStatus } from '@augur/dispatch-protocol';
import { emptyPolicy } from '@augur/core';
import { BalancePage } from '../src/screens/balance.js';
import { UsagePage } from '../src/screens/usage.js';
import { pages } from '../src/index.js';
import { NOW, k, setup } from './fixtures.js';

function open(answer: unknown) {
  const page = new BalancePage();
  const list = pages();
  list[4] = page;
  const t = setup(undefined, { pages: list, answers: { balance: answer } });
  t.app.active = 4;
  return { ...t, page };
}

describe('balance page', () => {
  it('shows the report once the service has answered', async () => {
    const report = balanceReport(emptyPolicy() as never, null, new Date(NOW));
    const { app, draw } = open(report);
    expect(draw()).toContain('Reading the balance report');
    await app.poll();
    const text = draw(110, 60);
    expect(text).toContain('Balance report');
    expect(text).toContain('Copilot');
    expect(text).toContain('What each kind of work goes to now');
  });

  it('shows the service error in place of the report', async () => {
    const { app, draw } = open({ error: 'policy.json was not found.' });
    await app.poll();
    expect(draw()).toContain('policy.json was not found.');
  });

  it('scrolls with the arrow keys', async () => {
    const report = balanceReport(emptyPolicy() as never, null, new Date(NOW));
    const { app } = open(report);
    await app.poll();
    expect(await app.key(k('down'))).toBe(true);
  });
});

describe('usage gate row', () => {
  it('shows the service surplus window wording', async () => {
    const window = surplusWindowStatus({ open: true, spent: false, budgetLeft: 5, hoursLeft: 6, unused: 10 }, { hours: 12, open: 10 });
    const usage = new UsagePage(), list = pages();
    list[0] = usage;
    const t = setup(undefined, { pages: list, answers: { gate_status: { close: 10, providers: [{ provider: 'claude', state: 'closed', gap: null, window, labels: ['claude/opus'], lastApproval: null }] } } });
    await t.app.poll();
    expect(t.draw(100, 30)).toContain(window);
  });
  it('lists premium tasks that wait for approval', async () => {
    const usage = new UsagePage(), list = pages();
    list[0] = usage;
    const awaiting = [{ id: 'bk1', task: 'refactor the parser', route: 'claude/opus', estimate: 3, requester: 'agent-7', deadline: null }];
    const t = setup(undefined, { pages: list, answers: { gate_status: { close: 10, providers: [], backlog: { awaiting, queued: 0, running: 0 } } } });
    await t.app.poll();
    const screen = t.draw(120, 30);
    expect(screen).toContain('1 premium task waits for your approval');
    expect(screen).toContain('bk1');
    expect(screen).toContain('agent-7 wants claude/opus');
  });
});
