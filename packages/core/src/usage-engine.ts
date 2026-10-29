// The engine behind every Augur view. It reads the providers on their schedules, keeps history, raises alerts, syncs with a paired phone,
// writes the usage and policy files, reads model lists, applies agents' rule edits and keeps the Claude installs current. The window app
// and the terminal app only show its state and send it commands, so the same work runs whether or not a window is open.
import { FeedKeeper, UPDATE_ALERT_TEXT, type KeeperShell, type Raise } from './feed-keeper.js';
import { createPairing, pairingUrl, pullPhoneState, pullRules, pushRules, pushSnapshot, readAsk, sharedConfig, SyncUploadError } from './sync.js';
import { feedFor, feedFromUsage, type AlertFeed } from './feed.js';
import { RULES_ONLY_PROVIDERS, addModels, emptyPolicy, mergePolicy, policyDigest, policyFromFile, policyPathFor, buildPolicyFile } from './policy.js';
import { genericProvider } from './generic.js';
import { beginLogin, completeLogin, forgetAccess, isSignInProvider, ownSession, sessionSecretName, signInProviders, type LoginStart, type PendingLogin } from './signin.js';
import { importPolicy } from './policy-import.js';
import { DEFAULT_APPROVAL, emptyEditState, parseEditState, parseInbox, processInbox, resolveHeld, upgradeStoredBalance, INBOX_FILE, RESULTS_FILE, type EditState } from './policy-edits.js';
import { listDue, syncModelList, type ModelCatalog } from './models.js';
import { releaseChanges, type ReleaseChanges } from './changelog.js';
import { defaultConfig, migrateConfig } from './config.js';
import { summaryLine } from './summary.js';
import {
  allPlugins, appendHistoryRows, collectFor, detectProvider, dueFor, pendingCount, policyProviders, requiredSecrets, secretNames, syncProviderList, usageAlerts,
} from './registry.js';
import { detectResets, resetPattern, type ResetEvent } from './resets.js';
import type { HistoryRow } from './history.js';
import type { ClaudeStatus, ClaudeTarget, Shell, UpdateInfo } from './shell.js';
import type { AppConfig, ProviderAdded, ProviderAddition, ProviderPlugin, Snapshot } from './types.js';

// Each push is one KV write on the relay, so a paired phone gets a new copy at most every 10 minutes (144 writes a day).
const SYNC_PUSH_MS = 10 * 60_000;
// A refresh by hand uploads at once, up to once a minute, which matches the relay's own limit.
const FORCED_PUSH_MS = 60_000;
// Matches the shortest refresh interval a provider can have.
const TICK_MS = 15_000;
const ASK_CHECK_MS = 60_000;
const EDIT_CHECK_MS = 30_000;
// Rules are compared with the paired device's at most once a minute, and a local edit starts a comparison a few seconds after it.
const RULES_SYNC_MS = 60_000;
const RULES_EDIT_DELAY_MS = 4_000;
const UPDATE_FIRST_CHECK_MS = 20_000;
const UPDATE_INTERVAL_MS = 5 * 60_000;
/** The usage file turned on for the Claude Code mod when no export path is set, under the home folder. */
export const DEFAULT_EXPORT = '.augur/usage.json';
const CHANGELOG_URL = (version: string) => `https://raw.githubusercontent.com/neostryder/augur/v${version}/CHANGELOG.md`;

export interface UpdateState {
  version: string | null;
  status: 'idle' | 'checking' | 'current' | 'available' | 'installing' | 'error';
  available: UpdateInfo | null;
  /** What the available update brings, newest release first; null until the changelog has loaded. */
  changes: ReleaseChanges[] | null;
}

/** What the engine needs from the machine it runs on. The window app's shell has all of it, and augurd builds the same from Node. */
export type EngineShell = KeeperShell & Pick<Shell, 'loadConfig' | 'saveConfig' | 'deleteSecret' | 'hasSecret' | 'loadSnapshot' | 'saveSnapshot' | 'loadHistory'
  | 'saveHistory' | 'loadResets' | 'appendResets' | 'loadAlertState' | 'saveAlertState' | 'loadModelCatalog' | 'saveModelCatalog' | 'exportSnapshot' | 'claudeStatus' | 'claudeInstall'
  | 'claudeRemove' | 'checkUpdate' | 'appVersion'>;

export interface EngineOptions {
  /** The hosted relay and phone app, used until the user sets their own. */
  hosted: string;
  /** Who is asking for edits in the policy history: always the desktop side. */
  device?: string;
}

export interface EngineState {
  config: AppConfig;
  snapshot: Snapshot | null;
  history: HistoryRow[];
  resets: ResetEvent[];
  feed: AlertFeed;
  catalog: ModelCatalog;
  /** Providers whose model list is being read right now. */
  listing: string[];
  editState: EditState;
  /** False until the edit results file has been read, so a held change is not cleared before it is known. */
  editLoaded: boolean;
  /** Set while the last policy.json write failed. Agents keep enforcing the older file until a write succeeds. */
  policyError: string | null;
  busy: boolean;
  /** Names of the provider keys that are stored. */
  secrets: string[];
  claude: ClaudeStatus | null;
  claudeError: string;
  update: UpdateState;
  firstRun: boolean;
}

export type EngineKey = keyof EngineState;

