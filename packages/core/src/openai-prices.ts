import type { JobUsage } from './types.js';

const image = { inputPerM: 8, outputPerM: 30, cachedReadPerM: 2, textInputPerM: 5 };
export const OPENAI_IMAGE_PRICES: Record<string, { inputPerM: number; outputPerM: number; cachedReadPerM?: number; textInputPerM?: number }> = {
  'gpt-image-2.6-flare': image,
  'gpt-image-2.6-sunburst': image,
  'gpt-image-2.5': image,
  'gpt-image-2': image,
  'gpt-image-1-mini': { inputPerM: 2.5, outputPerM: 8 },
};

export function imageCost(job: JobUsage): number | null {
  const rate = Object.hasOwn(OPENAI_IMAGE_PRICES, job.model) ? OPENAI_IMAGE_PRICES[job.model] : undefined, u = job.usage;
  if (!rate || !u) return null;
  const cached = u.cachedReadTokens ?? 0;
  if (cached > 0 && rate.cachedReadPerM === undefined) return null;
  // The stored totals do not retain the image/text split, so mixed input cannot be priced from them.
  if (rate.textInputPerM !== undefined && u.inputTokens > 0 && u.textInputTokens === undefined) return null;
  const text = u.textInputTokens ?? 0;
  return (Math.max(0, u.inputTokens - cached - text) * rate.inputPerM + text * (rate.textInputPerM ?? rate.inputPerM)
    + cached * (rate.cachedReadPerM ?? 0) + u.outputTokens * rate.outputPerM) / 1_000_000;
}
