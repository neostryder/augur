import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';
import { refreshAliases, type AliasOffer, type AliasRefreshState, type ListedModel, type PolicyFile } from '@augur/core';
import { INBOX_FILE } from '@augur/core';
import { ownerOnly } from './ipc.js';
import { withFileLock } from './file-lock.js';
import { checkAliasPin } from './alias-pins.js';

export const ALIAS_INBOX = 'alias-inbox.jsonl';
export const ALIAS_STATE = 'alias-refresh.json';
export const ALIAS_FLAGS = 'alias-flags.json';
const read = (path: string): string => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

export const withAliasFileLock = withFileLock;

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 }); ownerOnly(tmp, 0o600); renameSync(tmp, path); ownerOnly(path, 0o600);
}

function safeJson<T>(path: string, fallback: T): T {
  const text = read(path);
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch {
    try { writeFileSync(`${path}.bad`, text, { encoding: 'utf8', mode: 0o600 }); } catch { /* preserve refresh availability */ }
    return fallback;
  }
}

const shortReason = (_reason: string | undefined, kind = 'provider'): string => {
  const clean = `${kind} check failed: failed`.replace(/[^\x20-\x7e]/g, '').slice(0, 160);
  return clean;
}

export type ListingSeams = Record<string, (() => Promise<readonly ListedModel[]>) | null>;
export type AliasSmoke = (provider: string, label: string, modelId: string) => Promise<{ status: 'succeeded' | 'failed' | 'untested'; reason?: string }>;
export type AliasEndpointSeam = (provider: string, modelId: string) => Promise<readonly string[] | null>;

