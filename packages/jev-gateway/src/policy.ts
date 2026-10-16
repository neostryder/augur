// What the gateway does with one request: which route answers it, which model name goes upstream, and which Danger Zone headers it needs. Pure.
import { DATA_TIERS, termRegex } from '@augur/core';
import { privateTerms } from '@augur/decision';
import type { DataTier } from '@augur/core';
import { HOSTED_TIERS } from './config.js';
import type { GatewayConfig } from './config.js';

export type Route = 'hosted' | 'laya';

/** The content check for a request that names no tier. It is a backstop for student data and matches only unmistakable terms, because everyday words such as course, rubric, or grade also appear in ordinary text and sent it to Laya wrongly. A caller handling student data declares the tier. */
const CONTENT_BASE = 'students?|ferpa|roster';
/** The matcher for one config: the everyday words above, the config's `contentTerms`, and the terms in `private-terms.json`. */
export const contentRegex = (extra: readonly string[] = []): RegExp => termRegex(CONTENT_BASE, [...extra, ...privateTerms()]);

export interface Plan {
  route: Route;
  tier: DataTier;
  /** Where the tier came from: the caller's header, or the gateway (the default, or the content check). */
  tierSource: 'declared' | 'default' | 'content';
  /** The model name sent to the route. */
  model: string;
  images: boolean;
  longContext: boolean;
  /** The body to send on, with the model replaced and gateway-only fields removed. */
  body: Record<string, unknown>;
  /** Set when the request cannot be answered anywhere. */
  refuse?: { status: number; detail: string };
}

export const TIER_HEADER = 'x-augur-data';
export const IMAGES_HEADER = 'TypeSafe-Danger-Zone-Images';
export const LONG_HEADER = 'TypeSafe-Danger-Zone-Long-Context';

/** The tier a caller declared. `local_only` is the strictest tier (regulated): the request never leaves the hardware the person controls. */
export function declaredTier(value: string | undefined): DataTier | null | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase().replace(/-/g, '_');
  if (v === 'local_only') return 'regulated';
  return (DATA_TIERS as readonly string[]).includes(v) ? v as DataTier : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether a request carries an image or asks a Box question, which is what the images header opts into. */
export function usesImages(body: Record<string, unknown>): boolean {
  if (isObject(body.assets) && Object.keys(body.assets).length) return true;
  return isObject(body.questions) && Object.values(body.questions).some(q => isObject(q) && q.type === 'box');
}

export function plan(config: GatewayConfig, body: unknown, headers: Record<string, string | undefined>): Plan {
  const fail = (status: number, detail: string): Plan => ({ route: 'hosted', tier: config.defaultTier, tierSource: 'default', model: config.model, images: false, longContext: false, body: {}, refuse: { status, detail } });
  if (!isObject(body)) return fail(400, 'The request body must be a JSON object.');
  const declared = declaredTier(headers[TIER_HEADER]);
  if (declared === null) return fail(400, `${TIER_HEADER} must be one of ${DATA_TIERS.join(', ')}, or local_only.`);

  let tier: DataTier, tierSource: Plan['tierSource'];
  if (declared) { tier = declared; tierSource = 'declared'; }
  else if (contentRegex(config.contentTerms).test(JSON.stringify(body.state ?? ''))) { tier = 'regulated'; tierSource = 'content'; }
  else { tier = config.defaultTier; tierSource = 'default'; }

  const images = usesImages(body);
  const longContext = headers[LONG_HEADER.toLowerCase()]?.toLowerCase() === 'true' || headers['x-augur-long-context']?.toLowerCase() === 'true' || body.long_context === true;
  const requested = typeof body.model === 'string' ? body.model.trim() : '';
  const { long_context: _drop, ...rest } = body;

  const wantsLaya = /^laya(:|$)/.test(requested);
  const hostedOk = HOSTED_TIERS.includes(tier);
  if (wantsLaya || !hostedOk) {
    // A request that must stay local, or that asks for Laya, is answered by Laya or not at all. It is never sent to the hosted model.
    if (images) return fail(422, 'Laya takes text only, and this request carries an image or a Box question. Laya answers this request or nothing does.');
    if (longContext && !hostedOk) return fail(422, 'The long-context option is hosted only, and Laya answers this request or nothing does.');
    return { route: 'laya', tier, tierSource, model: wantsLaya ? requested : config.layaModel, images, longContext, body: { ...rest, model: wantsLaya ? requested : config.layaModel } };
  }
  const model = requested && config.pins.includes(requested) ? requested : config.model;
  return { route: 'hosted', tier, tierSource, model, images, longContext, body: { ...rest, model } };
}
