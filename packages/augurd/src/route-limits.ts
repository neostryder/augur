// Routes that hit a usage limit stay unavailable for a day, so later jobs go straight to the fallback.
import { join } from 'node:path';
import { atomicWrite, readText } from './home-files.js';

/** How long a route stays held after a usage limit. */
export const HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Wording that means the owner's allowance on that provider is spent, not that it is busy for a moment.
 * `429`, "overloaded", "capacity" and "try again later" are left out because they usually clear within minutes.
 */
const USAGE_LIMIT = /rate[- ]limit|usage limit|quota|allowance|too many requests|resource exhausted|insufficient credits|credit balance|limit (?:reached|exceeded)|reached (?:your|the) .{0,30}limit/i;

export const isUsageLimit = (text: string): boolean => USAGE_LIMIT.test(text);

export interface RouteHold { until: number; since: number; why: string }

/** Holds are kept in `route-limits.json` in the Augur home, so a service restart does not forget them. */
export class RouteLimits {
  private readonly path: string;
  constructor(home: string, private readonly now: () => number = Date.now) { this.path = join(home, 'route-limits.json'); }

  private read(): Record<string, RouteHold> {
    try {
      const raw = JSON.parse(readText(this.path) ?? '{}') as Record<string, RouteHold>;
      return Object.fromEntries(Object.entries(raw).filter(([, h]) => h && typeof h.until === 'number' && h.until > this.now()));
    } catch { return {}; }
  }

  /** Holds a route for a day from now. A route already held keeps its first hold, so a late failure does not stretch it. */
  hold(route: string, why: string): RouteHold {
    const all = this.read(), current = all[route];
    if (current) return current;
    const hold = { since: this.now(), until: this.now() + HOLD_MS, why: why.slice(0, 200) };
    all[route] = hold;
    atomicWrite(this.path, JSON.stringify(all, null, 2));
    return hold;
  }

  held(route: string): RouteHold | null { return this.read()[route] ?? null; }

  release(route: string): boolean {
    const all = this.read();
    if (!all[route]) return false;
    delete all[route];
    atomicWrite(this.path, JSON.stringify(all, null, 2));
    return true;
  }

  list(): Record<string, RouteHold> { return this.read(); }
}
