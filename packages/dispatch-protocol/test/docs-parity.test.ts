import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADAPTER_INFO, BALANCE_FIELDS, DEFAULT_BALANCE, balancePaths, renderAdapterReference, renderBalanceReference, resolveBalance } from '../src/index.js';

// Run with UPDATE_DOCS=1 to rewrite the generated tables in docs/configuring.md and the classic-defaults fixture, then review the diff.
const update = process.env.UPDATE_DOCS === '1';
const page = new URL('../../../docs/configuring.md', import.meta.url);
const fixture = new URL('./fixtures/classic-balance.json', import.meta.url);

function block(text: string, name: string): { start: number; end: number } {
  const open = `<!-- ${name}:start -->`, close = `<!-- ${name}:end -->`;
  const a = text.indexOf(open), b = text.indexOf(close);
  if (a < 0 || b < a) throw new Error(`docs/configuring.md needs a ${name} block between ${open} and ${close}.`);
  return { start: a + open.length, end: b };
}

function check(name: string, table: string): void {
  let text = readFileSync(page, 'utf8').replace(/\r\n/g, '\n');
  const { start, end } = block(text, name);
  const want = `\n\n${table}\n\n`;
  if (update && text.slice(start, end) !== want) { text = text.slice(0, start) + want + text.slice(end); writeFileSync(page, text); return; }
  expect(text.slice(start, end), `the ${name} table in docs/configuring.md is out of date; run UPDATE_DOCS=1 pnpm docs:update`).toBe(want);
}

describe('the configuring page', () => {
  it('has a row for every balance setting and no row for one that does not exist', () => {
    const paths = balancePaths(), documented = BALANCE_FIELDS.map(f => f.path);
    expect(paths.filter(p => !documented.includes(p)), 'settings with no entry in BALANCE_FIELDS').toEqual([]);
    expect(documented.filter(p => !paths.includes(p)), 'entries in BALANCE_FIELDS for a setting the rules do not have').toEqual([]);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('describes each setting in a sentence that ends in a full stop', () => {
    for (const f of BALANCE_FIELDS) expect(f.summary, f.path).toMatch(/^[A-Z].*\.$/);
  });

  it('lists every adapter option in the adapter tables', () => {
    for (const a of ADAPTER_INFO) for (const o of a.options) expect(renderAdapterReference()).toContain(`\`${o.key}\``);
  });

  it('carries the balance table drawn from the code', () => check('balance-reference', renderBalanceReference()));
  it('carries the adapter tables drawn from the code', () => check('adapter-reference', renderAdapterReference()));
});

describe('the classic defaults', () => {
  it('stay exactly as an install with no profile has always resolved them', () => {
    const now = JSON.parse(JSON.stringify(resolveBalance(undefined)));
    if (update && !existsSync(fixture)) writeFileSync(fixture, JSON.stringify(now, null, 2) + '\n');
    expect(now, 'the shipped balance defaults changed; an install that names no profile must keep resolving to the fixture').toEqual(JSON.parse(readFileSync(fixture, 'utf8')));
    expect(resolveBalance(undefined)).toEqual(DEFAULT_BALANCE);
  });
});