/** Every command a view can send. Each takes JSON arguments and resolves to a JSON value. */
export interface EngineCommands {
  /** force refreshes every provider now, or only those listed in `only`; otherwise each waits out its own interval. */
  refresh(force?: boolean, only?: string[]): Promise<void>;
  /** Reads again the providers that need a sign-in, once a sign-in window shows a signed-in page. */
  refreshSignIns(): Promise<void>;
  /** A view came to the front: compare rules, look for agent edits, and refresh when the numbers are over a minute old. */
  viewShown(): Promise<void>;
  /** Saves the whole config. Rules merge field by field with the engine's copy, so an edit elsewhere is kept; the rest is replaced. */
  saveConfig(config: AppConfig): Promise<void>;
  /** Ends first-run setup with the config the view built. */
  finishSetup(config: AppConfig): Promise<void>;
  dismiss(ids: string[]): Promise<void>;
  /** Stores a provider key and turns the provider on. */
  setProviderKey(provider: string, key: string, value: string): Promise<void>;
  setSecret(name: string, value: string): Promise<void>;
  /**
   * Adds a provider for a route to point at: its models by hand (unreviewed, so they wait for the owner's rules), a usage reading when it has one, or a
   * built-in provider turned on. A provider id already taken by a built-in or a custom reading is refused, and nothing changes.
   */
  addProvider(input: ProviderAddition): Promise<ProviderAdded>;
  deleteSecret(name: string): Promise<void>;
  hasSecret(name: string): Promise<boolean>;
  setClaude(target: ClaudeTarget, on: boolean): Promise<void>;
  /** Reads one provider's model list now. */
  listModels(provider: string): Promise<void>;
  answerEdit(id: string, accept: boolean): Promise<void>;
  retryPolicy(): Promise<void>;
  /** Starts pairing a phone and returns the link the phone opens. */
  pair(): Promise<string>;
  /** The link for the current pairing, to show its code again; null when not paired. */
  pairUrl(): Promise<string | null>;
  unpair(): Promise<void>;
  checkUpdate(): Promise<void>;
  /** Marks the update as installing, or back to available when the install failed. */
  setInstalling(on: boolean): Promise<void>;
  /** Starts Augur's own sign-in to a provider that has one and returns the link to open on any device. */
  signInBegin(provider: string): Promise<LoginStart>;
  /** Finishes the sign-in `signInBegin` started. Claude takes the pasted code; Codex takes none and answers `done: false` until the code was approved. */
  signInComplete(id: string, input?: string): Promise<{ done: boolean }>;
  /** Forgets the sign-in Augur holds for a provider. The provider's own CLI login is left alone. */
  signOut(provider: string): Promise<void>;
  /** Which login each sign-in provider reads now: Augur's own, the CLI's, or none. */
  signInStatus(): Promise<Record<string, 'own' | 'cli' | null>>;
}

export const ENGINE_COMMANDS = ['refresh', 'refreshSignIns', 'viewShown', 'saveConfig', 'finishSetup', 'dismiss', 'setProviderKey', 'setSecret', 'addProvider', 'deleteSecret',
  'hasSecret', 'setClaude', 'listModels', 'answerEdit', 'retryPolicy', 'pair', 'pairUrl', 'unpair', 'checkUpdate', 'setInstalling',
  'signInBegin', 'signInComplete', 'signOut', 'signInStatus'] as const satisfies ReadonlyArray<keyof EngineCommands>;
export type EngineCommand = (typeof ENGINE_COMMANDS)[number];

/** What a view holds: the engine's state, a way to hear which parts changed, and the commands. */
export interface EngineApi extends EngineCommands {
  readonly state: EngineState;
  onChange(listener: (keys: EngineKey[]) => void): () => void;
}

export class UsageEngine implements EngineApi {
  readonly state: EngineState;
  private keeper!: FeedKeeper;
  private alertState: Record<string, unknown> = {};
  private failedRefresh = new Set<string>();
  private listeners = new Set<(keys: EngineKey[]) => void>();
  private timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private lastPush = 0;
  private pushRetry: ReturnType<typeof setTimeout> | undefined;
  /** Relay time of the phone's latest refresh request that has been seen; null until the first check. */
  private askSeen: number | null = null;
  private lastAskCheck = 0;
  private lastPhoneCheck = 0;
  private rulesTimer: ReturnType<typeof setTimeout> | undefined;
  private rulesSyncing = false;
  private lastRulesSync = 0;
  private checkingEdits = false;
  private readonly device: string;
  private logins = new Map<string, PendingLogin>();
  private loadedResets: ResetEvent[] = [];
  private pendingResets: ResetEvent[] = [];
  private resetAppend: Promise<void> = Promise.resolve();

  constructor(private shell: EngineShell, private options: EngineOptions) {
    this.device = options.device ?? 'desktop';
    this.state = {
      config: defaultConfig(), snapshot: null, history: [], resets: [], feed: { schema: 1, generatedAt: new Date(0).toISOString(), alerts: [] }, catalog: {}, listing: [],
      editState: emptyEditState(), editLoaded: false, policyError: null, busy: false, secrets: [], claude: null, claudeError: '',
      update: { version: null, status: 'idle', available: null, changes: null }, firstRun: false,
    };
  }

