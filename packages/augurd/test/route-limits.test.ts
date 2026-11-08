import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOLD_MS, RouteLimits, isUsageLimit } from '../src/route-limits.js';

const dirs: string[] = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), 'augur-limits-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('isUsageLimit', () => {
  it.each(['Rate limit reached for deep research', 'You have hit your usage limit', 'monthly quota exceeded', 'allowance spent', 'Too many requests', 'You have reached your Deep research limit', 'Insufficient credits', 'The site says deep research is rate limited, so the run did not start. Wait for the limit to reset, and use another route meanwhile.', 'The site says the free allowance is used up. Wait for it to renew, and use another model meanwhile.'])('reads %s as a spent allowance', (text) => {
    expect(isUsageLimit(text)).toBe(true);
  });

  it.each(['HTTP 429', 'server overloaded', 'at capacity, try again later', 'exit 1', 'the browser was not found', 'The site accepted the deep research request but showed no plan or report for three minutes, so the run did not start. Use another route meanwhile.'])('does not hold a route for %s', (text) => {
    expect(isUsageLimit(text)).toBe(false);
  });
});

describe('RouteLimits', () => {
  it('holds a route for a day and keeps the first hold', () => {
    let now = 1_000_000;
    const limits = new RouteLimits(home(), () => now);
    expect(limits.held('chatgpt-research')).toBeNull();
    const first = limits.hold('chatgpt-research', 'rate limit');
    expect(first).toMatchObject({ since: 1_000_000, until: 1_000_000 + HOLD_MS, why: 'rate limit' });
    now += 3_600_000;
    expect(limits.hold('chatgpt-research', 'rate limit again')).toEqual(first);
    expect(limits.held('chatgpt-research')).toEqual(first);
    expect(limits.held('m365-research')).toBeNull();
  });

  it('forgets a hold after a day, and a new service reads the file back', () => {
    let now = 5_000;
    const dir = home();
    new RouteLimits(dir, () => now).hold('m365-research', 'quota');
    expect(new RouteLimits(dir, () => now + HOLD_MS - 1).held('m365-research')).not.toBeNull();
    expect(new RouteLimits(dir, () => now + HOLD_MS).held('m365-research')).toBeNull();
    now += HOLD_MS;
    const limits = new RouteLimits(dir, () => now);
    expect(limits.hold('m365-research', 'quota').since).toBe(now);
  });

  it('releases a hold early', () => {
    const limits = new RouteLimits(home());
    limits.hold('chatgpt-research', 'rate limit');
    expect(limits.release('chatgpt-research')).toBe(true);
    expect(limits.release('chatgpt-research')).toBe(false);
    expect(limits.list()).toEqual({});
  });
});
