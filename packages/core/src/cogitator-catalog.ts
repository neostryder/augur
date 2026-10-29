import type { ActivityId, DataTier, WeightLevel } from './policy.js';
import type { FleetReading } from './fleet.js';
import { obj } from './util.js';

export type CogitatorKind = 'text' | 'vision' | 'embedding' | 'speech-to-text' | 'diarization' | 'humanizer' | 'guard' | 'image generation' | 'assistant';
export interface CogitatorKnowledge {
  uses?: string[];
  strengths?: string;
  limits?: string;
}
export interface CogitatorCatalogEntry extends CogitatorKnowledge {
  id: string;
  kind: CogitatorKind;
  sizeClass: 'small' | 'medium' | 'large' | 'unknown';
  activities: Partial<Record<ActivityId, WeightLevel>>;
  maxDataTier?: DataTier;
}

const general = { summarize_extract: 'often', draft_prose: 'normal', bulk_tagging: 'often', typed_decisions: 'normal', reason_critique: 'normal', read_images: 'often' } as const;
const speech = { transcribe: 'preferred' } as const;

// Sizes without a parameter count and unreported chain orders are unknown. Activity strengths are seed judgments, not benchmark results.
export const COGITATOR_MODELS: readonly CogitatorCatalogEntry[] = [
  { id: 'gemma-4-12b', kind: 'vision', sizeClass: 'large', uses: ['general text', 'image description', 'summarization', 'classification'], strengths: '12B general text and vision.', limits: 'Loading the 12B weights needs more memory than the smaller Gemmas.', activities: general },
  { id: 'gemma-4-12b-it-qat', kind: 'vision', sizeClass: 'large', uses: ['general text', 'image description', 'summarization', 'classification'], strengths: '12B general text and vision with quantized weights.', limits: 'The 12B size still needs more memory than the smaller Gemmas.', activities: general },
  { id: 'gemma-4-e4b-it-qat', kind: 'text', sizeClass: 'small', uses: ['short text', 'summarization', 'classification'], strengths: '4B weights offer a lighter, faster text option.', limits: 'Less capacity than the 12B Gemmas.', activities: { summarize_extract: 'normal', bulk_tagging: 'often', typed_decisions: 'normal', draft_prose: 'occasional' } },
  { id: 'gemma-4-e2b-it-qat', kind: 'text', sizeClass: 'small', uses: ['short text', 'fallback classification'], strengths: '2B weights provide the lightest Gemma fallback.', limits: 'Use as a last link for tasks that need more capacity.', activities: { summarize_extract: 'last_resort', bulk_tagging: 'occasional', typed_decisions: 'last_resort', draft_prose: 'last_resort' } },
  { id: 'gemma-4-12b-uncensored', kind: 'text', sizeClass: 'large', uses: ['unrestricted prose', 'refusal fallback'], strengths: '12B text with unrestricted tone for work the other Gemmas refuse.', limits: 'Internal data only; no sensitive or regulated data.', activities: { draft_prose: 'normal', summarize_extract: 'normal', reason_critique: 'occasional' }, maxDataTier: 'internal' },
  { id: 'mimo-v2.6-distill-qwen-9b', kind: 'text', sizeClass: 'medium', uses: ['reasoning', 'critique'], strengths: '9B reasoning distill.', limits: 'Text reasoning does not establish image or audio support.', activities: { reason_critique: 'often', typed_decisions: 'normal', summarize_extract: 'normal' } },
  { id: 'apple-foundation', kind: 'assistant', sizeClass: 'unknown', uses: ['short text', 'on-device assistance'], strengths: 'On-device text on the Macs.', limits: 'Cannot produce JSON-schema output.', activities: { summarize_extract: 'normal', draft_prose: 'occasional', bulk_tagging: 'occasional' } },
  { id: 'embeddinggemma-2', kind: 'embedding', sizeClass: 'unknown', uses: ['text embeddings', 'semantic retrieval'], strengths: 'Produces 768-dimension text embeddings.', limits: 'Vectors are not prose answers; stored vectors must use the same embedding space.', activities: { embed: 'preferred' } },
  { id: 'qwen3-asr-1.7b', kind: 'speech-to-text', sizeClass: 'small', uses: ['accurate transcription'], strengths: '1.7B speech recognition with an accuracy emphasis.', limits: 'Transcription alone does not identify speakers.', activities: speech },
  { id: 'parakeet-tdt-0.6b-v3', kind: 'speech-to-text', sizeClass: 'small', uses: ['fast transcription'], strengths: '0.6B speech recognition with a speed emphasis.', limits: 'Transcription alone does not identify speakers.', activities: speech },
  { id: 'cohere-transcribe-03-2026', kind: 'speech-to-text', sizeClass: 'unknown', uses: ['transcription'], strengths: 'Speech-to-text transcription.', limits: 'Speaker labeling is not established.', activities: speech },
  { id: 'moss-transcribe-diarize', kind: 'diarization', sizeClass: 'unknown', uses: ['transcription', 'speaker labeling'], strengths: 'Transcribes speech with speaker labels.', limits: 'Speaker labels do not establish a speaker identity.', activities: speech },
  { id: 'laya', kind: 'text', sizeClass: 'unknown', uses: ['typed decisions', 'tagging'], strengths: 'Fine-tuned for typed decisions and tagging; regulated data is allowed when the owner clears it.', limits: 'Specialized decisions and tags do not establish general writing ability.', activities: { typed_decisions: 'preferred', bulk_tagging: 'preferred' } },
  { id: 'humanizer', kind: 'humanizer', sizeClass: 'unknown', uses: ['prose rewriting'], strengths: 'Rewrites prose to sound human.', limits: 'Rewriting does not verify the source facts.', activities: { draft_prose: 'often' } },
  { id: 'prompt-guard', kind: 'guard', sizeClass: 'unknown', uses: ['prompt-injection classification'], strengths: 'Classifies prompt-injection attempts.', limits: 'A classifier result does not guarantee that a prompt is safe.', activities: { moderate: 'preferred' } },
  { id: 'comfyui', kind: 'image generation', sizeClass: 'unknown', uses: ['image generation'], strengths: 'Runs image generation workflows.', limits: 'Available image operations depend on the configured workflow.', activities: { generate_images: 'often' } },
  { id: 'sd-moss-image', kind: 'image generation', sizeClass: 'unknown', uses: ['image generation'], strengths: 'Generates images.', limits: 'Editing and image-to-image support are not established.', activities: { generate_images: 'often' } },
];