  onChange(listener: (keys: EngineKey[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(...keys: EngineKey[]): void {
    for (const l of this.listeners) { try { l(keys); } catch { /* a view's error stays in the view */ } }
  }

  private get config(): AppConfig { return this.state.config; }
  private get sync(): NonNullable<AppConfig['sync']> | null { return this.config.sync ?? null; }
  private relay(): string { return this.sync?.relay || this.options.hosted; }
  private pwaUrl(): string { return this.sync?.pwaUrl || this.options.hosted; }
  private pluginMap(): Map<string, ProviderPlugin> { return new Map(allPlugins(this.config).map((p) => [p.id, p])); }

  async start(): Promise<void> {
    const saved = await this.shell.loadConfig();
    this.state.config = migrateConfig(saved ?? defaultConfig());
    syncProviderList(this.state.config);
    this.state.firstRun = !saved;
    await this.importRulesOnce();
    const [snapshot, history, alertState] = await Promise.all([this.shell.loadSnapshot(), this.shell.loadHistory() as Promise<HistoryRow[]>, this.shell.loadAlertState()]);
    this.state.snapshot = snapshot;
    this.state.history = history;
    await this.loadResets();
    this.alertState = alertState;
    this.state.catalog = (await this.shell.loadModelCatalog?.().catch(() => null)) ?? {};
    this.keeper = new FeedKeeper(this.shell, () => this.config, () => new URL(this.pwaUrl()).origin);
    await this.keeper.load();
    this.state.feed = this.keeper.feed;
    await this.refreshSecrets();
    await this.loadClaude(true);
    if (this.state.firstRun) await this.preselectDetected();
    this.state.update.version = (await this.shell.appVersion?.().catch(() => null)) ?? null;
    this.emit('config', 'snapshot', 'history', 'resets', 'feed', 'catalog', 'secrets', 'claude', 'update', 'firstRun');
    if (this.shell.checkUpdate) {
      this.timers.push(setTimeout(() => void this.checkUpdate(), UPDATE_FIRST_CHECK_MS));
      this.timers.push(setInterval(() => void this.checkUpdate(), UPDATE_INTERVAL_MS));
    }
    if (!this.state.firstRun) { this.schedule(); void this.refresh(); }
    void this.checkAsk(false);
    void this.checkPhone();
    const check = () => this.checkAgentEdits().then(() => this.checkFeed());
    void check();
    this.timers.push(setInterval(() => void check(), EDIT_CHECK_MS));
  }

  /** Stops every timer, for a clean exit and for tests. */
  stop(): void {
    clearInterval(this.tickTimer);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.pushRetry);
    clearTimeout(this.rulesTimer);
  }

  async flush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.appendResets(), new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
    } catch { this.logResetFailure(); }
    finally { clearTimeout(timer); }
  }

  private schedule(): void {
    clearInterval(this.tickTimer);
    // Each provider has its own interval, so the timer only checks often whether one is due.
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
  }

  private async tick(): Promise<void> {
    void this.syncRules();
    if (Date.now() - this.lastPhoneCheck >= ASK_CHECK_MS) void this.checkPhone();
    if (Date.now() - this.lastAskCheck >= ASK_CHECK_MS && await this.checkAsk(true)) return;
    if (dueFor(this.config, this.state.snapshot).length) await this.refresh();
  }

  private async preselectDetected(): Promise<void> {
    const map = this.pluginMap(), have = new Set(this.state.secrets);
    await Promise.all(this.config.providers.map(async (pc) => {
      const p = map.get(pc.id);
      if (!p) return;
      // Key-based providers start off until a key is saved; signed-in CLIs are found automatically.
      const needed = requiredSecrets(p);
      pc.enabled = p.needsLocalLogin ? await detectProvider(p, this.shell.host) : needed.length > 0 && needed.every((n) => have.has(n));
    }));
  }

  private async refreshSecrets(): Promise<void> {
    const names = secretNames(this.config);
    const has = await Promise.all(names.map((n) => this.shell.hasSecret(n).catch(() => false)));
    this.state.secrets = names.filter((_, i) => has[i]);
    this.emit('secrets');
  }

  // ------------------------------------------------------------------ refresh

  async refresh(force = false, only?: string[]): Promise<void> {
    if (this.state.busy) return;
    this.state.busy = true;
    this.emit('busy');
    try {
      const full = this.config;
      const run = only ? { ...full, providers: full.providers.map((p) => ({ ...p, enabled: p.enabled && only.includes(p.id) })) } : full;
      const got = await collectFor(this.shell.host, run, this.state.snapshot, force);
      const snapshot = only ? { ...got, providers: { ...this.state.snapshot?.providers, ...got.providers } } : got;
      this.recordResets(snapshot);
      this.state.snapshot = snapshot;
      this.state.history = appendHistoryRows(this.state.history, snapshot);
      const { alerts, firedState } = usageAlerts(snapshot, this.state.history, this.config, this.alertState);
      this.alertState = firedState;
      const raisedAt = new Date();
      await this.raise(alerts.map((a) => { const { raisedAt: _at, outlets: _outlets, ...item } = feedFromUsage(a.usage, a.title, raisedAt, []); return item; }));
      await this.alertFailedRefreshes();
      await this.clearFeed();
      await Promise.all([this.shell.saveSnapshot(snapshot), this.shell.saveHistory(this.state.history), this.shell.saveAlertState(this.alertState)]);
      if (this.sync?.channel) {
        const since = Date.now() - this.lastPush;
        if (since >= (force ? FORCED_PUSH_MS : SYNC_PUSH_MS)) await this.push();
        else if (force) { clearTimeout(this.pushRetry); this.pushRetry = setTimeout(() => void this.push(), FORCED_PUSH_MS - since); }
      }
      void this.refreshModelLists();
      await this.exportUsage();
    } finally {
      this.state.busy = false;
      this.emit('snapshot', 'history', 'resets', 'busy');
    }
  }

  private logResetFailure(message = 'Reset ledger could not be read or appended.'): void {
    try { this.shell.host.log?.(message); } catch { /* Logging must not interrupt a reading. */ }
  }

