import { describe, expect, it } from 'vitest';
import { DEFAULT_PACE_RULES, resolveBalance, upgradeBalance } from '../src/index.js';

// C:/Users/neost/.augur/policy.json has no balance key.
const liveBalance = undefined;

const fixtures: unknown[] = [
  undefined,
  {},
  { profile: 'neutral' },
  { claude: { provider: 'copilot' } },
  { claude: { band: 8 } },
  { claude: { reserve: 70 } },
  { claude: { hot: { strong: 0.55, light: 1.4 } } },
  { claude: { behind: { strong: 1.6, light: 0.7 } } },
  { claude: { provider: 'claude', band: 8, reserve: 70, hot: { strong: 0.55, light: 1.4 }, behind: { strong: 1.6, light: 0.7 } } },
  { claude: { provider: 1 } },
  { claude: { band: '5' } },
  { claude: { reserve: true } },
  { claude: { hot: null } },
  { claude: { behind: [] } },
  { claude: { provider: 1, band: '5', reserve: true, hot: null, behind: 4 } },
  { claude: { provider: 'copilot', band: 6, reserve: 88, hot: { strong: 0.7, light: 1.1 }, behind: { strong: 1.3, light: 0.9 } } },
  { schema: 2, pace: { claude: { band: 6, boost: 2 }, grok: { reserve: 55, boost: 1 } } },
  { claude: { hot: { strong: 0.5 }, band: 9 }, pace: { claude: { hot: { light: 2 }, boost: 3 } } },
  liveBalance,
];

const snap = (v: unknown): unknown => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const label = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

describe('upgrading a balance', () => {
  it('resolves the same rules, is idempotent, and leaves the input alone', () => {
    for (const f of fixtures) {
      const before = snap(f);
      const once = upgradeBalance(f);
      expect(f, label(f)).toEqual(before);
      expect(upgradeBalance(once), label(f)).toEqual(once);
      expect(resolveBalance(once), label(f)).toEqual(resolveBalance(f));
    }
  });
});

describe('pace resolution', () => {
  it('layers the builtin, then the legacy block for the named provider, then pace', () => {
    const b = resolveBalance({
      claude: { provider: 'copilot', band: 3, reserve: 80, hot: { strong: 0.4 } },
      pace: { copilot: { band: 7, boost: 2 }, claude: { reserve: 60 } },
    });
    const copilot = b.pace.copilot, own = b.pace.claude;
    expect(copilot).toEqual({ band: 7, reserve: 80, hot: { strong: 0.4, light: 1.25 }, behind: { strong: 1.25, light: 0.85 }, boost: 2 });
    expect(own).toMatchObject({ band: 5, reserve: 60, boost: 1.5 });
    expect(b.claude).toEqual({ provider: 'copilot', band: 7, reserve: 80, hot: { strong: 0.4, light: 1.25 }, behind: { strong: 1.25, light: 0.85 } });
  });

  it('keeps a lower layer for a wrong type and for a boost below 1', () => {
    const b = resolveBalance({ claude: { band: 'wide', reserve: 70 }, pace: { claude: { reserve: 'high', boost: 0.5 } } });
    const own = b.pace.claude, one = resolveBalance({ pace: { claude: { boost: 1 } } }).pace.claude, up = resolveBalance({ pace: { claude: { boost: 2.5 } } }).pace.claude, grok = resolveBalance({ pace: { grok: {} } }).pace.grok;
    expect(own?.band).toBe(5);
    expect(own?.reserve).toBe(70);
    expect(own?.boost).toBe(1.5);
    expect(one?.boost).toBe(1);
    expect(up?.boost).toBe(2.5);
    expect(grok).toEqual(DEFAULT_PACE_RULES);
  });

  it('derives the claude view from the steered provider entry', () => {
    const b = resolveBalance({ claude: { provider: 'copilot', behind: { light: 0.4 } } });
    const copilot = b.pace.copilot, own = b.pace.claude;
    expect(b.claude.provider).toBe('copilot');
    expect(b.claude.behind.light).toBe(0.4);
    expect(b.claude.band).toBe(copilot?.band);
    expect(b.claude.hot).toEqual(copilot?.hot);
    expect(b.claude.reserve).toBe(copilot?.reserve);
    expect(own?.band).toBe(5);
    expect(copilot?.band).toBe(DEFAULT_PACE_RULES.band);
    expect(Object.keys(resolveBalance({ pace: { grok: { band: 11 } }, claude: { provider: 'copilot' } }).pace).sort()).toEqual(['claude', 'copilot', 'grok']);
  });
});
