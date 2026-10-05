import { describe, expect, it } from 'vitest';
import { balanceReport } from '@augur/dispatch-protocol';
import { emptyPolicy } from '@augur/core';
import { BalancePage } from '../src/screens/balance.js';
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
    expect(text).toContain('Claude');
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
