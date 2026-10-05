import { reportHeading, reportSections } from '@augur/dispatch-protocol';
import type { BalanceReport } from '@augur/dispatch-protocol';
import { dispatchTabs } from './jobs';
import { ICON, esc } from '../util';

export interface BalanceModel {
  /** Null until the service has answered. */
  report: BalanceReport | null;
  error: string;
}

/** The balance report, read-only: the same groups and words as `augur balance` and the terminal app. */
export function renderBalance(m: BalanceModel): string {
  const body = m.error ? `<div class="rnote bad" role="alert">${esc(m.error)}</div>`
    : m.report ? reportSections(m.report).map((s) => `<div class="card"><div class="rsec" style="margin-top:0">${esc(s.title)}</div><pre class="jlog" tabindex="0">${esc(s.lines.join('\n'))}</pre></div>`).join('')
    : '<div class="rempty big">Reading the balance report.</div>';
  return `<div class="rules-page jobs-page"><header class="top"><button class="icon" data-action="back" title="Back to usage" aria-label="Back to usage">${ICON.back}</button>
    <div><h1>Balance</h1><div class="sub">${esc(m.report ? reportHeading(m.report) : 'What the router is doing now')}</div></div><span class="grow"></span></header>
    ${dispatchTabs('balance')}${body}</div>`;
}
