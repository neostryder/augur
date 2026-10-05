import { describe, expect, it } from 'vitest';
import { emptyPolicy } from '@augur/core';
import { balanceReport } from '@augur/dispatch-protocol';
import { renderBalance } from '../src/views/balance';

describe('the balance page', () => {
  it('waits for the service before showing anything', () => {
    const html = renderBalance({ report: null, error: '' });
    expect(html).toContain('Reading the balance report.');
    expect(html).toContain('data-value="balance"');
  });

  it('shows the report in the same groups as the command', () => {
    const report = balanceReport(emptyPolicy() as never, null, new Date('2026-10-04T12:00:00Z'));
    const html = renderBalance({ report, error: '' });
    expect(html).toContain('Claude');
    expect(html).toContain('Copilot');
    expect(html).toContain('What each kind of work goes to now');
    expect(html).toContain('Balance report, 2026-10-04 12:00 UTC');
  });

  it('shows the service error and escapes it', () => {
    const html = renderBalance({ report: null, error: '<b>no policy</b>' });
    expect(html).toContain('&lt;b&gt;no policy&lt;/b&gt;');
    expect(html).toContain('role="alert"');
  });
});