export const COGITATOR_ROLES: readonly CogitatorCatalogEntry[] = [
  { id: 'describe', kind: 'vision', sizeClass: 'unknown', uses: ['image description'], strengths: 'Image description with a 12B first link.', limits: 'Available capacity depends on the serving link.', activities: { read_images: 'preferred' } },
  { id: 'judge', kind: 'text', sizeClass: 'unknown', uses: ['short judgments', 'classification'], strengths: 'Short judgments and classification through a fallback chain.', limits: 'Input limit: 24000 characters.', activities: { typed_decisions: 'often', bulk_tagging: 'often', reason_critique: 'normal' } },
  { id: 'summarize', kind: 'text', sizeClass: 'unknown', uses: ['summarization'], strengths: 'Summarizes text through a fallback chain.', limits: 'Input capacity depends on the serving link.', activities: { summarize_extract: 'preferred' } },
  { id: 'embed-gemma2', kind: 'embedding', sizeClass: 'unknown', uses: ['text embeddings'], strengths: 'Routes text embedding requests.', limits: 'Stored vectors must use the same embedding space.', activities: { embed: 'preferred' } },
  { id: 'embed', kind: 'embedding', sizeClass: 'unknown', uses: ['text embeddings'], strengths: 'Routes text embedding requests.', limits: 'Stored vectors must use the same embedding space.', activities: { embed: 'preferred' } },
  { id: 'humanize', kind: 'humanizer', sizeClass: 'unknown', uses: ['prose rewriting'], strengths: 'Routes prose rewriting requests.', limits: 'Rewriting does not verify the source facts.', activities: { draft_prose: 'often' } },
  { id: 'laya', kind: 'text', sizeClass: 'unknown', uses: ['typed decisions', 'tagging'], strengths: 'Routes specialized decisions and tagging.', limits: 'Regulated data still requires owner clearance.', activities: { typed_decisions: 'preferred', bulk_tagging: 'preferred' } },
  { id: 'listen', kind: 'speech-to-text', sizeClass: 'unknown', uses: ['transcription'], strengths: 'Routes speech-to-text requests through a fallback chain.', limits: 'Speed and accuracy depend on the serving link.', activities: speech },
  { id: 'listen-fast', kind: 'speech-to-text', sizeClass: 'unknown', uses: ['fast transcription'], strengths: 'Routes speech-to-text requests with a speed emphasis.', limits: 'Speed and accuracy depend on the serving link.', activities: speech },
  { id: 'transcribe', kind: 'speech-to-text', sizeClass: 'unknown', uses: ['transcription'], strengths: 'Routes speech-to-text requests through a fallback chain.', limits: 'Speed and accuracy depend on the serving link.', activities: speech },
  { id: 'diarize', kind: 'diarization', sizeClass: 'unknown', uses: ['transcription', 'speaker labeling'], strengths: 'Routes transcription with speaker labels.', limits: 'Speaker labels do not establish a speaker identity.', activities: speech },
];

