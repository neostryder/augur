import Sortable from 'sortablejs';
import type { AppConfig, ProviderPlugin, Shell, Snapshot, UpdateInfo } from '@augur/core';
import * as core from './core';
import type { HistoryRow } from './core';
import { renderDashboard, tightest, type DashboardModel } from './views/dashboard';
import { CUSTOM_EXAMPLE, renderSettings, type SettingsModel } from './views/settings';
import { renderTrayIcon } from './trayicon';
import { span, until } from './util';
import qrcode from 'qrcode-generator';
import { HOSTED } from './hosted';
import { acceptPairingFromUrl, createPairing, mergeSynced, pullSnapshot, pushSnapshot } from './sync';
import { relayUrl, setRelayUrl } from './shells/browser';

type SyncConfig = NonNullable<AppConfig['sync']>;

const ONE_COL = 400;
const TWO_COL = 780;

// Each push is one KV write on the relay, so a paired phone gets a new copy at most every 10 minutes (144 writes a day).
const SYNC_PUSH_MS = 10 * 60_000;
const UPDATE_FIRST_CHECK_MS = 20_000;
const UPDATE_INTERVAL_MS = 6 * 3600_000;

export interface UpdateState {
  version: string | null;
  status: 'idle' | 'checking' | 'current' | 'available' | 'installing' | 'error';
  available: UpdateInfo | null;
}

export class App {
  private config!: AppConfig;
  private snapshot: Snapshot | null = null;
  private history: HistoryRow[] = [];
  private alertState: Record<string, unknown> = {};
  private view: 'dashboard' | 'settings' = 'dashboard';
  private firstRun = false;
  private busy = false;
  private expanded: string | null = null;
  private twoColumns = false;
  private secrets = new Set<string>();
  private autostart: boolean | null = null;
  private failedRefresh = new Set<string>();
  private lastPush = 0;
  private update: UpdateState = { version: null, status: 'idle', available: null };
  private openProvider: string | null = null;
  private customDraft = '[]';
  private customError = '';
  private savedFlash: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sortables: Sortable[] = [];
  private systemDark = matchMedia('(prefers-color-scheme: dark)');
  private pairQr: string | null = null;
  private pairUrl: string | null = null;
  private justPaired = false;

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
    this.firstRun = !saved;
    if (this.shell.kind === 'pwa') {
      const link = await acceptPairingFromUrl(this.shell);
      if (link) {
        this.sync = { relay: link.relay, channel: link.channel, pwaUrl: location.origin + location.pathname };
        if (!relayUrl()) setRelayUrl(link.relay);
        this.justPaired = true;
        await this.shell.saveConfig(this.config);
      }
    }
    [this.snapshot, this.history, this.alertState] = await Promise.all([
      this.shell.loadSnapshot(), this.shell.loadHistory() as Promise<HistoryRow[]>, this.shell.loadAlertState(),
    ]);
    this.customDraft = JSON.stringify(this.config.custom ?? [], null, 2);
    this.autostart = this.shell.getAutostart ? await this.shell.getAutostart().catch(() => null) : null;
    if (this.shell.checkUpdate) {
      this.update.version = await this.shell.appVersion?.().catch(() => null) ?? null;
      setTimeout(() => void this.checkForUpdate(true), UPDATE_FIRST_CHECK_MS);
      setInterval(() => void this.checkForUpdate(true), UPDATE_INTERVAL_MS);
      // An automatic install waits for the panel to close, so it never restarts the app under the pointer.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void this.autoInstall(); });
    }
    await this.refreshSecrets();

