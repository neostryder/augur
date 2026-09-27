import type { Host, HttpRequest } from './types.js';

export const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const num = (value: unknown): number | null => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export const round = (value: number | null, digits = 1): number | null => value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
export const iso = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
export const epoch = (value: unknown, factor = 1000): string | null => num(value) ? iso(num(value)! * factor) : null;
export const now = (host: Host): Date => host.now?.() ?? new Date();
export const windowKind = (seconds: number | null): 'session' | 'daily' | 'weekly' | 'monthly' | 'other' => {
  if (seconds !== null && Math.abs(seconds - 18000) < 360) return 'session';
  if (seconds !== null && Math.abs(seconds - 86400) < 360) return 'daily';
  if (seconds !== null && Math.abs(seconds - 604800) < 3600) return 'weekly';
  if (seconds !== null && seconds >= 2419200 && seconds <= 2678400) return 'monthly';
  return 'other';
};
export const windowLabel = (seconds: number | null): string => {
  const kind = windowKind(seconds);
  if (kind === 'session') return '5h';
  if (kind !== 'other') return kind;
  if (!seconds) return 'window';
  const hours = seconds / 3600;
  return hours < 48 ? `${Number(hours.toPrecision(3))}h` : `${Number((seconds / 86400).toPrecision(3))}d`;
};

export class HttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}
export async function json(host: Host, req: HttpRequest): Promise<any> {
  const response = await host.http({ timeoutMs: 15000, ...req });
  if (response.status < 200 || response.status >= 300) throw new HttpError(response.status);
  try { return JSON.parse(response.body || '{}'); } catch { throw new Error('Invalid response from provider'); }
}
export function userError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 401) return 'Sign in again or update the key';
    if (error.status === 403) return 'Access denied; check the key permissions';
    if (error.status === 429) return 'Rate limited; try again later';
    return `Provider returned HTTP ${error.status}`;
  }
  if (error instanceof Error && /^(Missing |Needs |No |Invalid |Unable |Sign |Provider |Rate |Access |Key |Could not )/.test(error.message)) return error.message.slice(0, 120);
  return 'Could not reach provider; try again';
}
