import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JobUsage, PolicyFile } from '@augur/core';
import { account, outputWithReasoning } from '@augur/dispatch-protocol';
import type { JobRecord, RateCard, RouteConfig } from '@augur/dispatch-protocol';

export function usageLedger(jobs: readonly JobRecord[], routes: Record<string, RouteConfig> | null, policy: PolicyFile | null, rates: RateCard, dir: string): JobUsage[] {
  return jobs.filter(j => j.startedAt !== null || j.usage !== null).flatMap(job => {
    const route = routes?.[job.route], label = job.ledger?.model ?? route?.model ?? '';
    const provider = label.split('/')[0] ?? '';
    if (provider !== 'openai-api' && provider !== 'chatgpt') return [];
    const entry = policy?.providers[provider]?.models[label];
    const model = job.served?.model ?? entry?.id ?? (typeof route?.options?.model === 'string' ? route.options.model : label);
    const imagesJob = job.activity === 'generate_images' || job.activity === 'image_to_image';
    let images: number | null = 0;
    if (imagesJob) {
      images = null;
      // Count saved outputs without reading the answer, which can contain a revised prompt.
      if (/^[a-zA-Z0-9-]+$/.test(job.id)) {
        try { images = readdirSync(join(dir, 'jobs', job.id)).filter(name => /^image-[1-9][0-9]*\.(png|jpeg|webp)$/.test(name)).length; }
        catch { /* Retention can remove the output directory before the job row. */ }
      }
    }
    return [{ provider, route: job.route, model, at: job.startedAt ?? job.createdAt, images,
      costUsd: rates[label] ? account({ ...job, usage: job.usage ? { ...job.usage, costUsd: undefined } : null }, label, rates, undefined).costUsd?.value ?? null : null,
      usage: job.usage ? { inputTokens: job.usage.inputTokens, outputTokens: outputWithReasoning(job.usage),
        ...(job.usage.cachedReadTokens !== undefined ? { cachedReadTokens: job.usage.cachedReadTokens } : {}),
        // A generation job sends no pictures, so all of its input is text. An edit job mixes the two and its split is not recorded.
        ...(job.activity === 'generate_images' ? { textInputTokens: job.usage.inputTokens - (job.usage.cachedReadTokens ?? 0) } : {}) } : null }];
  });
}
