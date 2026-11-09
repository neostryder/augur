import type { JobUsage, ProviderResult } from './types.js';
import { imageCost, OPENAI_IMAGE_PRICES } from './openai-prices.js';

export const OPENAI_USAGE_TEXT = {
  name: 'OpenAI API',
  web: 'Read OpenAI billing page',
  webHelp: "Read the platform.openai.com billing page to show your organization's spend this month and the Monthly budget bar.",
  budget: 'Monthly budget',
  budgetHelp: "Your organization's monthly spending budget in US dollars. Leave empty for $250.",
  signin: 'Sign in to platform.openai.com',
  signinHelp: 'Augur uses this sign-in to open your OpenAI billing page.',
  signInNote: 'Not signed in. Sign in to platform.openai.com in Settings to load billing figures.',
  challengeNote: 'A Cloudflare check is blocking the billing page. Open the billing page from Settings and pass the check.',
  missingNote: 'The billing page showed no spend figure. Open it from settings and check that you are signed in.',
  unavailableNote: 'The local job ledger is not available in this view.',
  credit: 'API credit left',
  promo: 'Promotional credit',
  spend: 'Spent this month (organization)',
  activity: (calls: number, tokens: number) => `${calls.toLocaleString()} request${calls === 1 ? '' : 's'}, ${tokens.toLocaleString()} tokens, last 7 days`,
  ends: (date: string) => `Ends ${date}`,
  periods: { today: 'Today', week: 'Last 7 days', month: 'Month to date' },
  estimate: (label: string) => `${label}, estimated cost`,
  counts: (label: string, calls: number, input: number, output: number, images: number | null) =>
    `${label ? `${label}: ` : ''}${calls.toLocaleString()} call${calls === 1 ? '' : 's'}, ${input.toLocaleString()} input tokens, ${output.toLocaleString()} output tokens${images === null ? '' : `, ${images.toLocaleString()} image${images === 1 ? '' : 's'}`}`,
  model: (model: string, counts: string, cost: string) => `${model}, month to date: ${counts}${cost}`,
  cost: (value: number) => `, estimated $${value.toFixed(5)}`,
  unpriced: (count: number) => `Calls with no cost estimate: ${count.toLocaleString()}. Estimates cover priced calls only.`,
  imagePricing: 'Image edit jobs have no cost estimate because Augur does not record the split between text and image input.',
  chatgpt: (count: number) => `Includes ChatGPT chat jobs run through Augur: ${count.toLocaleString()} in the last 7 days`,
} as const;

export interface UsageTotal {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  images: number | null;
  costUsd: number | null;
  costCalls: number;
  estimated: true;
}

export function openaiLedger(jobs: readonly JobUsage[], now: Date): ProviderResult {
  const end = now.getTime(), day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime(), week = end - 7 * 86400000;
  const rows = jobs.filter(j => j.provider === 'openai-api' && j.at <= end);
  const sum = (items: readonly JobUsage[]): UsageTotal => {
    const total: UsageTotal = { calls: items.length, inputTokens: 0, outputTokens: 0, images: 0, costUsd: items.length ? null : 0, costCalls: 0, estimated: true };
    for (const job of items) {
      total.inputTokens += job.usage?.inputTokens ?? 0;
      total.outputTokens += job.usage?.outputTokens ?? 0;
      if (job.images === null) total.images = null;
      else if (total.images !== null) total.images += job.images;
      const cost = Object.hasOwn(OPENAI_IMAGE_PRICES, job.model) ? imageCost(job) : job.costUsd;
      if (cost !== null) { total.costUsd = (total.costUsd ?? 0) + cost; total.costCalls++; }
    }
    return total;
  };
  const periods = { today: sum(rows.filter(j => j.at >= day)), week: sum(rows.filter(j => j.at >= week)), month: sum(rows.filter(j => j.at >= month)) };
  const models = Object.fromEntries([...new Set(rows.filter(j => j.at >= month).map(j => j.model))].sort()
    .map(model => [model, sum(rows.filter(j => j.at >= month && j.model === model))]));
  return { meters: [], money: [],
    notes: { openaiLedger: { periods, models }, openaiImagePricingUnknown: rows.some(j => j.at >= month && Object.hasOwn(OPENAI_IMAGE_PRICES, j.model) && OPENAI_IMAGE_PRICES[j.model]!.textInputPerM !== undefined && j.usage && j.usage.inputTokens > 0 && j.usage.textInputTokens === undefined) } };
}
