import Sortable from 'sortablejs';
import { ACTIVITY_LABELS, DATA_TIER_LABELS, WEIGHT_LABELS, addModels, buildPolicyFile, emptyPolicy, importPolicy, listDue, mergePolicy, policyDigest, policyFromFile, policyPathFor, releaseChanges, setField, setFieldMany, setModelStatus, syncModelList, undoChange, type AppConfig, type DataTier, type ModelCatalog, type ModelEntry, type ProviderPlugin, type ReleaseChanges, type Shell, type Snapshot, type UpdateInfo } from '@augur/core';
import * as core from './core';
import type { HistoryRow } from './core';
import { renderDashboard, tightest, updateTip, type DashboardModel } from './views/dashboard';
import { CUSTOM_EXAMPLE, renderSettings, type SettingsModel } from './views/settings';
import { dialEndChoices, pauseResets, renderRules, type RulesFilter, type RulesModel } from './views/rules';
import { renderJobs, type JobsModel } from './views/jobs';
import { renderRoutes, type RoutesModel } from './views/routes';
import { renderService, type ConfigLine, type ServiceModel } from './views/service';
import { BULK_FIELDS, previewBulk, type BulkPreview } from './rules-bulk';
import { pauseValue, planDialBack, type DialBackPlan } from './dial-back';
import { ROUTES_PATH, checkDraft, draftOf, emptyDraft, parseRoutesText, writeRoute } from './routes-model';
import { routeSecretName } from '@augur/dispatch-protocol';
import type { Accounted, JobRecord } from '@augur/dispatch-protocol';
import { renderTrayIcon } from './trayicon';
import { span, until } from './util';
import qrcode from 'qrcode-generator';
import { HOSTED } from './hosted';
import { attachPullToRefresh } from './pull-refresh';
import { acceptPairing, acceptPairingFromUrl, applySharedConfig, askDesktop, createPairing, mergeSynced, pairingUrl, parsePairing, pullRules, pullSnapshot, pushRules, pushSnapshot, readAsk, sharedConfig, SyncUploadError } from './sync';
import { scanQr } from './scan';
import { relayUrl, setRelayUrl } from './shells/browser';

type SyncConfig = NonNullable<AppConfig['sync']>;

const ONE_COL = 400;
const TWO_COL = 780;

// Each push is one KV write on the relay, so a paired phone gets a new copy at most every 10 minutes (144 writes a day).
const SYNC_PUSH_MS = 10 * 60_000;
// A refresh by hand uploads at once, up to once a minute, which matches the relay's own limit.
const FORCED_PUSH_MS = 60_000;
// After the phone asks for new numbers, it checks for the desktop's upload this often, for this long.
const DESKTOP_POLL_MS = 15_000;
const DESKTOP_WAIT_MS = 4 * 60_000;
// Matches the shortest refresh interval a provider can have.
const TICK_MS = 15_000;
const ASK_CHECK_MS = 60_000;
const PULL_MS = 5 * 60_000;
// Rules are compared with the paired device's at most once a minute, and a local edit starts a comparison a few seconds after it.
const RULES_SYNC_MS = 60_000;
const RULES_EDIT_DELAY_MS = 4_000;
const UPDATE_FIRST_CHECK_MS = 20_000;
const UPDATE_INTERVAL_MS = 5 * 60_000;
const CHANGELOG_URL = (version: string) => `https://raw.githubusercontent.com/neostryder/augur/v${version}/CHANGELOG.md`;

export interface UpdateState {
  version: string | null;
  status: 'idle' | 'checking' | 'current' | 'available' | 'installing' | 'error';
  available: UpdateInfo | null;
  /** What the available update brings, newest release first; null until the changelog has loaded. */
  changes: ReleaseChanges[] | null;
}

type ModelEntryStatus = ModelEntry['status'];

export class App {
  private config!: AppConfig;
  private snapshot: Snapshot | null = null;
  private history: HistoryRow[] = [];
  private alertState: Record<string, unknown> = {};
  private view: 'dashboard' | 'settings' | 'rules' | 'jobs' | 'routes' | 'service' = 'dashboard';
  private firstRun = false;
  private busy = false;
  private expanded: string | null = null;
  private twoColumns = false;
  private secrets = new Set<string>();
  private autostart: boolean | null = null;
  private failedRefresh = new Set<string>();
  private lastPush = 0;
  private pushRetry: ReturnType<typeof setTimeout> | undefined;
  /** Relay time of the phone's latest refresh request that the desktop has seen; null until the first check. */
  private askSeen: number | null = null;
  private lastAskCheck = 0;
  /** When the snapshot the phone last pulled was made on the desktop. */
  private desktopAt: string | null = null;
  private desktopWait: 'waiting' | 'timeout' | null = null;
  private update: UpdateState = { version: null, status: 'idle', available: null, changes: null };
  private openProvider: string | null = null;
  private customDraft = '[]';
  private customError = '';
  private savedFlash: string | null = null;
  /** Set while the last policy.json write failed. Agents keep enforcing the older file until a write succeeds. */
  private policyError: string | null = null;
  private jobs: JobsModel = { service: null, serviceNote: '', unavailable: '', jobs: null, accounted: {}, sel: null, detail: null, busy: false };
  private jobsTimer: ReturnType<typeof setInterval> | undefined;
  private servicePage: ServiceModel = { lines: null, service: null, runJobs: false, note: '', error: '', busy: false, unavailable: '' };
  private routesPage: RoutesModel = { file: null, error: '', health: null, sel: null, draft: null, formError: '', note: '', models: [], confirmDelete: false, busy: false, canTest: false, testing: false, testNote: '', keyStored: null, keyNote: '' };
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastRun = 0;
  private sortables: Sortable[] = [];
  private systemDark = matchMedia('(prefers-color-scheme: dark)');
  private pairQr: string | null = null;
  private pairUrl: string | null = null;
  private justPaired = false;
  private scanError = '';
  private hotkeyError = '';
  private catalog: ModelCatalog = {};
  private listing = new Set<string>();
  private rules: { sel: RulesModel['sel']; query: string; filter: RulesFilter; open: Set<string>; picked: Set<string>; showHistory: boolean; addError: string; note: string; bulkTier: string; bulkField: string; bulkValue: string; preview: BulkPreview | null; dialOpen: boolean; dialEnd: string; dialCustom: string; dialPlan: DialBackPlan | null; dialError: string; pauseMode: 'off' | 'weights'; pauseWeights: Record<string, string> } =
    { sel: null, query: '', filter: 'all', open: new Set(), picked: new Set(), showHistory: false, addError: '', note: '', bulkTier: '', bulkField: 'cost', bulkValue: '', preview: null, dialOpen: false, dialEnd: '', dialCustom: '', dialPlan: null, dialError: '', pauseMode: 'off', pauseWeights: {} };

  private get sync(): SyncConfig | null {
    return this.config.sync ?? null;
  }
  private set sync(v: SyncConfig | null) {
    this.config.sync = v;
  }
  private relay(): string {
    return this.shell.kind === 'pwa' ? relayUrl() : this.sync?.relay || HOSTED;
  }
  private pwaUrl(): string {
    return this.sync?.pwaUrl || HOSTED;
  }

  constructor(private shell: Shell, private root: HTMLElement, private tip: HTMLElement) {}

  // A render measures the page before late data or an opened 7-day chart can make it taller, so the popup resizes whenever the content height changes.
  private resizeWatch = new ResizeObserver(() => { void this.sizePopup(); });

  private pluginMap(): Map<string, ProviderPlugin> {
    return new Map(core.plugins(this.config).map((p) => [p.id, p]));
  }

  async start(): Promise<void> {
    document.body.classList.add(this.shell.kind);
    const saved = await this.shell.loadConfig();
    this.config = core.migrateConfig(saved ?? core.defaultConfig());
    this.syncProviderList();
    await this.importRulesOnce();
    this.firstRun = !saved;
    if (this.shell.kind === 'pwa') {
      const link = await acceptPairingFromUrl(this.shell);
      if (link) await this.pairWith(link, false);
    }
    [this.snapshot, this.history, this.alertState] = await Promise.all([
      this.shell.loadSnapshot(), this.shell.loadHistory() as Promise<HistoryRow[]>, this.shell.loadAlertState(),
    ]);
    this.catalog = (await this.shell.loadModelCatalog?.().catch(() => null)) ?? {};
    this.customDraft = JSON.stringify(this.config.custom ?? [], null, 2);
    this.autostart = this.shell.getAutostart ? await this.shell.getAutostart().catch(() => null) : null;
    await this.applyHotkey();
    if (this.shell.checkUpdate) {
      this.update.version = await this.shell.appVersion?.().catch(() => null) ?? null;
      setTimeout(() => void this.checkForUpdate(true), UPDATE_FIRST_CHECK_MS);
      setInterval(() => void this.checkForUpdate(true), UPDATE_INTERVAL_MS);
      // An automatic install waits for the panel to close, so it never restarts the app under the pointer.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void this.autoInstall(); });
    }
    await this.refreshSecrets();
    // With Also run jobs chosen, the service is up whenever the app is. A service that is already running answers and nothing changes.
    if (this.config.dispatch?.runJobs && this.shell.dispatch) void this.augur(['service', 'start', '--json']).then(() => this.loadService()).catch(() => undefined);

    if (this.firstRun) {
      this.view = 'settings';
      await this.preselectDetected();
    }
    this.applyTheme();
    this.systemDark.addEventListener('change', () => { this.applyTheme(); void this.render(); void this.updateTray(); });
    this.wireEvents();
    if (this.shell.kind === 'pwa') attachPullToRefresh(() => this.pullRefresh());
    this.shell.on('refresh-requested', () => void this.refresh(true));
    this.shell.on('web-session-ready', () => void this.refresh(true, this.config.providers.filter((pc) => this.pluginMap().get(pc.id)?.fields.some((f) => f.kind === 'signin')).map((pc) => pc.id)));
    this.shell.on('settings-requested', () => { this.view = 'settings'; void this.render(); });
    if (this.shell.kind === 'desktop') this.resizeWatch.observe(this.root);
    this.shell.on('popup-shown', () => {
      if (this.shell.kind === 'desktop' && !this.firstRun) this.goHome();
      void this.render();
      void this.syncRules();
      const age = this.snapshot ? (Date.now() - new Date(this.snapshot.generatedAt).getTime()) / 1000 : Infinity;
      if (age > 60) void this.refresh();
    });
    setInterval(() => { if (this.view === 'dashboard' && document.visibilityState === 'visible') void this.render(); }, 30000);
    await this.render();
    await this.updateTray();
    if (!this.firstRun) { this.schedule(); void this.refresh(); }
    if (this.shell.kind === 'desktop' && !this.firstRun && this.config.openOnLaunch !== false) void this.shell.showPopup?.();
    if (this.shell.kind === 'desktop') void this.checkAsk(false);
  }

