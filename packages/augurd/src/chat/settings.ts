// The settings a hosted chat model offers, in the shape Cogitator's capabilities document uses for local ones, and the code that turns a person's
// settings into request fields. Only a setting the person changed is ever sent; a model's own default is never overridden by Augur's guess.
import type { ChatSettingDef, ChatShape } from '@augur/dispatch-protocol';

const SYSTEM: ChatSettingDef = {
  key: 'system', label: 'System prompt', type: 'text', default: '', via: 'messages[system]',
  tooltip: 'Instructions the model reads before anything else in the chat, such as "answer in Spanish" or "you are a patient tutor". Use it for anything you would otherwise repeat in every message.',
};
const TEMPERATURE = (max: number): ChatSettingDef => ({
  key: 'temperature', label: 'Randomness (temperature)', type: 'number', min: 0, max, step: 0.05,
  tooltip: 'How much chance goes into each word. Keep it low for facts and code, where you want the same answer each time. Raise it for stories or brainstorming, but very high values make a reply wander off. Adjust this or top P, not both.',
});
const TOP_P: ChatSettingDef = {
  key: 'top_p', label: 'Word choice cutoff (top P)', type: 'number', min: 0, max: 1, step: 0.01,
  tooltip: 'Each next word comes only from the likeliest candidates, whose chances add up to this share. 1 rules nothing out, and 0.5 keeps only the top half of the odds, so the wording turns safer and plainer. Adjust this or temperature, not both.',
};
const MAX_TOKENS: ChatSettingDef = {
  key: 'max_tokens', label: 'Reply length limit', type: 'integer', min: 1,
  tooltip: 'Caps how long a reply can get, counted in tokens (a token is a short word or part of a longer one). A reply that hits the cap stops mid-sentence, so raise it for long documents or code, and lower it to keep replies short and cheap.',
};

export const OPENAI_SETTINGS: ChatSettingDef[] = [
  SYSTEM, TEMPERATURE(2), TOP_P, MAX_TOKENS,
  { key: 'reasoning_effort', label: 'Reasoning effort', type: 'choice', choices: ['low', 'medium', 'high'], advanced: true,
    tooltip: 'How long a reasoning model thinks before it answers. Set it high for hard math or tricky code, where the extra time and cost pay off, and low for quick questions. A model that does not reason ignores this or answers with an error.' },
  { key: 'presence_penalty', label: 'New topics (presence penalty)', type: 'number', min: -2, max: 2, step: 0.1, advanced: true,
    tooltip: 'Any word that has already appeared, even once, becomes a little less likely to come up again. Raise it to push the model toward new subjects, or lower it below 0 to keep it close to what has been said.' },
  { key: 'frequency_penalty', label: 'Less repetition (frequency penalty)', type: 'number', min: -2, max: 2, step: 0.1, advanced: true,
    tooltip: 'A word gets less likely the more times it has already appeared. Raise it when replies keep repeating the same phrases; unlike the presence penalty, it leaves the topic alone. Below 0 it allows more repetition.' },
  { key: 'seed', label: 'Repeatable replies (seed)', type: 'integer', min: 0, advanced: true,
    tooltip: 'Pins the randomness to a number you pick. Send the same message again with the same seed and settings and you get the same reply, as far as the provider supports it. Leave it empty for a fresh reply each time.' },
  { key: 'stop', label: 'Stop phrases', type: 'text_list', max_items: 4, advanced: true,
    tooltip: 'The reply ends as soon as the model would write one of these, and the phrase itself is left out. Use it to cut a reply off at a marker such as END or ###. Up to four, one per line.' },
];

export const ANTHROPIC_SETTINGS: ChatSettingDef[] = [
  SYSTEM, TEMPERATURE(1), TOP_P, { ...MAX_TOKENS, default: 4096 },
  { key: 'top_k', label: 'Word choice count (top K)', type: 'integer', min: 0, max: 500, step: 1, advanced: true,
    tooltip: 'Each next word comes only from this many of the likeliest candidates. At 1 the model always takes its single likeliest word, and larger numbers leave room for unusual ones. Temperature does a similar job and is easier to judge.' },
  { key: 'stop_sequences', label: 'Stop phrases', type: 'text_list', max_items: 4, advanced: true,
    tooltip: 'The reply ends as soon as the model would write one of these, and the phrase itself is left out. Use it to cut a reply off at a marker such as END or ###. Up to four, one per line.' },
];