export function cogitatorEntry(id: string, role = false): CogitatorCatalogEntry | undefined {
  return (role ? COGITATOR_ROLES : COGITATOR_MODELS).find(entry => entry.id === id) ?? COGITATOR_ROLES.find(entry => entry.id === id);
}

/** The management metadata shape is kept here while the gateway settles its catalog endpoint. */
export function readCogitatorKnowledge(body: unknown, id: string, role = false, row: unknown = {}): CogitatorKnowledge {
  const doc = obj(body), catalog = obj(doc.catalog ?? doc), rows = catalog[role ? 'roles' : 'models'];
  const listed = Array.isArray(rows) ? rows.map(obj).find(item => (role ? item.name ?? item.id : item.id) === id) : undefined;
  const ledgers = [obj(obj(doc.self).ledger), ...(Array.isArray(doc.peers) ? doc.peers.map(peer => obj(obj(peer).ledger)) : [])];
  const sightings = role ? [] : ledgers.flatMap(ledger => Array.isArray(ledger.models) ? ledger.models.map(obj).filter(item => item.id === id) : []);
  const seed = cogitatorEntry(id, role), knowledge: CogitatorKnowledge = {};
  for (const source of [seed, ...sightings, listed, obj(row)]) {
    if (!source) continue;
    if (Array.isArray(source.uses) && source.uses.every((use: unknown) => typeof use === 'string')) knowledge.uses = [...source.uses];
    if (typeof source.strengths === 'string') knowledge.strengths = source.strengths;
    if (typeof source.limits === 'string') knowledge.limits = source.limits;
  }
  return knowledge;
}

export interface FleetCatalogEntry extends CogitatorKnowledge {
  id: string;
  label: string;
  role: boolean;
  kind?: CogitatorKind;
  sizeClass?: CogitatorCatalogEntry['sizeClass'];
  activities: CogitatorCatalogEntry['activities'];
  chain?: string[];
}

/** Only a live sighting offers an entry; shipping a seed never claims it is installed. */
export function fleetCatalog(fleet: FleetReading): FleetCatalogEntry[] {
  const rows = new Map<string, FleetCatalogEntry>();
  for (const item of [...fleet.machines.flatMap(machine => machine.models.map(model => ({ model, role: false }))), ...fleet.roles.map(model => ({ model, role: true }))]) {
    const id = 'id' in item.model ? item.model.id : item.model.name, seed = cogitatorEntry(id, item.role);
    rows.set(id, { id, label: `cogitator/${id}`, role: item.role, kind: seed?.kind, sizeClass: seed?.sizeClass, activities: { ...seed?.activities },
      ...readCogitatorKnowledge({}, id, item.role, item.model), ...('chain' in item.model ? { chain: [...item.model.chain] } : {}) });
  }
  return [...rows.values()];
}

export interface FleetOffer extends FleetCatalogEntry {
  model: string;
  missingModel: boolean;
  missingRoute: boolean;
}

export function fleetOffers(fleet: FleetReading, models: Array<{ label: string; id: string }>, routeModels: readonly string[]): FleetOffer[] {
  return fleetCatalog(fleet).flatMap(entry => {
    const known = models.filter(model => model.id === entry.id), model = known[0]?.label ?? entry.label;
    const missingModel = !known.length, missingRoute = !routeModels.includes(model) && !known.some(item => routeModels.includes(item.label));
    if (missingModel && models.some(item => item.label === entry.label)) return [];
    return missingModel || missingRoute ? [{ ...entry, model, missingModel, missingRoute }] : [];
  });
}