  /** Keeps one ProviderConfig per known plugin, preserving the user's order. */
  private syncProviderList(): void {
    const known = new Set(core.plugins(this.config).map((p) => p.id));
    this.config.providers = this.config.providers.filter((p) => known.has(p.id));
    for (const id of known) {
      if (!this.config.providers.some((p) => p.id === id)) this.config.providers.push({ id, enabled: false, settings: {} });
    }
  }

  private async preselectDetected(): Promise<void> {
    const map = this.pluginMap();
    await Promise.all(this.config.providers.map(async (pc) => {
      const p = map.get(pc.id);
      if (!p) return;
      if (this.shell.kind === 'pwa' && p.needsLocalLogin) { pc.enabled = false; return; }
      // Key-based providers start off until a key is saved; signed-in CLIs are found automatically.
      pc.enabled = p.needsLocalLogin ? await core.detect(p, this.shell.host) : this.secretsFor(p).every((n) => this.secrets.has(n)) && this.secretsFor(p).length > 0;
    }));
  }

  private secretsFor(p: ProviderPlugin): string[] {
    return p.fields.filter((f) => f.kind === 'secret' && f.required !== false).map((f) => `${p.id}.${f.key}`);
  }

  private async refreshSecrets(): Promise<void> {
    const names: string[] = [];
    for (const p of core.plugins(this.config)) for (const f of p.fields) if (f.kind === 'secret') names.push(`${p.id}.${f.key}`);
    const has = await Promise.all(names.map((n) => this.shell.hasSecret(n).catch(() => false)));
    this.secrets = new Set(names.filter((_, i) => has[i]));
  }

  private schedule(): void {
    clearInterval(this.timer);
    // Each provider has its own interval, so the timer only checks once a minute whether one is due.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  private async tick(): Promise<void> {
    void this.syncRules();
    if (this.shell.kind === 'desktop' && Date.now() - this.lastAskCheck >= ASK_CHECK_MS && await this.checkAsk(true)) return;
    const due = core.dueProviders(this.runConfig(), this.snapshot).length > 0;
    // A paired phone also pulls the desktop's numbers on its own schedule.
    const pull = this.shell.kind === 'pwa' && !!this.sync?.channel && Date.now() - this.lastRun >= PULL_MS;
    if (due || pull) await this.refresh();
  }

  /**
   * Desktop side: whether the phone has asked for new numbers since the last check. With act set,
   * a new request starts a full refresh, which uploads at once. The first check only records where things stand.
   */
  private async checkAsk(act: boolean): Promise<boolean> {
    if (!this.sync?.channel) return false;
    this.lastAskCheck = Date.now();
    const at = await readAsk(this.shell.host, this.sync).catch(() => null);
    if (at == null) return false;
    const fresh = act && this.askSeen != null && at > this.askSeen;
    // refresh() returns early while busy, so a request that lands mid-refresh stays unseen until the next check.
    if (fresh && this.busy) return false;
    this.askSeen = at;
    if (fresh) await this.refresh(true);
    return fresh;
  }

  /** Uploads the current snapshot for the phone. If the relay says it is too soon, it tries again once the gap has passed. */
  private async push(): Promise<void> {
    if (!this.sync?.channel || !this.snapshot) return;
    clearTimeout(this.pushRetry);
    this.pushRetry = undefined;
    try {
      await pushSnapshot(this.shell.host, this.sync, this.snapshot, this.history, sharedConfig(this.config), await this.phoneSecrets());
      this.lastPush = Date.now();
    } catch (err) {
      if (err instanceof SyncUploadError && err.status === 429) this.pushRetry = setTimeout(() => void this.push(), FORCED_PUSH_MS);
    }
  }