export const defaultSettings = (shape: ChatShape): ChatSettingDef[] => (shape === 'anthropic' ? ANTHROPIC_SETTINGS : OPENAI_SETTINGS).map(s => ({ ...s }));

/** Reads a settings list out of a Cogitator capabilities document entry, dropping anything malformed. */
export function settingsFromDocument(list: unknown): ChatSettingDef[] {
  if (!Array.isArray(list)) return [];
  const types = new Set(['number', 'integer', 'boolean', 'text', 'text_list', 'choice']);
  const out: ChatSettingDef[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.key) || typeof s.label !== 'string' || typeof s.type !== 'string' || !types.has(s.type)) continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    out.push({
      key: s.key, label: s.label, type: s.type as ChatSettingDef['type'], ...(s.default !== undefined && s.default !== null ? { default: s.default } : {}),
      ...(num(s.min) !== undefined ? { min: num(s.min) } : {}), ...(num(s.max) !== undefined ? { max: num(s.max) } : {}), ...(num(s.step) !== undefined ? { step: num(s.step) } : {}),
      ...(num(s.max_items) !== undefined ? { max_items: num(s.max_items) } : {}),
      ...(Array.isArray(s.choices) ? { choices: s.choices.filter((c): c is string => typeof c === 'string') } : {}),
      ...(s.advanced === true ? { advanced: true } : {}), tooltip: typeof s.tooltip === 'string' ? s.tooltip : '',
      ...(typeof s.via === 'string' ? { via: s.via } : {}),
    });
  }
  return out;
}

const clamp = (v: number, def: ChatSettingDef): number => Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, v));

/** The value a setting takes once checked against its definition, or undefined when it is empty or does not fit. */
export function cleanValue(def: ChatSettingDef, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  switch (def.type) {
    case 'number': { const n = Number(value); return Number.isFinite(n) ? clamp(n, def) : undefined; }
    case 'integer': { const n = Number(value); return Number.isFinite(n) ? clamp(Math.trunc(n), def) : undefined; }
    case 'boolean': return value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
    case 'choice': return typeof value === 'string' && (def.choices ?? []).includes(value) ? value : undefined;
    case 'text': return typeof value === 'string' && value.trim() ? value : undefined;
    case 'text_list': {
      const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : []).filter((x): x is string => typeof x === 'string' && x !== '');
      return list.length ? list.slice(0, def.max_items ?? 8) : undefined;
    }
  }
}

/** Keeps the keys the model offers, with checked values. A key the model does not offer is dropped. */
export function cleanSettings(defs: ChatSettingDef[], settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const v = cleanValue(def, settings[def.key]);
    if (v !== undefined) out[def.key] = v;
  }
  return out;
}

/** Sets `value` at a dotted path inside `body`, creating the objects on the way. */
function setPath(body: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let at = body;
  for (const p of parts.slice(0, -1)) {
    const next = at[p];
    at = typeof next === 'object' && next !== null && !Array.isArray(next) ? next as Record<string, unknown> : (at[p] = {}) as Record<string, unknown>;
  }
  at[parts.at(-1)!] = value;
}

/** Puts each setting in the request body. The system prompt is returned, not placed, because where it goes depends on the API. */
export function applySettings(defs: ChatSettingDef[], settings: Record<string, unknown>, body: Record<string, unknown>): { system: string } {
  let system = '';
  const clean = cleanSettings(defs, settings);
  for (const def of defs) {
    const v = clean[def.key];
    if (v === undefined) continue;
    if (def.key === 'system' || def.via === 'messages[system]') { system = String(v); continue; }
    setPath(body, def.via ?? def.key, v);
  }
  return { system };
}