    if (this.firstRun) {
      this.view = 'settings';
      await this.preselectDetected();
    }
    this.applyTheme();
    this.systemDark.addEventListener('change', () => { this.applyTheme(); void this.render(); void this.updateTray(); });
    this.wireEvents();
    this.shell.on('refresh-requested', () => void this.refresh(true));
    this.shell.on('settings-requested', () => { this.view = 'settings'; void this.render(); });
    if (this.shell.kind === 'desktop') this.resizeWatch.observe(this.root);
    this.shell.on('popup-shown', () => {
      void this.render();
      const age = this.snapshot ? (Date.now() - new Date(this.snapshot.generatedAt).getTime()) / 1000 : Infinity;
      if (age > 60) void this.refresh();
    });
    setInterval(() => { if (this.view === 'dashboard' && document.visibilityState === 'visible') void this.render(); }, 30000);
    await this.render();
    await this.updateTray();
    if (!this.firstRun) { this.schedule(); void this.refresh(); }
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
    this.timer = setInterval(() => void this.refresh(), Math.max(60, this.config.refreshSeconds) * 1000);
  }

  /** force refreshes every provider now; otherwise each waits out its own interval. */
  async refresh(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    document.body.classList.add('busy');
    try {
      const map = this.pluginMap();
      // The phone cannot read command-line logins, so it skips those providers and takes
      // them from the paired desktop instead.
      const runConfig = this.shell.kind === 'pwa'
        ? { ...this.config, providers: this.config.providers.map((p) => ({ ...p, enabled: p.enabled && !map.get(p.id)?.needsLocalLogin })) }
        : this.config;
      this.snapshot = await core.collect(this.shell.host, runConfig, this.snapshot, force);
      this.history = core.appendHistory(this.history, this.snapshot);
      if (this.shell.kind === 'pwa' && this.sync?.channel) await this.pullFromDesktop(runConfig);
      const { alerts, firedState } = core.evaluateAlerts(this.snapshot, this.history, this.config, this.alertState);
      this.alertState = firedState;
      if (this.config.alerts.enabled) for (const a of alerts) await this.shell.notify(a.title, a.body).catch(() => undefined);
      await this.alertFailedRefreshes();
      await Promise.all([
        this.shell.saveSnapshot(this.snapshot), this.shell.saveHistory(this.history), this.shell.saveAlertState(this.alertState),
      ]);
      if (this.shell.kind === 'desktop' && this.sync?.channel && Date.now() - this.lastPush >= SYNC_PUSH_MS) {
        const pushed = await pushSnapshot(this.shell.host, this.sync, this.snapshot, this.history).then(() => true, () => false);
        if (pushed) this.lastPush = Date.now();
      }
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

  private async pullFromDesktop(runConfig: AppConfig): Promise<void> {
    const pulled = await pullSnapshot(this.shell.host, this.sync!).catch(() => null);
    if (!pulled || !this.snapshot) return;
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
      for (const id of synced) { const pc = this.config.providers.find((p) => p.id === id); if (pc) pc.enabled = true; }
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
      twoColumns: this.twoColumns, expanded: this.expanded, dark: this.isDark(), shellKind: this.shell.kind,
    };
  }

  private settingsModel(): SettingsModel {
    return {
      config: this.config, plugins: this.pluginMap(), snapshot: this.snapshot, secrets: this.secrets, shellKind: this.shell.kind,
      autostart: this.autostart, update: this.update, openProvider: this.openProvider, customDraft: this.customDraft, customError: this.customError,
      firstRun: this.firstRun, savedFlash: this.savedFlash,
      sync: this.sync, relay: this.relay(), pwaUrl: this.pwaUrl(), pairQr: this.pairQr, pairUrl: this.pairUrl,
    };
  }

  private async render(): Promise<void> {
    const focusId = (document.activeElement as HTMLElement | null)?.id;
    if (this.view === 'dashboard') {
      await this.chooseColumns();
    } else {
      this.twoColumns = false;
      this.root.innerHTML = renderSettings(this.settingsModel());
    }
    if (focusId) document.getElementById(focusId)?.focus();
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

  private async saveConfig(flash = true): Promise<void> {
    await this.shell.saveConfig(this.config);
    if (flash) {
      this.savedFlash = 'Saved';
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
      if (t.matches('[data-color]')) {
        const pid = t.dataset.color!;
        this.provider(pid).settings.color = (t as HTMLInputElement).value;
        void this.saveConfig(false);
      }
    });
    this.root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if ((e.key === 'Enter' || e.key === ' ') && t.matches('[data-meter]')) { e.preventDefault(); this.toggleMeter(t.dataset.meter!); }
      if (e.key === 'Enter' && t.matches('input[type=password]')) {
        (t.parentElement?.querySelector('[data-secret-save]') as HTMLButtonElement | null)?.click();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (this.view === 'settings' && !this.firstRun) { this.view = 'dashboard'; void this.render(); } else void this.shell.hidePopup?.(); }
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

  private async onClick(e: MouseEvent): Promise<void> {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-open],[data-collapse],[data-meter],[data-secret-save],[data-secret-del],[data-set],[data-open-provider],[data-color-reset],[data-signin]');
    if (!t) return;
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
      case 'back': this.view = 'dashboard'; await this.render(); break;
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
        this.sync = { ...link, pwaUrl };
        this.lastPush = 0;
        await this.saveConfig();
        this.showPairCode(pairUrl);
        void this.refresh();
        break;
      }
      case 'sync-show': {
        const key = await this.shell.host.secret('sync.key');
        if (key && this.sync) this.showPairCode(`${this.sync.pwaUrl.replace(/#.*$/, '')}#pair=${encodeURIComponent(this.sync.relay)}|${this.sync.channel}|${key}`);
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
    this.update.status = 'checking';
    if (this.view === 'settings') await this.render();
    try {
      this.update.available = await this.shell.checkUpdate();
      this.update.status = this.update.available ? 'available' : 'current';
    } catch {
      this.update.status = 'error';
    }
    if (this.view === 'settings') await this.render();
    if (auto) await this.autoInstall();
  }

  private async autoInstall(): Promise<void> {
    if (this.update.status === 'available' && this.config.autoUpdate !== false && document.visibilityState === 'hidden') await this.installUpdate();
  }

  private async installUpdate(): Promise<void> {
    if (!this.shell.installUpdate || this.update.status === 'installing') return;
    this.update.status = 'installing';
    if (this.view === 'settings') await this.render();
    try {
      await this.shell.installUpdate();
    } catch {
      this.update.status = 'error';
      if (this.view === 'settings') await this.render();
    }
  }

  private async onChange(e: Event): Promise<void> {
    const t = e.target as HTMLInputElement;
    const d = t.dataset;
    if (d.toggle) {
      const [kind, pid, key] = d.toggle.split(':');
      if (kind === 'enabled') this.provider(pid!).enabled = t.checked;
      else if (kind === 'setting') this.provider(pid!).settings[key!] = t.checked;
      else if (kind === 'alerts') this.config.alerts.enabled = t.checked;
      else if (kind === 'autostart') { await this.shell.setAutostart?.(t.checked); this.autostart = t.checked; return; }
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
    if (t.matches('[data-refresh]')) { this.config.refreshSeconds = Number(t.value); this.schedule(); await this.saveConfig(); return; }
    if (d.sync) {
      const v = t.value.trim();
      if (d.sync === 'relay') {
        if (this.shell.kind === 'pwa') setRelayUrl(v);
        this.sync = { relay: v, channel: this.sync?.channel ?? '', pwaUrl: this.sync?.pwaUrl ?? '' };
      } else {
        this.sync = { relay: this.sync?.relay ?? '', channel: this.sync?.channel ?? '', pwaUrl: v };
      }
      await this.saveConfig(); await this.render(); return;
    }
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