  /**
   * Phone side: the phone cannot read the providers that need a sign-in on the desktop, so a refresh
   * asks the desktop to read them and watches the relay until its new upload arrives.
   */
  private async waitForDesktop(): Promise<void> {
    if (!this.sync?.channel || this.desktopWait === 'waiting') return;
    const before = this.desktopAt;
    const asked = await askDesktop(this.sync).catch(() => null);
    if (asked == null) return;
    this.desktopWait = 'waiting';
    await this.render();
    const deadline = Date.now() + DESKTOP_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DESKTOP_POLL_MS));
      await this.refresh();
      if (this.desktopAt !== before) { this.desktopWait = null; await this.render(); return; }
    }
    this.desktopWait = 'timeout';
    await this.render();
  }

  /**
   * The phone reads a provider itself only when it can: never a command-line login, and a key-based
   * provider only once its key is saved on the phone. The paired desktop supplies the rest.
   */
  private runConfig(): AppConfig {
    if (this.shell.kind !== 'pwa') return this.config;
    const map = this.pluginMap();
    const canRead = (id: string) => {
      const p = map.get(id);
      if (!p || p.needsLocalLogin) return false;
      if (!this.sync?.channel) return true;
      return this.phoneCanRead(p) && this.secretsFor(p).every((n) => this.secrets.has(n));
    };
    return { ...this.config, providers: this.config.providers.map((p) => ({ ...p, enabled: p.enabled && canRead(p.id) })) };
  }

  /** force refreshes every provider now, or only those listed in `only`; otherwise each waits out its own interval. */
  async refresh(force = false, only?: string[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    document.body.classList.add('busy');
    try {
      this.lastRun = Date.now();
      const full = this.runConfig();
      const runConfig = only ? { ...full, providers: full.providers.map((p) => ({ ...p, enabled: p.enabled && only.includes(p.id) })) } : full;
      const got = await core.collect(this.shell.host, runConfig, this.snapshot, force);
      this.snapshot = only ? { ...got, providers: { ...this.snapshot?.providers, ...got.providers } } : got;
      this.history = core.appendHistory(this.history, this.snapshot);
      if (this.shell.kind === 'pwa' && this.sync?.channel) {
        await this.pullFromDesktop(full);
        const fromDesktop = this.config.providers.some((p) => p.enabled && !full.providers.find((r) => r.id === p.id)?.enabled);
        if (force && fromDesktop) void this.waitForDesktop();
      }
      const { alerts, firedState } = core.evaluateAlerts(this.snapshot, this.history, this.config, this.alertState);
      this.alertState = firedState;
      if (this.config.alerts.enabled) for (const a of alerts) await this.shell.notify(a.title, a.body).catch(() => undefined);
      await this.alertFailedRefreshes();
      await Promise.all([
        this.shell.saveSnapshot(this.snapshot), this.shell.saveHistory(this.history), this.shell.saveAlertState(this.alertState),
      ]);
      if (this.shell.kind === 'desktop' && this.sync?.channel) {
        const since = Date.now() - this.lastPush;
        if (since >= (force ? FORCED_PUSH_MS : SYNC_PUSH_MS)) await this.push();
        else if (force) { clearTimeout(this.pushRetry); this.pushRetry = setTimeout(() => void this.push(), FORCED_PUSH_MS - since); }
      }
      void this.refreshModelLists();
      if (this.shell.exportSnapshot && this.config.exportPath) {
        const out = { ...this.snapshot, summary: summaryLine(this.snapshot, this.config) };
        await this.shell.exportSnapshot(this.config.exportPath, JSON.stringify(out, null, 2)).catch(() => undefined);
      }
    } finally {
      this.busy = false;
      document.body.classList.remove('busy');
    }
    await this.render();
    await this.updateTray();
  }

  private async applyHotkey(): Promise<void> {
    if (!this.shell.setHotkey) return;
    this.hotkeyError = '';
    await this.shell.setHotkey(this.config.hotkey ?? null).catch(() => { this.hotkeyError = "Augur could not use that shortcut. Your system or another app may already use it, so try a different one."; });
  }

  /** Pairing replaces the setup screen: the phone takes its providers, settings and keys from the desktop. */
  private async pairWith(link: { relay: string; channel: string }, refreshNow = true): Promise<void> {
    this.sync = { relay: link.relay, channel: link.channel, pwaUrl: location.origin + location.pathname };
    if (!relayUrl()) setRelayUrl(link.relay);
    this.justPaired = true;
    this.scanError = '';
    if (this.firstRun) { this.firstRun = false; this.view = 'dashboard'; }
    await this.shell.saveConfig(this.config);
    if (refreshNow) { this.schedule(); await this.refresh(true); }
  }

  /**
   * The API keys a paired phone needs to read key-based providers itself. A provider that also
   * needs a sign-in on this computer stays with the desktop, so it is left out.
   */
  private async phoneSecrets(): Promise<Record<string, string> | undefined> {
    if (this.sync?.shareKeys !== true) return undefined;
    const out: Record<string, string> = {};
    for (const p of core.plugins(this.config)) {
      if (!this.phoneCanRead(p)) continue;
      for (const f of p.fields.filter((x) => x.kind === 'secret')) {
        const v = await this.shell.host.secret(`${p.id}.${f.key}`).catch(() => null);
        if (v) out[`${p.id}.${f.key}`] = v;
      }
    }
    return out;
  }

  /** Whether the phone can produce a provider's full reading from an API key alone. */
  private phoneCanRead(p: ProviderPlugin): boolean {
    return !p.needsLocalLogin && !p.fields.some((f) => f.kind === 'signin');
  }

  /** Saves keys the desktop sent that the phone does not have yet, or has an older copy of. */
  private async storeSyncedSecrets(secrets: Record<string, string> | undefined): Promise<void> {
    if (!secrets) return;
    const known = new Set(core.plugins(this.config).flatMap((p) => p.fields.filter((f) => f.kind === 'secret').map((f) => `${p.id}.${f.key}`)));
    let changed = false;
    for (const [name, value] of Object.entries(secrets)) {
      if (!known.has(name) || typeof value !== 'string' || !value) continue;
      const mine = await this.shell.host.secret(name).catch(() => null);
      if (mine !== value) { await this.shell.setSecret(name, value); changed = true; }
    }
    if (changed) await this.refreshSecrets();
  }

  private async pullFromDesktop(runConfig: AppConfig): Promise<void> {
    const pulled = await pullSnapshot(this.shell.host, this.sync!).catch(() => null);
    if (!pulled || !this.snapshot) return;
    if (this.desktopAt !== pulled.snapshot.generatedAt && this.desktopWait === 'timeout') this.desktopWait = null;
    this.desktopAt = pulled.snapshot.generatedAt;
    await this.storeSyncedSecrets(pulled.secrets);
    const own = new Set(runConfig.providers.filter((p) => p.enabled).map((p) => p.id));
    this.snapshot = mergeSynced(this.snapshot, pulled.snapshot, own);
    const synced = Object.keys(pulled.snapshot.providers).filter((id) => !own.has(id));
    const mine = new Map(this.history.map((r) => [r.t, r]));
    for (const row of pulled.history) {
      const r = mine.get(row.t) ?? { t: row.t };
      for (const id of synced) if (row[id]) (r as Record<string, unknown>)[id] = row[id];
      mine.set(row.t, r as HistoryRow);
    }
    this.history = [...mine.values()].sort((a, b) => a.t.localeCompare(b.t));
    if (this.justPaired) {
      if (pulled.config) {
        this.config = applySharedConfig(this.config, pulled.config);
        this.syncProviderList();
        this.customDraft = JSON.stringify(this.config.custom ?? [], null, 2);
        this.applyTheme();
      } else {
        for (const id of synced) { const pc = this.config.providers.find((p) => p.id === id); if (pc) pc.enabled = true; }
      }
      this.justPaired = false;
      await this.shell.saveConfig(this.config);
    }
  }

  private isDark(): boolean {
    const t = this.config.layout.theme;
    return t === 'dark' || (t === 'system' && this.systemDark.matches);
  }

  private applyTheme(): void {
    document.documentElement.dataset.theme = this.isDark() ? 'dark' : 'light';
  }

  private dashboardModel(): DashboardModel {
    return {
      config: this.config, snapshot: this.snapshot, history: this.history, plugins: this.pluginMap(), busy: this.busy,
      twoColumns: this.twoColumns, expanded: this.expanded, dark: this.isDark(), shellKind: this.shell.kind, desktopWait: this.desktopWait, update: this.update,
      canDispatch: this.shell.dispatch !== undefined,
    };
  }

  private settingsModel(): SettingsModel {
    return {
      config: this.config, plugins: this.pluginMap(), snapshot: this.snapshot, secrets: this.secrets, shellKind: this.shell.kind,
      autostart: this.autostart, update: this.update, openProvider: this.openProvider, customDraft: this.customDraft, customError: this.customError,
      firstRun: this.firstRun, savedFlash: this.savedFlash, canDispatch: this.shell.dispatch !== undefined, runJobs: this.config.dispatch?.runJobs === true,
      classifier: this.servicePage.lines?.find((l) => l.key === 'decision.backend')?.value ?? null,
      sync: this.sync, relay: this.relay(), pwaUrl: this.pwaUrl(), pairQr: this.pairQr, pairUrl: this.pairUrl,
      scanError: this.scanError, iosInstallHint: iosInstallHint(), hotkeyError: this.hotkeyError, canHotkey: !!this.shell.setHotkey,
    };
  }

  private rulesModel(): RulesModel {
    return { config: this.config, providers: core.policyProviders(this.config), plugins: this.pluginMap(), snapshot: this.snapshot,
      dark: document.documentElement.dataset.theme === 'dark', policyError: this.policyError, catalog: this.catalog, listing: this.listing, canList: this.shell.kind === 'desktop', ...this.rules };
  }

  private async render(): Promise<void> {
    const active = document.activeElement as HTMLInputElement | null, focusId = active?.id, caret = active?.selectionStart ?? null;
    if (this.view === 'dashboard') {
      await this.chooseColumns();
    } else if (this.view === 'jobs') {
      this.twoColumns = this.shell.kind === 'desktop';
      this.root.innerHTML = renderJobs(this.jobs);
    } else if (this.view === 'routes') {
      this.twoColumns = this.shell.kind === 'desktop';
      this.root.innerHTML = renderRoutes(this.routesPage);
    } else if (this.view === 'service') {
      this.twoColumns = false;
      this.servicePage.runJobs = this.config.dispatch?.runJobs === true;
      this.root.innerHTML = renderService(this.servicePage);
    } else if (this.view === 'rules') {
      // The desktop popup opens at its two-column width so the list and the open model's rules sit side by side.
      this.twoColumns = this.shell.kind === 'desktop';
      this.root.innerHTML = renderRules(this.rulesModel());
    } else {
      this.twoColumns = false;
      this.root.innerHTML = renderSettings(this.settingsModel());
    }
    if (focusId) {
      const el = document.getElementById(focusId) as HTMLInputElement | null;
      el?.focus();
      if (el && caret !== null && el.type === 'search') el.setSelectionRange(caret, caret);
    }
    this.bindSortables();
    await this.sizePopup();
  }

  /** Auto mode tries one column and switches to two only when one would not fit the screen. */
  private async chooseColumns(): Promise<void> {
    const mode = this.config.layout.columns;
    const draw = () => { this.root.innerHTML = renderDashboard(this.dashboardModel()); };
    if (mode === 1 || mode === 2) { this.twoColumns = mode === 2; draw(); return; }
    if (this.shell.kind === 'pwa') { this.twoColumns = innerWidth >= 760; draw(); return; }
    const maxH = (await this.shell.maxPopupHeight?.().catch(() => 0)) || screen.availHeight - 40;
    this.twoColumns = false;
    draw();
    if (this.root.getBoundingClientRect().height > maxH) { this.twoColumns = true; draw(); }
  }

  private async sizePopup(): Promise<void> {
    if (this.shell.kind !== 'desktop') return;
    const h = Math.ceil(this.root.getBoundingClientRect().height);
    const w = this.twoColumns ? TWO_COL : ONE_COL;
    if (this.shell.setPopupSize) await this.shell.setPopupSize(w, h).catch(() => undefined);
    else await this.shell.setPopupHeight?.(h).catch(() => undefined);
  }

  /** The keyboard way to reorder a card: swaps it with the visible card above or below, keeping cards not on screen where they are. */
  private async moveCard(card: HTMLElement, step: -1 | 1): Promise<void> {
    const list = card.parentElement, pid = card.dataset.pid;
    if (!list || !pid) return;
    const order = [...list.querySelectorAll<HTMLElement>('.card')].map((c) => c.dataset.pid!), at = order.indexOf(pid), to = at + step;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to]!, order[at]!];
    const pos = new Map(order.map((id, i) => [id, i]));
    this.config.providers.sort((a, b) => (pos.get(a.id) ?? 1e3 + this.config.providers.indexOf(a)) - (pos.get(b.id) ?? 1e3 + this.config.providers.indexOf(b)));
    await this.saveConfig();
    await this.render();
    document.getElementById(`handle-${pid}`)?.focus();
  }

  private bindSortables(): void {
    this.sortables.forEach((s) => s.destroy());
    this.sortables = [];
    for (const id of ['cards', 'provider-list']) {
      const el = document.getElementById(id);
      if (!el) continue;
      this.sortables.push(Sortable.create(el, {
        handle: '.handle', animation: 150, draggable: '.card',
        onEnd: () => {
          const order = [...el.querySelectorAll<HTMLElement>('.card')].map((c) => c.dataset.pid!);
          const pos = new Map(order.map((pid, i) => [pid, i]));
          // Cards not on screen (disabled ones on the dashboard) keep their place after the visible ones.
          this.config.providers.sort((a, b) => (pos.get(a.id) ?? 1e3 + this.config.providers.indexOf(a)) - (pos.get(b.id) ?? 1e3 + this.config.providers.indexOf(b)));
          void this.saveConfig();
        },
      }));
    }
  }

  private async updateTray(): Promise<void> {
    if (!this.shell.setTray) return;
    const t = this.snapshot ? tightest(this.dashboardModel()) : null;
    const size = (await this.shell.trayIconSize?.().catch(() => 0)) || 32;
    const pct = t?.m.usedPct ?? null;
    await this.shell.setTray({
      pngBase64: renderTrayIcon(pct, size, !this.systemDark.matches),
      tooltip: this.snapshot ? tooltip(this.snapshot, this.config) : 'Augur: not refreshed yet',
      title: pct == null ? '' : `${Math.round(pct)}%`,
    }).catch(() => undefined);
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
        if (Object.values(adopted.providers).some((p) => Object.keys(p.models).length)) { policy.providers = adopted.providers; await this.saveConfig(false); return; }
      } catch { /* an unreadable file falls through to the import file */ }
    }
    const text = await read(policyPathFor(this.config.exportPath, 'policy-import.json')).catch(() => null);
    if (!text) return;
    try { importPolicy(policy, JSON.parse(text)); } catch { return; }
    await this.saveConfig(false);
  }

  /**
   * Reads each provider's model list once a day, or one provider's list now when `only` names it. The desktop reads the lists,
   * since several need a login on this computer, and the phone gets the resulting models with the rules.
   */
  private async refreshModelLists(only?: string): Promise<void> {
    if (this.shell.kind !== 'desktop') return;
    const policy = this.config.policy ??= emptyPolicy(), added: string[] = [];
    for (const plugin of core.plugins(this.config)) {
      const pc = this.config.providers.find((p) => p.id === plugin.id);
      if (!plugin.listModels || !pc?.enabled || this.listing.has(plugin.id)) continue;
      if (only ? only !== plugin.id : !listDue(this.catalog[plugin.id])) continue;
      this.listing.add(plugin.id);
      if (this.view === 'rules') await this.render();
      const fetchedAt = new Date().toISOString();
      try {
        const models = await plugin.listModels(this.shell.host, pc.settings);
        this.catalog[plugin.id] = { fetchedAt, models, error: null };
        const mode = policy.providers[plugin.id]?.listMode ?? plugin.modelListMode ?? 'auto';
        if (mode === 'auto') added.push(...syncModelList(policy, plugin.id, plugin.labelPrefix ?? plugin.id, models));
      } catch (error) {
        this.catalog[plugin.id] = { fetchedAt, models: this.catalog[plugin.id]?.models ?? [], error: error instanceof Error ? error.message : String(error) };
      } finally {
        this.listing.delete(plugin.id);
      }
    }
    await this.shell.saveModelCatalog?.(this.catalog).catch(() => undefined);
    if (added.length) {
      await this.saveConfig(false);
      if (this.config.alerts.enabled) await this.shell.notify(`${added.length} new ${added.length === 1 ? 'model' : 'models'} to review`,
        'Routers skip a new model until its rules are confirmed. Open Model rules to set them.').catch(() => undefined);
    }
    if (this.view === 'rules' || added.length) await this.render();
  }

  /** policy.json changes only when a rule does, so it is written with the config, never on a usage refresh. */
  private async writePolicy(): Promise<void> {
    if (!this.shell.exportSnapshot || !this.config.exportPath || !this.config.policy) return;
    const file = buildPolicyFile(this.config.policy, core.policyProviders(this.config));
    try {
      await this.shell.exportSnapshot(policyPathFor(this.config.exportPath), JSON.stringify(file, null, 2));
      this.policyError = null;
    } catch (e) {
      this.policyError = e instanceof Error ? e.message : String(e);
    }
  }

  private async saveConfig(flash = true): Promise<void> {
    await this.shell.saveConfig(this.config);
    await this.writePolicy();
    if (flash) {
      this.savedFlash = this.policyError ? 'Saved, but policy.json was not written' : 'Saved';
      setTimeout(() => { this.savedFlash = null; if (this.view === 'settings') void this.render(); }, 1500);
    }
  }

  // ------------------------------------------------------------------ events

  private wireEvents(): void {
    this.root.addEventListener('click', (e) => void this.onClick(e));
    this.root.addEventListener('change', (e) => void this.onChange(e));
    this.root.addEventListener('input', (e) => {
      const t = e.target as HTMLElement;
      if (t.matches('[data-custom]')) this.customDraft = (t as HTMLTextAreaElement).value;
      if (t.matches('[data-rules-query]')) { this.rules.query = (t as HTMLInputElement).value; void this.render(); }
      if (t.matches('[data-color]')) {
        const pid = t.dataset.color!;
        this.provider(pid).settings.color = (t as HTMLInputElement).value;
        void this.saveConfig(false);
      }
    });
    this.root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if ((e.key === 'Enter' || e.key === ' ') && t.matches('[data-meter]')) { e.preventDefault(); this.toggleMeter(t.dataset.meter!); }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && t.matches('.handle')) { e.preventDefault(); void this.moveCard(t.closest<HTMLElement>('.card')!, e.key === 'ArrowUp' ? -1 : 1); }
      if (e.key === 'Enter' && t.matches('input[type=password]')) {
        (t.parentElement?.querySelector('[data-secret-save]') as HTMLButtonElement | null)?.click();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.view === 'service') { this.view = 'dashboard'; void this.render(); }
        else if (this.view === 'routes') { if (this.routesPage.sel) this.closeRoute(); else this.view = 'dashboard'; void this.render(); }
        else if (this.view === 'jobs') { if (this.jobs.sel) this.closeJob(); else { this.leaveJobs(); this.view = 'dashboard'; } void this.render(); }
        else if (this.view === 'rules') { if (this.rules.showHistory) this.rules.showHistory = false; else if (this.rules.sel) this.rules.sel = null; else this.view = 'dashboard'; void this.render(); }
        else if (this.view === 'settings' && !this.firstRun) { this.view = 'dashboard'; void this.render(); } else void this.shell.hidePopup?.();
      }
      if (e.key === 'F5') { e.preventDefault(); void this.refresh(true); }
    });
    this.root.addEventListener('mousemove', (e) => this.onHover(e));
    this.root.addEventListener('mouseleave', () => { this.tip.style.opacity = '0'; });
  }

  private provider(pid: string) {
    return this.config.providers.find((p) => p.id === pid)!;
  }

  private toggleMeter(key: string): void {
    this.expanded = this.expanded === key ? null : key;
    void this.render();
  }

  // ------------------------------------------------------------------ jobs

  /** One allowed `augur` command with its JSON output parsed. A stopped service exits non-zero but still says so in its output, so the exit code is returned, not thrown. */
  private async augur<T>(args: string[]): Promise<{ code: number; data: T | null; text: string; err: string }> {
    const r = await this.shell.dispatch!(args);
    let data: T | null = null;
    try { data = JSON.parse(r.stdout) as T; } catch { /* plain text output */ }
    return { code: r.code, data, text: r.stdout, err: r.stderr.trim() };
  }

  private jobsSig = '';

  private leaveJobs(): void {
    if (this.jobsTimer) { clearInterval(this.jobsTimer); this.jobsTimer = undefined; }
    this.jobs.sel = null; this.jobs.detail = null; this.jobsSig = '';
  }

  private closeJob(): void { this.jobs.sel = null; this.jobs.detail = null; }

  private async loadJobs(): Promise<void> {
    if (this.view !== 'jobs') { this.leaveJobs(); return; }
    if (!this.shell.dispatch) return;
    try {
      const st = await this.augur<{ running?: boolean; pid?: number }>(['service', 'status', '--json']);
      this.jobs.unavailable = '';
      this.jobs.service = { running: st.data?.running === true, pid: st.data?.pid ?? null };
      if (this.jobs.service.running) {
        const list = await this.augur<JobRecord[]>(['jobs', '--json', '--limit', '50']);
        this.jobs.jobs = Array.isArray(list.data) ? list.data : [];
        const acc = await this.augur<{ jobs: Array<{ id: string; accounted: Accounted }> }>(['usage', '--json', '--limit', '50']).catch(() => null);
        this.jobs.accounted = Object.fromEntries((acc?.data?.jobs ?? []).map((j) => [j.id, j.accounted]));
        if (this.jobs.sel) await this.loadDetail(this.jobs.sel);
      } else this.jobs.jobs = [];
    } catch (e) { this.jobs.unavailable = e instanceof Error ? e.message : String(e); }
    // The page is drawn again only when something on it changed, so a scrolled log is not sent back to the top every few seconds.
    const sig = JSON.stringify([this.jobs.service, this.jobs.unavailable, this.jobs.serviceNote, this.jobs.jobs, this.jobs.accounted, this.jobs.detail, this.jobs.busy]);
    if (this.view === 'jobs' && sig !== this.jobsSig) { this.jobsSig = sig; await this.render(); }
  }

  private async loadDetail(id: string): Promise<void> {
    const r = await this.augur<{ job: JobRecord; answer: string | null }>(['result', id, '--json']);
    if (!r.data?.job) return;
    const [out, err] = await Promise.all([this.shell.dispatch!(['logs', id]), this.shell.dispatch!(['logs', id, '--stderr'])]);
    if (this.jobs.sel === id) this.jobs.detail = { job: r.data.job, result: r.data.answer ?? '', stdout: out.stdout, stderr: err.stdout };
  }

  private async openJob(id: string): Promise<void> {
    this.jobs.sel = id; this.jobs.detail = null;
    await this.render();
    await this.loadJobs();
  }

  private async controlService(action: 'start' | 'stop'): Promise<void> {
    this.jobs.busy = true; this.jobs.serviceNote = '';
    await this.render();
    try {
      const r = await this.augur(['service', action, '--json']);
      this.jobs.serviceNote = r.code === 0 ? '' : r.err || 'That did not work. The service keeps its own log in the dispatch data folder.';
    } catch (e) { this.jobs.serviceNote = e instanceof Error ? e.message : String(e); }
    this.jobs.busy = false;
    await this.loadJobs();
  }

  private async cancelJob(id: string): Promise<void> {
    this.jobs.busy = true;
    await this.render();
    try { await this.augur(['cancel', id, '--json']); } catch (e) { this.jobs.serviceNote = e instanceof Error ? e.message : String(e); }
    this.jobs.busy = false;
    await this.loadJobs();
  }

  // ------------------------------------------------------------------ service

  private async loadService(): Promise<void> {
    const page = this.servicePage;
    page.runJobs = this.config.dispatch?.runJobs === true;
    if (!this.shell.dispatch) return;
    try {
      const cfg = await this.augur<ConfigLine[]>(['config', '--json']);
      page.lines = Array.isArray(cfg.data) ? cfg.data : null;
      const st = await this.augur<{ running?: boolean; pid?: number }>(['service', 'status', '--json']);
      page.service = { running: st.data?.running === true, pid: st.data?.pid ?? null };
      page.unavailable = '';
    } catch (e) { page.unavailable = e instanceof Error ? e.message : String(e); }
    if (this.view === 'service' || (this.view === 'settings' && this.firstRun)) await this.render();
  }

  /** Usage only stops the service when nothing is running on it; Also run jobs starts it. */
  private async setDispatchMode(runJobs: boolean): Promise<void> {
    this.config.dispatch = { runJobs };
    await this.saveConfig(false);
    const page = this.servicePage;
    page.note = ''; page.error = '';
    if (this.shell.dispatch) {
      try {
        const r = await this.augur(['service', runJobs ? 'start' : 'stop', ...(runJobs ? [] : ['--if-idle']), '--json']);
        if (r.code !== 0 && runJobs) page.error = r.err || 'The service did not start. It keeps a log in the dispatch data folder.';
        if (r.code !== 0 && !runJobs) page.note = 'A job is still running, so the service was left running. It stops the next time you choose this with no job running.';
      } catch (e) { page.error = e instanceof Error ? e.message : String(e); }
    }
    await this.render();
    await this.loadService();
  }

  private async restartService(): Promise<void> {
    const page = this.servicePage;
    page.busy = true; page.note = ''; page.error = '';
    await this.render();
    try {
      await this.augur(['service', 'stop', '--json']);
      const r = await this.augur(['service', 'start', '--json']);
      if (r.code !== 0) page.error = r.err || 'The service did not start again.';
      else page.note = 'Restarted. Jobs that were running kept going.';
    } catch (e) { page.error = e instanceof Error ? e.message : String(e); }
    page.busy = false;
    await this.loadService();
  }

  /** A setting on the Service page changed. It is written at once; a running service reads it after a restart. */
  private async onServiceField(t: HTMLInputElement): Promise<boolean> {
    const key = t.dataset.cfg ?? t.dataset.cfgItem;
    if (!key || !this.shell.dispatch) return false;
    let value: string;
    if (t.dataset.cfgItem) value = [...this.root.querySelectorAll<HTMLInputElement>(`[data-cfg-item="${key}"]`)].filter((x) => x.checked).map((x) => x.value).join(',');
    else value = t.type === 'checkbox' ? String(t.checked) : t.value;
    const page = this.servicePage;
    try {
      const r = await this.augur(['config', 'set', key, value]);
      page.error = r.code === 0 ? '' : r.err || 'That value was not accepted.';
      page.note = r.code === 0 ? 'Saved. Restart the service to use it.' : '';
    } catch (e) { page.error = e instanceof Error ? e.message : String(e); }
    await this.loadService();
    return true;
  }

  // ------------------------------------------------------------------ routes

  private closeRoute(): void { Object.assign(this.routesPage, { sel: null, draft: null, formError: '', confirmDelete: false, testNote: '', keyStored: null, keyNote: '' }); }

  /** Asks the credential store whether the route being edited has a key, and redraws. Only the yes or no comes back. */
  private async refreshKeyState(): Promise<void> {
    const page = this.routesPage, d = page.draft;
    if (!d || d.options.keySource !== 'store' || !page.canTest || !/^[a-z][a-z0-9_-]*$/.test(d.name)) { page.keyStored = null; return; }
    page.keyStored = await this.shell.hasSecret(routeSecretName(d.name)).catch(() => null);
    await this.render();
  }

  private async saveRouteKey(): Promise<void> {
    const page = this.routesPage, d = page.draft, input = document.getElementById('rt-key') as HTMLInputElement | null;
    if (!d || !input) return;
    if (!/^[a-z][a-z0-9_-]*$/.test(d.name)) { page.keyNote = 'Give the route a valid name first.'; await this.render(); return; }
    const value = input.value.trim();
    if (!value) { page.keyNote = 'Paste the key first.'; await this.render(); return; }
    try {
      await this.shell.setSecret(routeSecretName(d.name), value);
      input.value = '';
      page.keyStored = true; page.keyNote = 'The key is saved in the Windows credential store.';
    } catch (e) { page.keyNote = `The key was not saved. ${e instanceof Error ? e.message : String(e)}`; }
    await this.render();
  }

  private async clearRouteKey(): Promise<void> {
    const page = this.routesPage, d = page.draft;
    if (!d) return;
    try {
      await this.shell.deleteSecret(routeSecretName(d.name));
      page.keyStored = false; page.keyNote = 'The key was removed.';
    } catch (e) { page.keyNote = `The key was not removed. ${e instanceof Error ? e.message : String(e)}`; }
    await this.render();
  }

  private openRoute(name: string): void {
    const r = this.routesPage.file?.routes.find((x) => x.name === name);
    if (!r) return;
    Object.assign(this.routesPage, { sel: name, draft: draftOf(r), formError: '', note: '', confirmDelete: false, testNote: '', keyStored: null, keyNote: '' });
    void this.refreshKeyState();
  }

  /** Model labels the rules already hold, as provider/model, for the model field to offer. */
  private knownModels(): string[] {
    return Object.entries(this.config.policy?.providers ?? {}).flatMap(([pid, p]) => Object.keys(p.models).map((label) => `${pid}/${label}`)).sort();
  }

  private async loadRoutes(): Promise<void> {
    const read = this.shell.host.readHomeFile;
    const page = this.routesPage;
    page.canTest = this.shell.dispatch !== undefined;
    page.models = this.knownModels();
    try {
      const parsed = parseRoutesText(read ? await read(ROUTES_PATH) : null);
      if (parsed.ok) { page.file = parsed.file; page.error = ''; } else { page.file = null; page.error = parsed.error; }
    } catch (e) { page.file = null; page.error = e instanceof Error ? e.message : String(e); }
    // The service knows which routes it can start; without it running, the page still edits the file.
    page.health = null;
    if (this.shell.dispatch && page.file) {
      try {
        const r = await this.augur<Array<{ name: string; problem: string | null }>>(['routes', '--json']);
        if (Array.isArray(r.data)) page.health = Object.fromEntries(r.data.map((x) => [x.name, x.problem]));
      } catch { /* the service is not running */ }
    }
    if (this.view === 'routes') await this.render();
  }

  private async writeRoutes(name: string, draft: ReturnType<typeof emptyDraft> | null, done: string): Promise<void> {
    const page = this.routesPage, write = this.shell.host.writeHomeFileAtomic;
    if (!page.file || !write) return;
    page.busy = true; page.formError = '';
    await this.render();
    try {
      await write(ROUTES_PATH, writeRoute(page.file, name, draft));
      this.closeRoute();
      page.note = done;
      page.busy = false;
      await this.loadRoutes();
    } catch (e) {
      page.busy = false;
      page.formError = `routes.json was not written. ${e instanceof Error ? e.message : String(e)}`;
      await this.render();
    }
  }

  /** Sends the fixed test prompt through a saved route and waits for the job, reporting what came of it in a sentence. */
  private async testRoute(name: string): Promise<void> {
    const page = this.routesPage;
    if (!name || page.testing) return;
    page.testing = true; page.testNote = '';
    await this.render();
    const say = async (text: string) => { page.testNote = text; page.testing = false; await this.render(); };
    try {
      const sent = await this.augur<{ id?: string }>(['test', name, '--json']);
      if (!sent.data?.id) return await say(sent.err || 'The service did not accept the test. Start it on the Jobs page first.');
      const id = sent.data.id;
      for (let i = 0; i < 75; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await this.augur<{ job: JobRecord; answer: string | null }>(['result', id, '--json']);
        const job = r.data?.job;
        if (!job || !['completed', 'failed', 'artifact_validation_failed', 'cancelled', 'killed', 'lost'].includes(job.state)) continue;
        if (job.state === 'completed') return await say(`${name} works. The model answered${r.data?.answer ? `: ${r.data.answer.trim().slice(0, 80)}` : '.'}`);
        return await say(`${name} did not work. ${job.reason ?? `The job ended as ${job.state}.`}`);
      }
      await say(`${name} had not finished after 2.5 minutes. Its job is still on the Jobs page.`);
    } catch (e) { await say(e instanceof Error ? e.message : String(e)); }
  }

  private async saveRoute(): Promise<void> {
    const page = this.routesPage, d = page.draft;
    if (!d || !page.file) return;
    const problem = checkDraft(d, page.file.routes.map((r) => r.name), page.sel === '+');
    if (problem) { page.formError = problem; await this.render(); return; }
    await this.writeRoutes(d.name, d, page.sel === '+' ? `Added ${d.name}.` : `Saved ${d.name}.`);
  }

  private async deleteRoute(): Promise<void> {
    const page = this.routesPage;
    if (page.sel && page.sel !== '+') await this.writeRoutes(page.sel, null, `Deleted ${page.sel}.`);
  }

  /** A form field on the Routes page changed. Only a new adapter redraws the form, since it changes which options are shown. */
  private onRouteField(t: HTMLInputElement): boolean {
    const d = this.routesPage.draft;
    if (!d || (!t.dataset.rt && !t.dataset.rtOpt)) return false;
    if (t.dataset.rtOpt) {
      d.options[t.dataset.rtOpt] = t.value;
      // The key source decides which fields are shown, so a change redraws the form and looks up the key.
      if (t.dataset.rtOpt === 'keySource') { this.routesPage.keyNote = ''; void this.render().then(() => this.refreshKeyState()); }
    }
    else if (t.dataset.rt === 'name') d.name = t.value.trim();
    else if (t.dataset.rt === 'model') d.model = t.value.trim();
    else if (t.dataset.rt === 'notes') d.notes = t.value;
    else if (t.dataset.rt === 'budgetUsd') d.budgetUsd = t.value;
    else if (t.dataset.rt === 'budgetJobs') d.budgetJobs = t.value;
    else if (t.dataset.rt === 'budgetPer') d.budgetPer = t.value;
    else if (t.dataset.rt === 'fallback') d.fallback = t.value;
    else if (t.dataset.rt === 'delegation') d.delegation = t.checked;
    else if (t.dataset.rt === 'adapter') { d.adapter = t.value; this.routesPage.formError = ''; void this.render(); }
    return true;
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-open],[data-collapse],[data-meter],[data-secret-save],[data-secret-del],[data-set],[data-open-provider],[data-color-reset],[data-signin],[data-rsel],[data-rprov],[data-rfilter],[data-status],[data-bulk],[data-undo],[data-add-model],[data-pause-clear],[data-list-now],[data-job],[data-route],[data-dial]');
    if (!t) return;
    if (this.view === 'rules' && await this.onRulesClick(t)) return;
    if (t.dataset.job) { await this.openJob(t.dataset.job); return; }
    if (t.dataset.route) { this.openRoute(t.dataset.route); await this.render(); return; }
    if (t.dataset.open) { e.preventDefault(); await this.shell.openUrl(t.dataset.open); return; }
    if (t.dataset.signin) { await this.shell.openSignIn?.(t.dataset.signin); return; }
    if (t.dataset.collapse) {
      const pid = t.dataset.collapse, list = this.config.layout.collapsed;
      this.config.layout.collapsed = list.includes(pid) ? list.filter((x) => x !== pid) : [...list, pid];
      await this.saveConfig(false); await this.render(); return;
    }
    if (t.dataset.meter) { if (!(e.target as HTMLElement).closest('a,button')) this.toggleMeter(t.dataset.meter); return; }
    if (t.dataset.openProvider) { this.openProvider = this.openProvider === t.dataset.openProvider ? null : t.dataset.openProvider; await this.render(); return; }
    if (t.dataset.set) {
      const v = t.dataset.value!;
      if (t.dataset.set === 'theme') this.config.layout.theme = v as AppConfig['layout']['theme'];
      if (t.dataset.set === 'columns') this.config.layout.columns = v === 'auto' ? 'auto' : (Number(v) as 1 | 2);
      this.applyTheme(); await this.saveConfig(); await this.render(); await this.updateTray(); return;
    }
    if (t.dataset.colorReset) { delete this.provider(t.dataset.colorReset).settings.color; await this.saveConfig(); await this.render(); return; }
    if (t.dataset.secretSave || t.dataset.secretDel) {
      const [pid, key] = (t.dataset.secretSave ?? t.dataset.secretDel)!.split('|') as [string, string];
      const name = `${pid}.${key}`;
      if (t.dataset.secretSave) {
        const input = document.getElementById(`f-${pid}-${key}`) as HTMLInputElement | null;
        const value = input?.value.trim();
        if (!value) return;
        await this.shell.setSecret(name, value);
        if (input) input.value = '';
        this.provider(pid).enabled = true;
        await this.saveConfig(false);
      } else {
        await this.shell.deleteSecret(name);
      }
      await this.refreshSecrets();
      this.savedFlash = t.dataset.secretSave ? 'Key saved' : 'Key removed';
      await this.render();
      setTimeout(() => { this.savedFlash = null; if (this.view === 'settings') void this.render(); }, 1500);
      return;
    }
    switch (t.dataset.action) {
      case 'refresh': await this.refresh(true); break;
      case 'update-check': await this.checkForUpdate(false); break;
      case 'update-install': await this.installUpdate(); break;
      case 'settings': this.view = 'settings'; await this.render(); break;
      case 'retry-policy': await this.writePolicy(); await this.render(); break;
      case 'rules': this.view = 'rules'; this.rules.showHistory = false; if (t.dataset.value) this.rules.filter = t.dataset.value as RulesFilter; await this.render(); break;
      case 'rules-dial': this.rules.dialOpen = !this.rules.dialOpen; this.rules.dialPlan = null; this.rules.dialError = ''; await this.render(); break;
      case 'rules-history': this.rules.showHistory = !this.rules.showHistory; await this.render(); break;
      case 'back': this.leaveJobs(); this.view = 'dashboard'; await this.render(); break;
      case 'jobs': this.view = 'jobs'; this.jobs.sel = null; this.jobs.detail = null; this.jobsTimer ??= setInterval(() => { void this.loadJobs(); }, 3000); await this.render(); void this.loadJobs(); break;
      case 'dispatch-tab':
        if (t.dataset.value === 'service') { this.leaveJobs(); this.view = 'service'; await this.render(); await this.loadService(); }
        else if (t.dataset.value === 'routes') { this.leaveJobs(); this.view = 'routes'; this.closeRoute(); await this.render(); await this.loadRoutes(); }
        else { this.view = 'jobs'; this.jobs.sel = null; this.jobs.detail = null; this.jobsTimer ??= setInterval(() => { void this.loadJobs(); }, 3000); await this.render(); void this.loadJobs(); }
        break;
      case 'dispatch-mode': await this.setDispatchMode(t.dataset.value === 'jobs'); break;
      case 'dispatch-classifier': {
        const r = await this.augur(['config', 'set', 'decision.backend', t.dataset.value ?? 'none']);
        this.servicePage.error = r.code === 0 ? '' : r.err || 'That choice was not accepted.';
        if (r.code === 0) await this.restartService(); else await this.loadService();
        await this.render();
        break;
      }
      case 'service-restart': await this.restartService(); break;
      case 'route-new': this.routesPage.sel = '+'; this.routesPage.draft = emptyDraft(); this.routesPage.formError = ''; this.routesPage.note = ''; this.routesPage.confirmDelete = false; await this.render(); break;
      case 'route-key-save': await this.saveRouteKey(); break;
      case 'route-key-clear': await this.clearRouteKey(); break;
      case 'route-close': this.closeRoute(); await this.render(); break;
      case 'route-save': await this.saveRoute(); break;
      case 'route-test': await this.testRoute(t.dataset.id ?? ''); break;
      case 'route-ask-delete': this.routesPage.confirmDelete = true; await this.render(); break;
      case 'route-delete': await this.deleteRoute(); break;
      case 'job-close': this.closeJob(); await this.render(); break;
      case 'jobs-refresh': await this.loadJobs(); break;
      case 'service-start': case 'service-stop': await this.controlService(t.dataset.action === 'service-start' ? 'start' : 'stop'); break;
      case 'job-cancel': await this.cancelJob(t.dataset.id!); break;
      case 'theme': {
        const order: AppConfig['layout']['theme'][] = ['system', 'light', 'dark'];
        this.config.layout.theme = order[(order.indexOf(this.config.layout.theme) + 1) % 3]!;
        this.applyTheme(); await this.saveConfig(false); await this.render(); await this.updateTray(); break;
      }
      case 'finish-setup':
        this.firstRun = false; this.view = 'dashboard';
        await this.saveConfig(false); this.schedule(); await this.render(); await this.refresh(); break;
      case 'custom-example': {
        const cur = safeParse(this.customDraft);
        this.customDraft = JSON.stringify([...(Array.isArray(cur) ? cur : []), ...CUSTOM_EXAMPLE], null, 2);
        await this.render(); break;
      }
      case 'custom-save': await this.saveCustom(); break;
      case 'sync-pair': {
        const pwaUrl = this.pwaUrl();
        const { link, pairUrl } = await createPairing(this.shell, this.relay(), pwaUrl);
        this.sync = { ...link, pwaUrl, shareKeys: this.sync?.shareKeys };
        this.lastPush = 0;
        await this.saveConfig();
        this.showPairCode(pairUrl);
        void this.refresh();
        break;
      }
      case 'sync-show': {
        const key = await this.shell.host.secret('sync.key');
        if (key && this.sync) this.showPairCode(pairingUrl(this.sync.pwaUrl, this.sync, key));
        break;
      }
      case 'sync-scan': {
        const text = await scanQr().catch((err: Error) => { this.scanError = err.message; return null; });
        const link = text ? parsePairing(text) : null;
        if (text && !link) this.scanError = 'That code is not an Augur pairing code. Open Pair a phone in the desktop app and scan the code it shows.';
        if (link) await this.pairWith(await acceptPairing(this.shell, link));
        await this.render();
        break;
      }
      case 'sync-unpair':
        if (this.sync) this.sync = { ...this.sync, channel: '' };
        await Promise.all([this.shell.deleteSecret('sync.key'), this.shell.deleteSecret('sync.writeSecret')]);
        this.pairQr = this.pairUrl = null;
        await this.saveConfig(); await this.render(); break;
      case 'open-export': if (this.config.exportPath) await this.shell.openUrl('file://' + this.config.exportPath); break;
    }
  }

  private showPairCode(url: string): void {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    this.pairUrl = url;
    this.pairQr = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }).replace('<svg ', '<svg style="width:220px;height:220px;background:#fff;border-radius:8px" role="img" aria-label="Pairing code" ');
    void this.render();
  }

  private async saveCustom(): Promise<void> {
    const parsed = safeParse(this.customDraft);
    if (!Array.isArray(parsed)) { this.customError = 'Not a JSON list. Check the brackets and commas.'; await this.render(); return; }
    const bad = parsed.find((d) => !d || typeof d.id !== 'string' || typeof d.name !== 'string' || !d.requests || !d.auth);
    if (bad) { this.customError = 'Each definition needs id, name, auth and requests.'; await this.render(); return; }
    const clash = parsed.find((d) => core.plugins({ ...this.config, custom: [] }).some((p) => p.id === d.id));
    if (clash) { this.customError = `The id "${clash.id}" is already used by a built-in provider.`; await this.render(); return; }
    this.customError = '';
    this.config.custom = parsed;
    this.syncProviderList();
    await this.refreshSecrets();
    await this.saveConfig();
    await this.render();
  }

  /** One alert when a provider starts failing to refresh; it re-arms once that provider refreshes again. */
  private async alertFailedRefreshes(): Promise<void> {
    for (const p of Object.values(this.snapshot?.providers ?? {})) {
      if (!p.error) { this.failedRefresh.delete(p.id); continue; }
      if (!p.stale || this.failedRefresh.has(p.id)) continue;
      this.failedRefresh.add(p.id);
      if (!this.config.alerts.enabled) continue;
      const at = p.fetchedAt ? new Date(p.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      await this.shell.notify(`${p.name} did not refresh`, `Augur keeps showing the numbers from ${at} until a refresh works. ${p.error}`).catch(() => undefined);
    }
  }

  private async checkForUpdate(auto: boolean): Promise<void> {
    if (!this.shell.checkUpdate || this.update.status === 'checking' || this.update.status === 'installing') return;
    const before = this.update.available?.version;
    this.update.status = 'checking';
    if (this.view === 'settings') await this.render();
    try {
      this.update.available = await this.shell.checkUpdate();
      this.update.status = this.update.available ? 'available' : 'current';
    } catch {
      // A failed check keeps showing an update already found, so the button does not disappear.
      this.update.status = this.update.available ? 'available' : 'error';
    }
    const found = this.update.available?.version;
    if (found && found !== before) this.update.changes = await this.loadChanges(found);
    if (!found) this.update.changes = null;
    await this.render();
    if (auto) await this.autoInstall();
  }

  private async loadChanges(to: string): Promise<ReleaseChanges[] | null> {
    const from = this.update.version;
    if (!from) return null;
    const res = await this.shell.host.http({ url: CHANGELOG_URL(to), method: 'GET', timeoutMs: 15000 }).catch(() => null);
    return res?.status === 200 ? releaseChanges(res.body, from, to) : null;
  }

  private async autoInstall(): Promise<void> {
    if (this.update.status === 'available' && this.config.autoUpdate !== false && document.visibilityState === 'hidden') await this.installUpdate();
  }

  private async installUpdate(): Promise<void> {
    if (!this.shell.installUpdate || this.update.status === 'installing') return;
    this.update.status = 'installing';
    this.tip.style.opacity = '0';
    await this.render();
    try {
      await this.shell.installUpdate();
    } catch {
      this.update.status = 'error';
      await this.render();
    }
  }

  private get device(): string { return this.shell.kind === 'desktop' ? 'desktop' : 'phone'; }

  private async saveRules(): Promise<void> {
    await this.saveConfig(false);
    await this.render();
    if (this.sync?.channel) { clearTimeout(this.rulesTimer); this.rulesTimer = setTimeout(() => void this.syncRules(true), RULES_EDIT_DELAY_MS); }
  }

  private rulesTimer: ReturnType<typeof setTimeout> | undefined;
  private rulesSyncing = false;
  private lastRulesSync = 0;

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
      const direct = this.shell.kind === 'pwa';
      const remote = await pullRules(this.shell.host, link, direct);
      const local = this.config.policy;
      const merged = remote ? mergePolicy(local, remote) : local;
      if (JSON.stringify(merged.stamps) !== JSON.stringify(local.stamps) || merged.clock !== local.clock || policyDigest(merged) !== policyDigest(local)) {
        this.config.policy = merged;
        await this.saveConfig(false);
        if (this.view === 'rules' || this.view === 'routes') await this.render();
      }
      if (!remote || policyDigest(merged) !== policyDigest(remote)) await pushRules(this.shell.host, link, merged, direct);
    } catch {
      // The relay was unreachable or refused the write; the next comparison tries again.
    } finally { this.rulesSyncing = false; }
  }

  /** Handles a click on the rules page. Returns false when the click belongs to the shared handler. */
  private async onRulesClick(t: HTMLElement): Promise<boolean> {
    const d = t.dataset, policy = this.config.policy ??= emptyPolicy();
    if (d.rsel !== undefined) { this.rules.sel = d.rsel ? { provider: d.rsel, model: d.rmodel || null } : null; this.rules.addError = ''; await this.render(); return true; }
    if (d.rprov) { const o = this.rules.open; if (o.has(d.rprov)) o.delete(d.rprov); else o.add(d.rprov); await this.render(); return true; }
    if (d.rfilter) { this.rules.filter = d.rfilter as RulesFilter; await this.render(); return true; }
    if (d.status) { const [pid = '', label = ''] = d.status.split('|'); setModelStatus(policy, pid, label, d.value as ModelEntryStatus, this.device); await this.saveRules(); return true; }
    if (d.listNow) { void this.refreshModelLists(d.listNow); return true; }
    if (d.pauseClear) { setField(policy, d.pauseClear, undefined, this.device); await this.saveRules(); return true; }
    if (d.undo) { const c = policy.history[Number(d.undo)]; if (c) undoChange(policy, c, this.device); await this.saveRules(); return true; }
    if (d.addModel) {
      const input = document.getElementById('r-add') as HTMLInputElement | null, id = input?.value.trim() ?? '';
      if (!/^[A-Za-z0-9][\w.:/-]*$/.test(id)) { this.rules.addError = 'Enter the model id as the provider writes it, with no spaces.'; await this.render(); return true; }
      const prefix = this.pluginMap().get(d.addModel)?.labelPrefix ?? d.addModel, label = `${prefix}/${id}`;
      const name = this.catalog[d.addModel]?.models.find((x) => x.id === id)?.name;
      if (!addModels(policy, d.addModel, [{ label, id, name }], 'manual').length) { this.rules.addError = `${id} is already listed.`; await this.render(); return true; }
      this.rules.addError = ''; this.rules.open.add(d.addModel); this.rules.sel = { provider: d.addModel, model: label };
      await this.saveRules(); return true;
    }
    if (d.dial) {
      const r = this.rules;
      if (d.dial === 'close') { r.dialOpen = false; r.dialPlan = null; r.dialError = ''; await this.render(); return true; }
      const choices = dialEndChoices({ snapshot: this.snapshot, providers: core.policyProviders(this.config) });
      const chosen = r.dialEnd === 'custom' || !choices.length ? null : choices.find((c) => c.value === r.dialEnd) ?? choices[0];
      const until = chosen ? chosen.until : r.dialCustom ? new Date(r.dialCustom).toISOString() : '';
      if (d.dial === 'preview') {
        if (!until || Date.parse(until) <= Date.now()) { r.dialError = 'Pick a time in the future.'; r.dialPlan = null; } else { r.dialError = ''; r.dialPlan = planDialBack(policy, until); }
        await this.render(); return true;
      }
      if (d.dial === 'apply' && r.dialPlan) {
        for (const item of r.dialPlan.items) setField(policy, item.path, pauseValue(item, r.dialPlan.until), this.device);
        const n = r.dialPlan.items.length;
        this.rules.note = `Dialed back ${n} ${n === 1 ? 'model' : 'models'} until ${new Date(r.dialPlan.until).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
        r.dialOpen = false; r.dialPlan = null;
        await this.saveRules(); return true;
      }
      return true;
    }
    if (d.bulk) {
      const picked = [...this.rules.picked].map((k) => k.split('|') as [string, string]);
      const n = picked.length, count = `${n} ${n === 1 ? 'model' : 'models'}`;
      if (d.bulk === 'clear') { this.rules.picked.clear(); this.rules.note = ''; this.rules.bulkTier = ''; this.rules.preview = null; }
      else if (d.bulk === 'preview') {
        const r = previewBulk(policy, this.rules.picked, this.rules.bulkField as BulkPreview['field'], this.rules.bulkValue);
        if ('error' in r) { this.rules.note = r.error; this.rules.preview = null; } else { this.rules.preview = r; this.rules.note = ''; }
        await this.render(); return true;
      }
      else if (d.bulk === 'preview-cancel') { this.rules.preview = null; await this.render(); return true; }
      else if (d.bulk === 'apply-field') {
        const pv = this.rules.preview;
        if (!pv) return true;
        for (const c of pv.changes) setField(policy, c.path, pv.value, this.device);
        const label = BULK_FIELDS.find((f) => f.field === pv.field)?.label ?? pv.field, k = pv.changes.length;
        this.rules.note = `${label} changed on ${k} ${k === 1 ? 'model' : 'models'}.`;
        this.rules.preview = null;
      }
      else if (d.bulk === 'activity') {
        const act = (document.getElementById('r-bulk-act') as HTMLSelectElement).value, level = (document.getElementById('r-bulk-level') as HTMLSelectElement).value;
        for (const [pid, label] of picked) setFieldMany(policy, pid, [label], `activities.${act}`, level === '' ? undefined : level === 'none' ? null : level, this.device);
        const shown = level === '' ? 'the provider default' : level === 'none' ? 'not allowed' : WEIGHT_LABELS[level as keyof typeof WEIGHT_LABELS];
        this.rules.note = `${ACTIVITY_LABELS[act as keyof typeof ACTIVITY_LABELS]} set to ${shown} on ${count}.`;
      } else {
        for (const [pid, label] of picked) setModelStatus(policy, pid, label, d.bulk as ModelEntryStatus, this.device);
        this.rules.note = `${d.bulk === 'confirmed' ? 'Confirmed' : 'Hid'} ${count}.`;
      }
      await this.saveRules(); return true;
    }
    return false;
  }

  /** Handles an edit on the rules page. Returns false for inputs the shared handler owns. */
  /** Pulling the phone app down: read every provider again, pull the desktop's latest, look for newer app files, and reload on them. */
  private async pullRefresh(): Promise<void> {
    await this.refresh(true).catch(() => undefined);
    try { await (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* offline: the saved files stay */ }
    location.reload();
  }

  /** Back to the main usage view, closing whatever page or detail was open. Every way of opening the panel starts here. */
  private goHome(): void {
    if (this.view === 'jobs') { if (this.jobs.sel) this.closeJob(); this.leaveJobs(); }
    if (this.view === 'routes' && this.routesPage.sel) this.closeRoute();
    this.rules.showHistory = false; this.rules.sel = null;
    this.view = 'dashboard';
  }

  private async onRulesChange(t: HTMLInputElement): Promise<boolean> {
    const d = t.dataset, policy = this.config.policy ??= emptyPolicy();
    if (d.wait) {
      const [wp = '', wm = ''] = d.wait.split('|'), entry = policy.providers[wp]?.models[wm];
      const now = entry?.rule.useAfter ?? policy.providers[wp]?.defaults.useAfter ?? [];
      const next = t.checked ? [...new Set([...now, t.value])] : now.filter((x) => x !== t.value);
      setField(policy, d.wait, next.length ? next : undefined, this.device);
      await this.saveRules(); return true;
    }
    if (d.pick) { if (t.checked) this.rules.picked.add(d.pick); else this.rules.picked.delete(d.pick); this.rules.note = ''; this.rules.bulkTier = ''; this.rules.preview = null; await this.render(); return true; }
    if (d.dialEnd !== undefined) { this.rules.dialEnd = t.value; this.rules.dialPlan = null; this.rules.dialError = ''; await this.render(); return true; }
    if (d.dialCustom !== undefined) { this.rules.dialCustom = t.value; this.rules.dialPlan = null; this.rules.dialError = ''; return true; }
    if (d.bulkField !== undefined) { this.rules.bulkField = t.value; this.rules.bulkValue = ''; this.rules.preview = null; await this.render(); return true; }
    if (d.bulkValue !== undefined) { this.rules.bulkValue = t.value; this.rules.preview = null; await this.render(); return true; }
    if (d.pickAll) {
      const shown = [...document.querySelectorAll<HTMLInputElement>('[data-pick]')].map((x) => x.dataset.pick!).filter((k) => k.startsWith(`${d.pickAll}|`));
      for (const k of shown) if (t.checked) this.rules.picked.add(k); else this.rules.picked.delete(k);
      this.rules.note = ''; this.rules.bulkTier = ''; this.rules.preview = null;
      await this.render(); return true;
    }
    if (d.bulkTier !== undefined) {
      if (t.value) {
        for (const k of this.rules.picked) { const [pid, label] = k.split('|') as [string, string]; setFieldMany(policy, pid, [label], 'dataTier', t.value, this.device); }
        const n = this.rules.picked.size;
        this.rules.bulkTier = t.value;
        this.rules.note = `Most sensitive data set to ${DATA_TIER_LABELS[t.value as DataTier]} on ${n} ${n === 1 ? 'model' : 'models'}.`;
      }
      await this.saveRules(); return true;
    }
    if (d.pauseMode !== undefined) { this.rules.pauseMode = t.value === 'weights' ? 'weights' : 'off'; await this.render(); return true; }
    if (d.pauseWeight) { this.rules.pauseWeights[d.pauseWeight] = t.value; await this.render(); return true; }
    if (d.pauseUntil || d.pauseMeter) {
      const path = (d.pauseUntil ?? d.pauseMeter)!, pid = path.split('|')[0]!;
      const meter = d.pauseMeter ? pauseResets(this.snapshot, pid).meters.find((x) => x.id === t.value) : undefined;
      const until = d.pauseMeter ? meter?.resetsAt : t.value ? new Date(t.value).toISOString() : null;
      const weights = this.rules.pauseMode === 'weights'
        ? Object.fromEntries(Object.entries(this.rules.pauseWeights).filter(([, v]) => v !== '').map(([a, v]) => [a, v === 'none' ? null : v])) : null;
      if (until) setField(policy, path, { until, weights: weights && Object.keys(weights).length ? weights : null, ...(meter ? { meter: meter.id } : {}) }, this.device);
      if (until) { this.rules.pauseMode = 'off'; this.rules.pauseWeights = {}; }
      await this.saveRules(); return true;
    }
    if (!d.rule) return false;
    const kind = d.kind ?? 'text', v = t.value;
    {
      const value = v === '' ? undefined : kind === 'bool' ? v === 'yes' : kind === 'tri' ? (v === 'yes' ? true : v === 'no' ? false : null) : kind === 'act' && v === 'none' ? null : kind === 'num' ? Number(v) : kind === 'text' ? v.trim() || undefined : v;
      if (kind === 'num' && typeof value === 'number' && !Number.isFinite(value)) return true;
      setField(policy, d.rule, value, this.device);
    }
    await this.saveRules(); return true;
  }

  private async onChange(e: Event): Promise<void> {
    const t = e.target as HTMLInputElement;
    const d = t.dataset;
    if (this.view === 'rules' && await this.onRulesChange(t)) return;
    if (this.view === 'routes' && this.onRouteField(t)) return;
    if (this.view === 'service' && await this.onServiceField(t)) return;
    if (d.toggle) {
      const [kind, pid, key] = d.toggle.split(':');
      if (kind === 'enabled') this.provider(pid!).enabled = t.checked;
      else if (kind === 'setting') this.provider(pid!).settings[key!] = t.checked;
      else if (kind === 'alerts') this.config.alerts.enabled = t.checked;
      else if (kind === 'autostart') { await this.shell.setAutostart?.(t.checked); this.autostart = t.checked; return; }
      else if (kind === 'sharekeys') { if (this.sync) this.sync = { ...this.sync, shareKeys: t.checked }; this.lastPush = 0; await this.saveConfig(); void this.refresh(); return; }
      else if (kind === 'openonlaunch') { this.config.openOnLaunch = t.checked; await this.saveConfig(); return; }
      else if (kind === 'autoupdate') { this.config.autoUpdate = t.checked; await this.saveConfig(); if (t.checked) void this.autoInstall(); return; }
      await this.saveConfig(); if (kind === 'enabled' && !this.firstRun) void this.refresh(); await this.render(); return;
    }
    if (d.providerRefresh) { this.provider(d.providerRefresh).refreshSeconds = t.value ? Number(t.value) : null; await this.saveConfig(); return; }
    if (d.field) { const [pid, key] = d.field.split('|') as [string, string]; this.provider(pid).settings[key] = t.value; await this.saveConfig(); return; }
    if (d.meterVis) {
      const [pid, id] = d.meterVis.split('|') as [string, string];
      const list = this.config.layout.hiddenMeters[pid] ?? [];
      this.config.layout.hiddenMeters[pid] = t.checked ? list.filter((x) => x !== id) : [...new Set([...list, id])];
      await this.saveConfig(); return;
    }
    if (t.matches('[data-color]')) { await this.saveConfig(); await this.render(); return; }
    if (d.sync) {
      const v = t.value.trim();
      if (d.sync === 'relay') {
        if (this.shell.kind === 'pwa') setRelayUrl(v);
        this.sync = { ...this.sync, relay: v, channel: this.sync?.channel ?? '', pwaUrl: this.sync?.pwaUrl ?? '' };
      } else {
        this.sync = { ...this.sync, relay: this.sync?.relay ?? '', channel: this.sync?.channel ?? '', pwaUrl: v };
      }
      await this.saveConfig(); await this.render(); return;
    }
    if (t.matches('[data-hotkey]')) { this.config.hotkey = t.value.trim() || null; await this.applyHotkey(); await this.saveConfig(); await this.render(); return; }
    if (t.matches('[data-export]')) { this.config.exportPath = t.value.trim() || null; await this.saveConfig(); return; }
    if (d.alert) {
      const a = this.config.alerts;
      if (d.alert === 'pct') a.pctThresholds = t.value.split(/[,\s]+/).map(Number).filter((n) => n > 0 && n <= 100).sort((x, y) => x - y);
      else if (d.alert.startsWith('ratio:')) { const k = d.alert.slice(6) as 'session' | 'weekly' | 'other'; a.paceRatio[k] = t.value === '' ? null : Number(t.value); }
      else if (d.alert.startsWith('bal:')) { const k = d.alert.slice(4); if (t.value === '') delete a.balanceBelow[k]; else a.balanceBelow[k] = Number(t.value); }
      await this.saveConfig(); return;
    }
  }

  private onHover(e: MouseEvent): void {
    const target = e.target as Element;
    const sparkEl = target.closest?.('svg[data-spark]') as SVGElement | null;
    const chartEl = target.closest?.('svg[data-chart]') as SVGElement | null;
    const tip = this.tip;
    const updateEl = target.closest?.('[data-update]') as HTMLElement | null;
    if (updateEl) {
      tip.innerHTML = updateTip(this.update);
      tip.classList.add('rich');
      const r = updateEl.getBoundingClientRect();
      tip.style.left = Math.max(6, Math.min(r.right - tip.offsetWidth, innerWidth - tip.offsetWidth - 6)) + 'px';
      tip.style.top = r.bottom + 6 + 'px';
      tip.style.opacity = '1';
      return;
    }
    tip.classList.remove('rich');
    if (!sparkEl && !chartEl) { tip.style.opacity = '0'; this.root.querySelectorAll('.xhair').forEach((l) => l.setAttribute('opacity', '0')); return; }
    let label = '';
    if (sparkEl) {
      const [pid, mid] = sparkEl.dataset.spark!.split('|') as [string, string];
      const r = sparkEl.getBoundingClientRect(), cut = Date.now() - 24 * 3600e3;
      const t = cut + ((e.clientX - r.left) / r.width) * (Date.now() - cut);
      const near = nearest(core.series(this.history, pid, mid), t);
      if (near) label = `${Math.round(near[1])}% at ${new Date(near[0]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else if (chartEl) {
      const pts = JSON.parse(chartEl.dataset.chart!) as Array<[number, number]>;
      const x0 = Number(chartEl.dataset.x0), now = Number(chartEl.dataset.now), L = Number(chartEl.dataset.l), W = Number(chartEl.dataset.w);
      const r = chartEl.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      const t = x0 + ((vx - L) / (W - L)) * (now - x0);
      const near = nearest(pts.map(([s, v]) => [s * 1000, v] as [number, number]), t);
      if (near) {
        label = `${near[1]}% on ${new Date(near[0]).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
        const line = chartEl.querySelector('.xhair')!;
        const x = L + ((near[0] - x0) / (now - x0)) * (W - L);
        line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x)); line.setAttribute('opacity', '0.6');
      }
    }
    if (!label) return;
    tip.textContent = label;
    tip.style.left = Math.min(e.clientX + 10, innerWidth - tip.offsetWidth - 6) + 'px';
    tip.style.top = e.clientY - 26 + 'px';
    tip.style.opacity = '1';
  }
}

function nearest(pts: Array<[number, number]>, t: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (const p of pts) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
  return best;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function shortWindow(kind: string | undefined): string {
  return kind === 'session' ? '5h' : kind === 'weekly' ? 'wk' : kind === 'daily' ? 'day' : kind === 'monthly' ? 'mo' : '';
}

/** One line per provider for the tray tooltip (Windows caps tooltips at 127 characters). */
function tooltip(snap: Snapshot, config: AppConfig): string {
  const lines: string[] = [];
  for (const pc of config.providers) {
    const p = snap.providers[pc.id];
    if (!pc.enabled || !p) continue;
    const bits = p.meters.filter((m) => m.usedPct != null && m.windowKind !== 'credits').slice(0, 2).map((m) => `${Math.round(m.usedPct!)}% ${shortWindow(m.windowKind)}`.trim());
    const bal = p.money.find((m) => m.id === 'balance');
    if (bal?.amount != null) bits.push(`$${bal.amount.toFixed(2)}`);
    lines.push(`${p.name.split(' /')[0]} ${bits.join(', ') || (p.error ? 'error' : '-')}`);
  }
  const text = lines.join('\n');
  return text.length <= 127 ? text : text.slice(0, 127);
}

/** Compact one-line summary for other tools, such as a terminal hook that prints it on every prompt. */
export function summaryLine(snap: Snapshot, config: AppConfig): string {
  const parts: string[] = [];
  const reset = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return ' (resetting)';
    if (ms < 86400e3) return ` (resets ${span(ms).replace(' ', '')})`;
    return ` (resets ${new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })})`;
  };
  for (const pc of config.providers) {
    const p = snap.providers[pc.id];
    if (!pc.enabled || !p) continue;
    const bits: string[] = [];
    p.meters.forEach((m, i) => {
      if (m.usedPct == null || !['session', 'weekly', 'monthly'].includes(m.windowKind ?? '')) return;
      if (m.usedPct === 0 && i > 0) return;
      const scope = m.label.includes(', ') && !/all models/i.test(m.label) ? m.label.split(', ')[1] + ' ' : '';
      bits.push(`${scope}${Math.round(m.usedPct)}% ${shortWindow(m.windowKind)}${reset(m.resetsAt)}`);
    });
    for (const mo of p.money) if (mo.id === 'balance' && mo.amount != null) bits.push(`$${mo.amount.toFixed(2)} left`);
    const n = (p.notes ?? {}) as Record<string, unknown>;
    if (!bits.length && typeof n.latencyMs === 'number') bits.push(`answering, ${Math.round(n.latencyMs)} ms`);
    if (!bits.length && p.error) bits.push(`unavailable: ${p.error}`);
    parts.push(`${p.name.split(' /')[0]} ${bits.join(', ')}${p.stale && p.fetchedAt ? ` [stale, updated ${span(Date.now() - new Date(p.fetchedAt).getTime())} ago]` : ''}`);
  }
  return parts.join(' | ');
}

/** iPhone and iPad Safari have no install prompt, so the phone section explains Add to Home Screen. */
function iosInstallHint(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}