  private async loadResets(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const load = (async () => {
      try {
        const events = await this.shell.loadResets();
        this.loadedResets = events;
        const rows = new Map([...events, ...this.state.resets].map(event => [event.id, event]));
        this.state.resets = [...rows.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        this.emit('resets');
      } catch { if (!timedOut) this.logResetFailure(); }
    })();
    await Promise.race([load, new Promise<void>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        this.logResetFailure('Reset ledger read timed out after 5 seconds; startup will continue.');
        resolve();
      }, 5000);
    })]);
    clearTimeout(timer);
  }

  private capPendingResets(): void {
    if (this.pendingResets.length <= 1000) return;
    this.pendingResets.splice(0, this.pendingResets.length - 1000);
    this.logResetFailure('Reset ledger retry queue exceeded 1000 events; the oldest events were dropped.');
  }

  private appendResets(): Promise<void> {
    this.resetAppend = this.resetAppend.then(async () => {
      const events = this.pendingResets.splice(0);
      if (!events.length) return;
      try { await this.shell.appendResets(events); }
      catch {
        this.pendingResets.unshift(...events);
        this.capPendingResets();
        this.logResetFailure();
      }
    });
    return this.resetAppend;
  }

  private recordResets(snapshot: Snapshot): void {
    try {
      // Only the loaded ledger can be ahead of the snapshot; live events can end where the next reading starts.
      const events = detectResets(this.state.snapshot, snapshot).filter(event => !this.loadedResets.some(prior =>
        prior.kind === event.kind && prior.provider === event.provider && (event.kind === 'credits' || prior.meter === event.meter)
        && Date.parse(prior.at) >= Date.parse(event.since)));
      this.state.resets.push(...events);
      this.pendingResets.push(...events);
      this.capPendingResets();
      void this.appendResets();
      for (const provider of Object.values(snapshot.providers)) {
        const pattern = resetPattern(this.state.resets.filter(event => event.provider === provider.id), new Date(snapshot.generatedAt));
        if (pattern) provider.notes = { ...provider.notes, reset_pattern: pattern };
      }
    } catch { this.logResetFailure(); }
  }

  async refreshSignIns(): Promise<void> {
    const map = this.pluginMap();
    await this.refresh(true, this.config.providers.filter((pc) => map.get(pc.id)?.fields.some((f) => f.kind === 'signin')).map((pc) => pc.id));
  }

  async viewShown(): Promise<void> {
    void this.syncRules();
    void this.checkAgentEdits();
    const age = this.state.snapshot ? (Date.now() - new Date(this.state.snapshot.generatedAt).getTime()) / 1000 : Infinity;
    if (age > 60 && !this.state.firstRun) await this.refresh();
  }

  /** One alert when a provider starts failing to refresh; it re-arms once that provider refreshes again. */
  private async alertFailedRefreshes(): Promise<void> {
    for (const p of Object.values(this.state.snapshot?.providers ?? {})) {
      if (!p.error) { this.failedRefresh.delete(p.id); continue; }
      if (!p.stale || this.failedRefresh.has(p.id)) continue;
      this.failedRefresh.add(p.id);
      if (!this.config.alerts.enabled) continue;
      const at = p.fetchedAt ? new Date(p.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      await this.raise([{ id: `refresh.${p.id}.${p.attemptedAt ?? Date.now()}`, kind: 'refresh', severity: 'warn', group: `refresh.${p.id}`, clears: { when: 'refreshed', providerId: p.id },
        title: `${p.name} did not refresh`, body: `Augur keeps showing the numbers from ${at} until a refresh works. ${p.error}` }]);
    }
  }

  private async exportUsage(): Promise<void> {
    if (!this.shell.exportSnapshot || !this.config.exportPath || !this.state.snapshot) return;
    const out = { ...this.state.snapshot, summary: summaryLine(this.state.snapshot, this.config) };
    await this.shell.exportSnapshot(this.config.exportPath, JSON.stringify(out, null, 2)).catch(() => undefined);
  }

  // ------------------------------------------------------------------ alerts

  private async raise(items: Raise[]): Promise<void> {
    if (await this.keeper.raise(items)) this.feedChanged();
  }

  /** Tells the views, and when a phone is paired, the new feed reaches it within a minute. */
  private feedChanged(): void {
    this.state.feed = this.keeper.feed;
    this.emit('feed');
    if (!this.sync?.channel) return;
    const since = Date.now() - this.lastPush;
    clearTimeout(this.pushRetry);
    this.pushRetry = setTimeout(() => void this.push(), Math.max(0, FORCED_PUSH_MS - since));
  }

  /** Drops alerts that have stopped applying. A condition that has not been read yet counts as still holding. */
  private async clearFeed(): Promise<void> {
    const u = this.state.update;
    const flags = {
      models: pendingCount(this.config) > 0,
      rules: !this.state.editLoaded || this.state.editState.held.length > 0,
      update: u.status === 'idle' || u.status === 'checking' || !!u.available,
    };
    if (await this.keeper.clear(this.state.snapshot, flags)) this.feedChanged();
  }

  /** Applies dismissals from Claude Code, then drops alerts that have stopped applying. */
  private async checkFeed(): Promise<void> {
    if (await this.keeper.checkAcks()) this.feedChanged();
    await this.clearFeed();
  }

  /** Premium notices raised since the service started. A dismissed notice stays gone while it still applies, so it is not raised again on the next poll. */
  private premiumRaised = new Set<string>();

  /**
   * The service reports which premium notices apply now: backlog tasks that wait for the owner's approval, and surplus windows about to end with budget unspent.
   * A new one raises an alert, and one that no longer applies leaves the feed.
   */
  async setPremiumNotices(notices: Array<{ key: string; title: string; body: string }>): Promise<void> {
    const keys = new Set(notices.map((n) => `backlog.${n.key}`));
    for (const id of [...this.premiumRaised]) if (!keys.has(id)) this.premiumRaised.delete(id);
    const fresh = notices.filter((n) => !this.premiumRaised.has(`backlog.${n.key}`));
    for (const n of fresh) this.premiumRaised.add(`backlog.${n.key}`);
    if (fresh.length) await this.raise(fresh.map((n) => ({ id: `backlog.${n.key}`, kind: 'backlog' as const, severity: 'warn' as const, group: `backlog.${n.key}`, clears: { when: 'never' as const }, title: n.title, body: n.body })));
    await this.dismiss(this.keeper.feed.alerts.filter((a) => a.kind === 'backlog' && !keys.has(a.id)).map((a) => a.id));
  }

  async dismiss(ids: string[]): Promise<void> {
    ids = ids.filter(Boolean);
    if (ids.length && await this.keeper.dismiss(ids)) this.feedChanged();
  }

  // ------------------------------------------------------------------ phone

  /** Whether the phone has asked for new numbers since the last check. With act set, a new request starts a full refresh, which uploads at once. */
  private async checkAsk(act: boolean): Promise<boolean> {
    if (!this.sync?.channel) return false;
    this.lastAskCheck = Date.now();
    const at = await readAsk(this.shell.host, this.sync).catch(() => null);
    if (at == null) return false;
    const fresh = act && this.askSeen != null && at > this.askSeen;
    // refresh() returns early while busy, so a request that lands mid-refresh stays unseen until the next check.
    if (fresh && this.state.busy) return false;
    this.askSeen = at;
    if (fresh) await this.refresh(true);
    return fresh;
  }

  /** Reads what the phone has dismissed and where it wants push. */
  private async checkPhone(): Promise<void> {
    if (!this.sync?.channel) return;
    this.lastPhoneCheck = Date.now();
    const state = await pullPhoneState(this.shell.host, this.sync).catch(() => null);
    // An unpair that happened while the pull was out leaves nothing to merge.
    if (state && this.sync?.channel && await this.keeper.mergePhone(state)) this.feedChanged();
  }

  /** Uploads the current snapshot for the phone. If the relay says it is too soon, it tries again once the gap has passed. */
  private async push(): Promise<void> {
    if (!this.sync?.channel || !this.state.snapshot) return;
    clearTimeout(this.pushRetry);
    this.pushRetry = undefined;
    try {
      const pushKey = await this.keeper.pushKey();
      await pushSnapshot(this.shell.host, this.sync, this.state.snapshot, this.state.history, sharedConfig(this.config), await this.phoneSecrets(),
        { alerts: feedFor(this.keeper.feed, 'augur'), ...(pushKey ? { pushKey } : {}) });
      this.lastPush = Date.now();
    } catch (err) {
      if (err instanceof SyncUploadError && err.status === 429) this.pushRetry = setTimeout(() => void this.push(), FORCED_PUSH_MS);
    }
  }

  /** The API keys a paired phone needs to read key-based providers itself. A provider that also needs a sign-in on this computer stays here. */
  private async phoneSecrets(): Promise<Record<string, string> | undefined> {
    if (this.sync?.shareKeys !== true) return undefined;
    const out: Record<string, string> = {};
    for (const p of allPlugins(this.config)) {
      if (p.needsLocalLogin || p.fields.some((f) => f.kind === 'signin')) continue;
      for (const f of p.fields.filter((x) => x.kind === 'secret')) {
        const v = await this.shell.host.secret(`${p.id}.${f.key}`).catch(() => null);
        if (v) out[`${p.id}.${f.key}`] = v;
      }
    }
    return out;
  }

  async pair(): Promise<string> {
    const pwaUrl = this.pwaUrl();
    const { link, pairUrl } = await createPairing(this.shell, this.relay(), pwaUrl);
    this.config.sync = { ...link, pwaUrl, shareKeys: this.sync?.shareKeys };
    this.lastPush = 0;
    await this.persist();
    this.emit('config');
    void this.refresh();
    return pairUrl;
  }

  async pairUrl(): Promise<string | null> {
    const key = await this.shell.host.secret('sync.key').catch(() => null);
    return key && this.sync?.channel ? pairingUrl(this.sync.pwaUrl, this.sync, key) : null;
  }

  async unpair(): Promise<void> {
    if (this.sync) this.config.sync = { ...this.sync, channel: '' };
    await Promise.all([this.shell.deleteSecret('sync.key'), this.shell.deleteSecret('sync.writeSecret'), this.keeper.forgetPhone()]);
    await this.persist();
    this.emit('config');
  }

  /**
   * Merges the paired device's rules into this device's and uploads the result when it differs from what the relay holds. Each field keeps the newer
   * edit, so the two devices end with the same rules whichever of them goes first and a lost upload is repaired by the next comparison.
   */
  private async syncRules(force = false): Promise<void> {
    const link = this.sync;
    if (!link?.channel || !this.config.policy || this.rulesSyncing) return;
    if (!force && Date.now() - this.lastRulesSync < RULES_SYNC_MS) return;
    this.rulesSyncing = true;
    this.lastRulesSync = Date.now();
    try {
      const remote = await pullRules(this.shell.host, link, false);
      const local = this.config.policy;
      const merged = remote ? mergePolicy(local, remote) : local;
      if (JSON.stringify(merged.stamps) !== JSON.stringify(local.stamps) || merged.clock !== local.clock || policyDigest(merged) !== policyDigest(local)) {
        this.config.policy = merged;
        await this.persist();
        this.emit('config');
      }
      if (!remote || policyDigest(merged) !== policyDigest(remote)) await pushRules(this.shell.host, link, merged, false);
    } catch {
      // The relay was unreachable or refused the write; the next comparison tries again.
    } finally { this.rulesSyncing = false; }
  }

  // ------------------------------------------------------------------ config and rules

  /** Writes the config and the policy file beside the usage file. */
  private async persist(): Promise<void> {
    // A legacy balance block is rewritten the first time the rules are saved.
    if (this.config.policy) upgradeStoredBalance(this.config.policy);
    await this.shell.saveConfig(this.config);
    await this.writePolicy();
  }

  async saveConfig(next: AppConfig): Promise<void> {
    const prev = this.config;
    const policy = next.policy && prev.policy ? mergePolicy(prev.policy, next.policy) : next.policy ?? prev.policy;
    const config: AppConfig = { ...next, ...(policy ? { policy } : {}) };
    const customChanged = JSON.stringify(prev.custom ?? []) !== JSON.stringify(config.custom ?? []);
    if (customChanged) syncProviderList(config);
    const enabledBefore = new Set(prev.providers.filter((p) => p.enabled).map((p) => p.id));
    const gained = config.providers.some((p) => p.enabled && !enabledBefore.has(p.id));
    const exportMoved = (prev.exportPath ?? null) !== (config.exportPath ?? null);
    const shareChanged = (prev.sync?.shareKeys ?? false) !== (config.sync?.shareKeys ?? false);
    const rulesChanged = !!policy && (!prev.policy || policyDigest(prev.policy) !== policyDigest(policy) || JSON.stringify(prev.policy.stamps) !== JSON.stringify(policy.stamps));
    this.state.config = config;
    await this.persist();
    this.emit('config', 'policyError');
    if (customChanged) await this.refreshSecrets();
    if (rulesChanged && this.sync?.channel) { clearTimeout(this.rulesTimer); this.rulesTimer = setTimeout(() => void this.syncRules(true), RULES_EDIT_DELAY_MS); }
    if (exportMoved) {
      await this.exportUsage();
      // The installed mod reads the usage file from the path it was given, so it follows the change.
      if (this.state.claude?.code && config.exportPath) { await this.shell.claudeInstall?.('code', config.exportPath).catch(() => undefined); await this.loadClaude(false); }
    }
    if (rulesChanged) void this.clearFeed();
    if (shareChanged) { this.lastPush = 0; void this.refresh(); }
    else if (gained && !this.state.firstRun) void this.refresh();
  }

  async finishSetup(config: AppConfig): Promise<void> {
    this.state.firstRun = false;
    this.emit('firstRun');
    await this.saveConfig(config);
    this.schedule();
    await this.refresh();
  }

  /** policy.json changes only when a rule does, so it is written with the config, never on a usage refresh. */
  private async writePolicy(): Promise<void> {
    if (!this.shell.exportSnapshot || !this.config.exportPath || !this.config.policy) return;
    upgradeStoredBalance(this.config.policy);
    const file = buildPolicyFile(this.config.policy, policyProviders(this.config));
    try {
      await this.shell.exportSnapshot(policyPathFor(this.config.exportPath), JSON.stringify(file, null, 2));
      this.state.policyError = null;
    } catch (e) {
      this.state.policyError = e instanceof Error ? e.message : String(e);
    }
  }

  async retryPolicy(): Promise<void> {
    await this.writePolicy();
    this.emit('policyError');
  }

  /**
   * While no rules exist yet, an existing policy.json beside the export is adopted as it stands, so hand-kept rules and pauses survive.
   * Without one, a policy-import.json is imported once, with every model left unconfirmed.
   */
  private async importRulesOnce(): Promise<void> {
    const policy = this.config.policy ??= emptyPolicy();
    const read = this.shell.host.readHomeFile;
    if (Object.keys(policy.providers).length || !read || !this.config.exportPath) return;
    const existing = await read(policyPathFor(this.config.exportPath)).catch(() => null);
    if (existing) {
      try {
        const adopted = policyFromFile(JSON.parse(existing));
        if (Object.values(adopted.providers).some((p) => Object.keys(p.models).length)) { policy.providers = adopted.providers; await this.persist(); return; }
      } catch { /* an unreadable file falls through to the import file */ }
    }
    const text = await read(policyPathFor(this.config.exportPath, 'policy-import.json')).catch(() => null);
    if (!text) return;
    try { importPolicy(policy, JSON.parse(text)); } catch { return; }
    await this.persist();
  }

  /**
   * Reads each provider's model list once a day, or one provider's list now when `only` names it. The lists are read here, since several need
   * a login on this computer, and the phone gets the resulting models with the rules.
   */
  private async refreshModelLists(only?: string): Promise<void> {
    const policy = this.config.policy ??= emptyPolicy(), added: string[] = [];
    for (const plugin of allPlugins(this.config)) {
      const pc = this.config.providers.find((p) => p.id === plugin.id);
      if (!plugin.listModels || !pc?.enabled || this.state.listing.includes(plugin.id)) continue;
      if (only ? only !== plugin.id : !listDue(this.state.catalog[plugin.id])) continue;
      this.state.listing = [...this.state.listing, plugin.id];
      this.emit('listing');
      const fetchedAt = new Date().toISOString();
      try {
        const models = await plugin.listModels(this.shell.host, pc.settings);
        this.state.catalog[plugin.id] = { fetchedAt, models, error: null };
        const mode = plugin.id === 'cogitator' ? 'catalog' : policy.providers[plugin.id]?.listMode ?? plugin.modelListMode ?? 'auto';
        if (mode === 'auto') added.push(...syncModelList(policy, plugin.id, plugin.labelPrefix ?? plugin.id, models));
      } catch (error) {
        this.state.catalog[plugin.id] = { fetchedAt, models: this.state.catalog[plugin.id]?.models ?? [], error: error instanceof Error ? error.message : String(error) };
      } finally {
        this.state.listing = this.state.listing.filter((x) => x !== plugin.id);
      }
    }
    await this.shell.saveModelCatalog?.(this.state.catalog).catch(() => undefined);
    this.emit('catalog', 'listing');
    if (added.length) {
      await this.persist();
      this.emit('config');
      await this.raise([{ id: `models.${Date.now()}`, kind: 'models', severity: 'info', group: 'models', clears: { when: 'flag', flag: 'models' },
        title: `${added.length} new ${added.length === 1 ? 'model' : 'models'} to review`,
        body: 'Routers skip a new model until its rules are confirmed. Open Model rules to set them.' }]);
    }
  }

  async listModels(provider: string): Promise<void> {
    await this.refreshModelLists(provider);
  }

  /** Where the edit inbox and its results sit: beside policy.json. */
  private editPath(name: string): string | null { return this.config.exportPath ? policyPathFor(this.config.exportPath).replace(/policy\.json$/, name) : null; }

  private async saveEditState(): Promise<void> {
    const path = this.editPath(RESULTS_FILE), write = this.shell.host.writeHomeFileAtomic;
    if (path && write) await write(path, JSON.stringify({ updatedAt: new Date().toISOString(), ...this.state.editState })).catch(() => undefined);
  }

  /**
   * Agents ask for rule changes through the MCP server, which appends them to an inbox file. Weights, pauses, notes and hold rules are applied here
   * through the same functions the rules page uses. A change to data access, ask first, status or a limit waits for the owner to accept it.
   */
  private async checkAgentEdits(): Promise<void> {
    const read = this.shell.host.readHomeFile, inbox = this.editPath(INBOX_FILE), results = this.editPath(RESULTS_FILE);
    if (!read || !inbox || !results || !this.config.policy || this.checkingEdits) return;
    this.checkingEdits = true;
    try {
      const text = await read(inbox).catch(() => null);
      if (!this.state.editLoaded) { this.state.editState = parseEditState(await read(results).catch(() => null)); this.state.editLoaded = true; this.emit('editState', 'editLoaded'); }
      const edits = parseInbox(text);
      if (!edits.some((e) => !this.state.editState.seen.includes(e.id))) return;
      const r = processInbox(this.config.policy, edits, this.state.editState, this.device, new Date(), this.config.agentApproval ?? DEFAULT_APPROVAL);
      this.state.editState = r.state;
      if (r.changed) { await this.persist(); this.emit('config'); }
      await this.saveEditState();
      this.emit('editState');
      const held = this.state.editState.held.length;
      if (r.newlyHeld.length) await this.raise([{ id: `rules.${Date.now()}`, kind: 'rules', severity: 'warn', group: 'rules', clears: { when: 'flag', flag: 'rules' },
        title: `${held} rule ${held === 1 ? 'change' : 'changes'} to accept`,
        body: 'An agent asked for a change to the rules. Open Model rules to accept or dismiss it.' }]);
    } finally { this.checkingEdits = false; }
  }

  async answerEdit(id: string, accept: boolean): Promise<void> {
    if (!this.config.policy || !id) return;
    const r = resolveHeld(this.config.policy, this.state.editState, id, accept, this.device);
    this.state.editState = r.state;
    if (r.changed) { await this.persist(); this.emit('config'); }
    await this.saveEditState();
    this.emit('editState');
    void this.clearFeed();
  }

  // ------------------------------------------------------------------ keys

  async setProviderKey(provider: string, key: string, value: string): Promise<void> {
    if (!value.trim()) return;
    await this.shell.setSecret(`${provider}.${key}`, value.trim());
    const pc = this.config.providers.find((p) => p.id === provider);
    if (pc && !pc.enabled) { pc.enabled = true; await this.persist(); this.emit('config'); }
    await this.refreshSecrets();
    if (!this.state.firstRun) void this.refresh(true, [provider]);
  }

  async addProvider(input: ProviderAddition): Promise<ProviderAdded> {
    const id = input.provider;
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error(`"${id}" is not a provider id: it starts with a lowercase letter and holds lowercase letters, digits, - and _.`);
    const next: AppConfig = structuredClone(this.config);
    const builtIn = allPlugins({ ...next, custom: [] }).some((p) => p.id === id);
    const custom = (next.custom ?? []).some((d) => d.id === id);
    const rulesOnly = RULES_ONLY_PROVIDERS.some((r) => r.id === id) || (next.rulesOnly ?? []).some((r) => r.id === id);
    if (input.custom) {
      if (input.custom.id !== id) throw new Error('The usage reading names a different provider than the one being added.');
      if (builtIn || rulesOnly) throw new Error(`${id} is a built-in provider, so it keeps its own usage reading. Leave the balance reading out.`);
      if (custom) throw new Error(`A custom provider named ${id} already exists. Change it in Settings.`);
      try { genericProvider(input.custom); } catch (e) { throw new Error(`The usage reading is not valid: ${e instanceof Error ? e.message : String(e)}`); }
      next.custom = [...(next.custom ?? []), input.custom];
      syncProviderList(next);
    } else if (!builtIn && !custom && !rulesOnly) next.rulesOnly = [...(next.rulesOnly ?? []), { id, name: input.name }];
    if (input.enable || input.custom) {
      const pc = next.providers.find((p) => p.id === id);
      if (!pc) throw new Error(`${id} has no usage reading to turn on.`);
      if (input.enable?.settings) pc.settings = { ...pc.settings, ...input.enable.settings };
      // A reading supplied with the route stays off until the owner stores its key.
      if (input.enable || !input.usageOff) pc.enabled = true;
    }
    const policy = next.policy ??= emptyPolicy();
    const added = addModels(policy, id, input.models ?? [], 'manual');
    const labels: Record<string, string> = {};
    for (const m of input.models ?? []) labels[m.id] = Object.entries(policy.providers[id]?.models ?? {}).find(([, e]) => e.id === m.id)?.[0] ?? m.label;
    await this.saveConfig(next);
    if (added.length) await this.raise([{ id: `models.${Date.now()}`, kind: 'models', severity: 'info', group: 'models', clears: { when: 'flag', flag: 'models' },
      title: `${added.length} new ${added.length === 1 ? 'model' : 'models'} to review`, body: 'Routers skip a new model until its rules are confirmed. Open Model rules to set them.' }]);
    return { labels, added };
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.shell.setSecret(name, value);
    await this.refreshSecrets();
  }

  async deleteSecret(name: string): Promise<void> {
    await this.shell.deleteSecret(name);
    await this.refreshSecrets();
  }

  async hasSecret(name: string): Promise<boolean> {
    return this.shell.hasSecret(name).catch(() => false);
  }

  // ------------------------------------------------------------------ sign-in

  async signInBegin(provider: string): Promise<LoginStart> {
    if (!isSignInProvider(provider)) throw new Error(`Sign in is not available for ${provider}.`);
    const now = Date.now();
    for (const [id, p] of this.logins) if (p.expiresAt < now) this.logins.delete(id);
    // A person who starts over leaves the earlier attempt behind; a handful at once is plenty.
    for (const [id, p] of this.logins) if (p.provider === provider) this.logins.delete(id);
    while (this.logins.size >= 8) this.logins.delete(this.logins.keys().next().value as string);
    const { pending, start } = await beginLogin(this.shell.host, provider);
    this.logins.set(pending.id, pending);
    return start;
  }

  async signInComplete(id: string, input?: string): Promise<{ done: boolean }> {
    const pending = this.logins.get(String(id));
    if (!pending) throw new Error('Sign in again: this sign-in is no longer open. Start a new one.');
    let result: { done: boolean };
    try { result = await completeLogin(this.shell.host, pending, input); }
    catch (error) {
      // A code that was refused can be fixed and pasted again until the sign-in expires; anything else ends it.
      if (!(error instanceof Error) || (error as { retry?: unknown }).retry !== true) this.logins.delete(pending.id);
      throw error;
    }
    if (!result.done) return result;
    this.logins.delete(pending.id);
    const pc = this.config.providers.find((p) => p.id === pending.provider);
    if (pc && !pc.enabled) { pc.enabled = true; await this.persist(); this.emit('config'); }
    if (!this.state.firstRun) void this.refresh(true, [pending.provider]);
    return result;
  }

  async signOut(provider: string): Promise<void> {
    if (!isSignInProvider(provider)) throw new Error(`Sign in is not available for ${provider}.`);
    if (await ownSession(this.shell.host, provider)) await this.shell.deleteSecret(sessionSecretName(provider));
    forgetAccess(this.shell.host, provider);
  }

  async signInStatus(): Promise<Record<string, 'own' | 'cli' | null>> {
    const out: Record<string, 'own' | 'cli' | null> = {};
    for (const id of signInProviders()) {
      if (await ownSession(this.shell.host, id)) { out[id] = 'own'; continue; }
      const plugin = this.pluginMap().get(id);
      out[id] = plugin && await detectProvider(plugin, this.shell.host).catch(() => false) ? 'cli' : null;
    }
    return out;
  }

  // ------------------------------------------------------------------ Claude

  /** Reads where the Claude installs stand. After an update, an installed mod older than the one this build carries is replaced. */
  private async loadClaude(refresh: boolean): Promise<void> {
    if (!this.shell.claudeStatus) return;
    this.state.claude = await this.shell.claudeStatus().catch(() => null);
    const c = this.state.claude;
    if (refresh && c?.code && c.bundled && c.code !== c.bundled && this.config.exportPath) {
      await this.shell.claudeInstall?.('code', this.config.exportPath).catch(() => undefined);
      this.state.claude = await this.shell.claudeStatus().catch(() => null);
    }
    this.emit('claude');
  }

  async setClaude(target: ClaudeTarget, on: boolean): Promise<void> {
    this.state.claudeError = '';
    try {
      if (!on) await this.shell.claudeRemove?.(target);
      else {
        // The mod reads the usage file, so turning it on also turns on the export when it is off.
        if (target === 'code' && !this.config.exportPath) {
          this.config.exportPath = DEFAULT_EXPORT;
          await this.persist();
          this.emit('config');
          await this.exportUsage();
        }
        await this.shell.claudeInstall?.(target, this.config.exportPath ?? DEFAULT_EXPORT);
      }
    } catch (e) {
      this.state.claudeError = e instanceof Error ? e.message : String(e);
    }
    await this.loadClaude(false);
    this.emit('claudeError');
  }

  // ------------------------------------------------------------------ updates

  async checkUpdate(): Promise<void> {
    const u = this.state.update;
    if (!this.shell.checkUpdate || u.status === 'checking' || u.status === 'installing') return;
    const before = u.available?.version;
    u.status = 'checking';
    this.emit('update');
    try {
      u.available = await this.shell.checkUpdate();
      u.status = u.available ? 'available' : 'current';
    } catch {
      // A failed check keeps showing an update already found, so the button does not disappear.
      u.status = u.available ? 'available' : 'error';
    }
    const found = u.available?.version;
    if (found && found !== before) {
      u.changes = await this.loadChanges(found);
      await this.raise([{ id: `update.${found}`, kind: 'update', severity: 'info', group: 'update', clears: { when: 'flag', flag: 'update' },
        title: `Augur ${found} is ready`, body: u.available?.managedBy ? UPDATE_ALERT_TEXT.managed : this.config.autoUpdate !== false ? UPDATE_ALERT_TEXT.auto : UPDATE_ALERT_TEXT.manual }]);
    }
    if (!found) u.changes = null;
    this.emit('update');
  }

  async setInstalling(on: boolean): Promise<void> {
    const u = this.state.update;
    u.status = on ? 'installing' : u.available ? 'error' : 'idle';
    this.emit('update');
  }

  private async loadChanges(to: string): Promise<ReleaseChanges[] | null> {
    const from = this.state.update.version;
    if (!from) return null;
    const res = await this.shell.host.http({ url: CHANGELOG_URL(to), method: 'GET', timeoutMs: 15000 }).catch(() => null);
    return res?.status === 200 ? releaseChanges(res.body, from, to) : null;
  }
}

/** Calls one engine command by name with JSON arguments, as the local socket and the window bridge deliver them. */
export async function callEngine(engine: EngineCommands, method: string, args: unknown[]): Promise<unknown> {
  if (!(ENGINE_COMMANDS as readonly string[]).includes(method)) throw new Error(`Unknown engine command: ${method}`);
  const fn = (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!;
  return fn.apply(engine, Array.isArray(args) ? args : []);
}
