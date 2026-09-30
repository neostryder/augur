// Builds the accounting answer from the job store and the owner's rate card. The arithmetic is in dispatch-protocol; this only gathers the inputs.
import { BUDGET_WINDOW_MS, account, budgetStatus, calibrateRoutes, totalOf } from '@augur/dispatch-protocol';
import type { AccountingAnswer, Accounted, JobRecord, RateCard, RouteConfig } from '@augur/dispatch-protocol';

/** Reads rates.json: `{ "provider/model": { "inputPerM": 1, "outputPerM": 5, "cachedReadPerM": 0.1 } }`. An entry that is not numbers is left out. */
export function parseRates(text: string | null): RateCard {
  if (!text) return {};
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return {}; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const out: RateCard = {};
  for (const [model, r] of Object.entries(raw)) {
    if (typeof r !== 'object' || r === null) continue;
    const e = r as Record<string, unknown>, inputPerM = num(e.inputPerM), outputPerM = num(e.outputPerM);
    if (inputPerM === undefined || outputPerM === undefined) continue;
    const cachedReadPerM = num(e.cachedReadPerM), cachedWritePerM = num(e.cachedWritePerM);
    out[model] = { inputPerM, outputPerM, ...(cachedReadPerM !== undefined ? { cachedReadPerM } : {}), ...(cachedWritePerM !== undefined ? { cachedWritePerM } : {}) };
  }
  return out;
}

export function buildAccounting(jobs: readonly JobRecord[], routes: Record<string, RouteConfig> | null, rates: RateCard, limit: number, now = Date.now()): AccountingAnswer {
  const calibrations = calibrateRoutes(jobs);
  const model = (route: string): string | null => routes?.[route]?.model ?? null;
  const list = jobs.map(j => ({ id: j.id, route: j.route, model: model(j.route), accounted: account(j, model(j.route), rates, calibrations[j.route]) }));
  const perRoute: AccountingAnswer['routes'] = {};
  const grouped = new Map<string, Accounted[]>();
  for (const j of list) grouped.set(j.route, [...(grouped.get(j.route) ?? []), j.accounted]);
  const budgetFor = (route: string): AccountingAnswer['routes'][string]['budget'] => {
    const budget = routes?.[route]?.budget;
    if (!budget) return null;
    const since = now - BUDGET_WINDOW_MS[budget.per];
    return budgetStatus(route, budget, list.filter(j => j.route === route && jobs.find(x => x.id === j.id)!.createdAt >= since).map(j => j.accounted));
  };
  for (const [route, accounted] of grouped) perRoute[route] = { model: model(route), totals: totalOf(accounted), calibration: calibrations[route] ?? null, budget: budgetFor(route) };
  return { jobs: list.slice(0, limit), routes: perRoute, ratedModels: Object.keys(rates) };
}