export async function refreshAliasFiles(home: string, listings: ListingSeams, onlyLabel?: string, now = new Date(), smoke?: AliasSmoke, endpointListing?: AliasEndpointSeam) {
  mkdirSync(home, { recursive: true });
  const policy = safeJson(join(home, 'policy.json'), { providers: {} } as PolicyFile);
  const statePath = join(home, ALIAS_STATE);
  const prev = withAliasFileLock(statePath, () => safeJson(statePath, {} as Record<string, AliasRefreshState>));
  const needed = Object.entries(policy.providers).filter(([, config]) => Object.values(config.models).some(model => !!model.series)).map(([provider]) => provider);
  const rows: Record<string, readonly ListedModel[] | null> = Object.fromEntries(needed.map(provider => [provider, null]));
  for (const provider of needed) {
    const listing = listings[provider];
    if (!listing) { rows[provider] = null; continue; }
    try { rows[provider] = await listing(); } catch { rows[provider] = null; }
  }
  const result = refreshAliases(policy, rows, prev, now, onlyLabel);
  const inboxPath = join(home, ALIAS_INBOX);
  withAliasFileLock(inboxPath, () => {
    const raw = read(inboxPath);
    if (!raw) return;
    const valid = raw.split(/\r?\n/).filter(Boolean).filter(line => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
    if (valid.length !== raw.split(/\r?\n/).filter(Boolean).length) {
      try { writeFileSync(`${inboxPath}.bad`, raw, { encoding: 'utf8', mode: 0o600 }); } catch { /* keep refresh available */ }
      writeAtomic(inboxPath, valid.length ? `${valid.join('\n')}\n` : '');
    }
  });
  for (const offer of result.offers) {
    const owner = Object.entries(policy.providers).find(([, p]) => p.models[offer.label]);
    const model = owner?.[1].models[offer.label];
    const listed = rows[owner?.[0] ?? ''] ?? [];
    const oldModel = listed.find(x => x.id === offer.from), newModel = listed.find(x => x.id === offer.to);
    const pin = model?.dataHandling?.pinnedHost;
    let endpoints = newModel?.endpoints;
    if (pin && !endpoints?.length && endpointListing) {
      try { const rows = await endpointListing(owner?.[0] ?? '', offer.to); endpoints = rows ? [...rows] : undefined; } catch { endpoints = undefined; }
    }
    const pinCheck = checkAliasPin(pin, offer.to, endpoints);
    if (!pinCheck.ok) { offer.status = 'failed'; offer.reason = pinCheck.reason; continue; }
    const oldKinds = oldModel?.inputModalities, newKinds = newModel?.inputModalities;
    if (oldKinds !== undefined && newKinds !== undefined) {
      const missing = oldKinds.filter(kind => !newKinds.includes(kind));
      if (missing.length) { offer.status = 'failed'; offer.reason = 'new model does not accept current input kinds'; continue; }
    } else (offer.notes ??= []).push('capabilities not compared');
    if (model?.series?.kind === 'image' || model?.series?.kind === 'speech') { offer.notes = [...(offer.notes ?? []), `not smoke-tested: ${model.series.kind}`]; offer.tested = false; continue; }
    if (!smoke) { offer.notes = [...(offer.notes ?? []), 'not smoke-tested: smoke runner unavailable']; offer.tested = false; continue; }
    let checked: Awaited<ReturnType<AliasSmoke>>;
    try { checked = await smoke(owner?.[0] ?? '', offer.label, offer.to); }
    catch (error) { checked = { status: 'failed', reason: (error as Error).message || 'smoke job failed' }; }
    if (checked.status === 'failed') { offer.status = 'failed'; offer.reason = shortReason(checked.reason, 'smoke'); }
    else if (checked.status === 'untested') { offer.notes = [...(offer.notes ?? []), `not smoke-tested: ${checked.reason ?? 'rule'}`]; offer.tested = false; }
    else offer.tested = true;
  }
  const flagsPath = join(home, ALIAS_FLAGS);
  withAliasFileLock(flagsPath, () => {
    const oldFlags = safeJson(flagsPath, [] as typeof result.flags);
    const flags = [...result.flags.filter(x => !oldFlags.some(y => y.label === x.label && y.id === x.id)), ...oldFlags];
    writeAtomic(flagsPath, JSON.stringify(flags, null, 2) + '\n');
  });
  if (result.offers.length) {
    withAliasFileLock(inboxPath, () => {
      const old = read(inboxPath).split(/\r?\n/).filter(Boolean);
      const parsed = old.flatMap((line, index) => { try { return [{ index, offer: JSON.parse(line) as AliasOffer }]; } catch { try { writeFileSync(`${inboxPath}.bad`, line + '\n', 'utf8'); } catch { /* keep going */ } return []; } });
      const fresh = result.offers.filter(offer => !parsed.some(x => x.offer.label === offer.label && x.offer.to === offer.to));
      if (fresh.length) {
        const superseded = new Set(fresh.map(x => x.label));
        const keep = parsed.map(x => x.offer.label && superseded.has(x.offer.label) && x.offer.status === 'pending' && fresh.some(n => n.label === x.offer.label && n.to !== x.offer.to) ? JSON.stringify({ ...x.offer, status: 'superseded' }) : old[x.index]);
        writeAtomic(inboxPath, `${[...keep, ...fresh.map(x => JSON.stringify(x))].join('\n')}\n`);
      }
    });
  }
  withAliasFileLock(statePath, () => {
    const latest = safeJson(statePath, {} as Record<string, AliasRefreshState>);
    writeAtomic(statePath, JSON.stringify({ ...latest, ...result.state }, null, 2) + '\n');
  });
  if (result.flags.length) {
    const alertPath = join(home, 'alerts.json');
    let feed: { schema: number; generatedAt: string; alerts: Array<Record<string, unknown>> } = { schema: 1, generatedAt: now.toISOString(), alerts: [] };
    try { feed = JSON.parse(read(alertPath)) as typeof feed; } catch { /* the feed will be created */ }
    for (const flag of result.flags) if (!feed.alerts.some(a => a.id === `alias-embed-${flag.label}-${flag.id}`)) feed.alerts.unshift({ id: `alias-embed-${flag.label}-${flag.id}`, kind: 'models', severity: 'info', title: `Embedding model update: ${flag.label}`, body: flag.message, raisedAt: flag.createdAt, outlets: ['augur'], clears: { when: 'flag', flag: 'models' } });
    feed.generatedAt = now.toISOString();
    feed.alerts = feed.alerts.slice(0, 50);
    writeAtomic(alertPath, JSON.stringify(feed, null, 2) + '\n');
  }
  return result;
}

export function readAliasOffers(home: string): AliasOffer[] {
  return read(join(home, ALIAS_INBOX)).split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as AliasOffer]; } catch { return []; } });
}
export function readAliasFlags(home: string) { try { return JSON.parse(readFileSync(join(home, ALIAS_FLAGS), 'utf8')) as Array<{ label: string; id: string; message: string; createdAt: string }>; } catch { return []; } }

export function settleAliasOffer(home: string, label: string, accept: boolean, now = new Date(), decisionDir = dataDir(), untested = false): { ok: true; offer: AliasOffer; warnings?: string[] } | { ok: false; error: string } {
  const inboxPath = join(home, ALIAS_INBOX);
  let offer: AliasOffer | undefined;
  try { offer = withAliasFileLock(inboxPath, () => readAliasOffers(home).find(o => o.id === label)); } catch { return { ok: false, error: 'The alias inbox is busy. The offer is still pending.' }; }
  if (!offer) return { ok: false, error: 'No pending alias offer has that id.' };
  if (accept && offer.status === 'failed') return { ok: false, error: 'A failed offer cannot be accepted.' };
  if (accept && offer.tested !== true && !untested) return { ok: false, error: 'This offer was not smoke-tested. Pass --untested to accept it.' };
  if (accept && offer.status !== 'pending') return { ok: false, error: 'No pending alias offer has that id.' };
  let policy: PolicyFile;
  try { policy = JSON.parse(readFileSync(join(home, 'policy.json'), 'utf8')) as PolicyFile; } catch { return { ok: false, error: 'The policy file is unavailable. Open Augur and save the model rules before accepting this offer.' }; }
  const owner = Object.entries(policy.providers).find(([, p]) => p.models[offer.label]);
  if (!owner) return { ok: false, error: 'The model label no longer exists.' };
  if (accept && owner[1].models[offer.label]!.id !== offer.from) {
    try { withAliasFileLock(inboxPath, () => { const offers = readAliasOffers(home); writeAtomic(inboxPath, offers.map(o => JSON.stringify(o.id === offer!.id ? { ...o, status: 'stale' } : o)).join('\n') + '\n'); }); }
    catch { return { ok: false, error: 'The offer is stale, but the alias inbox could not be updated.' }; }
    return { ok: false, error: `The policy now names ${owner[1].models[offer.label]!.id}; refresh to get a current offer.` };
  }
  if (accept) {
    const [provider] = owner, inbox = join(home, INBOX_FILE);
    try {
      mkdirSync(home, { recursive: true });
      appendFileSync(inbox, JSON.stringify({ id: `${now.toISOString()}-${process.pid}-${Math.random().toString(16).slice(2)}`, at: now.toISOString(), by: 'augur owner', provider, model: offer.label, field: 'id', value: offer.to }) + '\n', { encoding: 'utf8', mode: 0o600 });
      ownerOnly(inbox, 0o600);
    } catch { return { ok: false, error: 'The owner edit could not be queued. The offer is still pending.' }; }
    const routesPath = join(home, 'dispatch', 'routes.json');
    let routes: { routes?: Record<string, { model?: string; options?: Record<string, unknown> }> };
    try { routes = JSON.parse(readFileSync(routesPath, 'utf8')); } catch { return { ok: false, error: 'routes.json could not be read. The policy edit is queued; the offer is still pending.' }; }
    const warnings: string[] = [];
    for (const [name, route] of Object.entries(routes.routes ?? {})) {
      if (route.model !== offer.label) continue;
      if (route.options?.model === offer.from) route.options.model = offer.to;
      else if (typeof route.options?.model === 'string') warnings.push(`route ${name} still names ${route.options.model}; change it yourself`);
    }
    try { writeAtomic(routesPath, JSON.stringify(routes, null, 2) + '\n'); } catch { return { ok: false, error: 'routes.json could not be written. The policy edit is queued; the offer is still pending.' }; }
    try { mkdirSync(decisionDir, { recursive: true }); appendFileSync(join(decisionDir, 'decisions.jsonl'), JSON.stringify({ kind: 'alias_swap', label: offer.label, from: offer.from, to: offer.to, at: now.toISOString() }) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch { /* the decision record is best effort */ }
    return removeSettledOffer(home, offer, warnings);
  }
  return removeSettledOffer(home, offer, []);
}

function removeSettledOffer(home: string, offer: AliasOffer, warnings: string[]) {
  const path = join(home, ALIAS_INBOX);
  try { withAliasFileLock(path, () => { const offers = readAliasOffers(home); writeAtomic(path, offers.filter(o => o.id !== offer.id).map(o => JSON.stringify(o)).join('\n') + (offers.length > 1 ? '\n' : '')); }); }
  catch { return { ok: false as const, error: 'The alias inbox could not be updated. The offer is still pending.' }; }
  return { ok: true as const, offer, ...(warnings.length ? { warnings } : {}) };
}
