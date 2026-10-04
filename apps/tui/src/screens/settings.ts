// The settings page lays out the window app's settings as a form and uses the same wording. Every change saves the whole config through the
// service, so the window app, the phone and Claude Code pick it up at once. Signing in to a provider needs a web page and stays with the window
// app, while custom provider definitions open in the person's own editor and a phone pairs from a code drawn in the terminal.
import { ALERT_KINDS, HOSTED, allPlugins, type AppConfig, type Outlet, type ProviderPlugin } from '@augur/core';
import { box, center, drawQr, inset, qrEncode, spans, wrap, type Key, type Rect, type Screen } from '@augur/terminal';
import {
  ALERT_TEXT, CLAUDE_TEXT, COMPUTER_TEXT, CUSTOM_EXAMPLE, CUSTOM_TEXT, KIND_LABELS, PHONE_TEXT, PROVIDER_TEXT, REFRESH_CHOICES,
  STARTER_RULES_TEXT, parseCustom, parsePercents, refreshDefault,
} from '@augur/view-model';
import { editText, editorCommand, type EditorDeps } from '../editor.js';
import { Form, type Row } from '../form.js';
import type { Ctx, Hint, Overlay, Page } from '../page.js';

/** Sets the service to start at login or stops it, the same way `augur service enable` and `disable` do. */
export interface LoginControl {
  state(): { supported: boolean; enabled: boolean };
  enable(): Promise<{ ok: boolean; message: string }>;
  disable(): Promise<{ ok: boolean; message: string }>;
}

export interface SettingsDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  login?: LoginControl;
  spawn?: EditorDeps['spawn'];
}

export const SETTINGS_TEXT = {
  heading: 'Settings',
  setup: 'Set up Augur',
  setupDesc: 'Turn on what you want to track. You can change this any time.',
  start: 'Start tracking',
  signIn: 'Signing in needs the window app on this computer. Until then, the readings that need it are left off.',
  appearance: 'Appearance',
  theme: 'Theme',
  themeDesc: 'A terminal cannot report its background color, so System uses the dark colors.',
  colorHelp: 'A hex color such as #3987e5. Leave blank for the default.',
  colorBad: 'That is not a hex color such as #3987e5.',
  numberBad: 'That is not a number.',
  saved: 'Saved',
  keySaved: 'Key saved',
  keyRemoved: 'Key removed',
  customCount: (n: number) => (n === 1 ? '1 definition saved' : n ? `${n} definitions saved` : 'No definitions yet'),
  customEdit: 'Edit definitions',
  customDesc: (cmd: string) => `Opens them in ${cmd}. Set VISUAL or EDITOR to use a different editor.`,
  editorFailed: 'The editor did not close cleanly, so nothing was saved.',
  unchanged: 'Nothing changed.',
  login: 'Start at login',
  loginDesc: 'Starts the Augur service when you log in, so readings and alerts carry on with no app open.',
  pairTitle: 'Pair a phone',
  pairScan: "Scan the code with the phone's camera, or open this link on the phone:",
  pairSmall: 'The terminal is too small for the code. Make it larger, or open this link on the phone:',
  copy: 'Copy the link',
  copied: 'Link copied, where the terminal allows it.',
};

const THEMES: ReadonlyArray<readonly [string, string]> = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const SYSTEM_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'notify-send' };
const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

export class SettingsPage implements Page {
  name = SETTINGS_TEXT.heading;
  readonly form = new Form();
  /** Which provider has its settings expanded, if any. */
  open: string | null = null;
  private customDraft: string | null = null;
  private customError = '';

  constructor(private readonly deps: SettingsDeps) {}

  typing(): boolean { return this.form.typing(); }

  draw(screen: Screen, r: Rect, ctx: Ctx): void {
    this.form.draw(screen, inset(r, 0, 1), this.rows(ctx), ctx.theme);
  }

  key(key: Key, ctx: Ctx): Promise<boolean> {
    return this.form.key(key, this.rows(ctx));
  }

  hints(ctx: Ctx): Hint[] {
    return this.form.hints(this.rows(ctx));
  }

  private async save(ctx: Ctx, change: (c: AppConfig) => void, note = ''): Promise<void> {
    const c = structuredClone(ctx.state.config);
    change(c);
    await this.act(ctx, 'saveConfig', [c], note);
  }

  /** Runs an engine command and shows `note` once it succeeds, or the error when it fails. Saving the config goes through here too. */
  private async act(ctx: Ctx, method: string, args: unknown[], note = ''): Promise<unknown> {
    try {
      const r = await ctx.link.run(method, ...args);
      if (note) ctx.flash(note);
      return r;
    } catch (e) { ctx.flash((e as Error).message || 'That did not work.', true); return undefined; }
  }

  rows(ctx: Ctx): Row[] {
    const config = ctx.state.config;
    const out: Row[] = [];
    if (ctx.state.firstRun) {
      out.push({ kind: 'heading', text: SETTINGS_TEXT.setup }, { kind: 'note', text: SETTINGS_TEXT.setupDesc });
      out.push(...this.providers(ctx));
      out.push({ kind: 'note', text: STARTER_RULES_TEXT });
      out.push({ kind: 'action', id: 'finish', label: '', button: SETTINGS_TEXT.start, run: () => this.act(ctx, 'finishSetup', [structuredClone(config)]).then(() => {}) });
      return out;
    }
    out.push(...this.providers(ctx));
    out.push({ kind: 'heading', text: SETTINGS_TEXT.appearance });
    out.push({ kind: 'choice', id: 'theme', label: SETTINGS_TEXT.theme, desc: SETTINGS_TEXT.themeDesc, value: config.layout.theme, options: THEMES,
      set: (v) => this.save(ctx, (c) => { c.layout.theme = v as AppConfig['layout']['theme']; }) });
    out.push(...this.alerts(ctx), ...this.claude(ctx), ...this.custom(ctx), ...this.phone(ctx), ...this.computer(ctx));
    return out;
  }

  private providers(ctx: Ctx): Row[] {
    const config = ctx.state.config;
    const plugins = new Map(allPlugins(config).map((p) => [p.id, p]));
    const out: Row[] = [{ kind: 'heading', text: PROVIDER_TEXT.heading }];
    for (const pc of config.providers) {
      const plugin = plugins.get(pc.id);
      if (!plugin) continue;
      const pid = pc.id, open = this.open === pid;
      out.push({
        kind: 'toggle', id: `p:${pid}`, label: plugin.name, on: pc.enabled, open,
        dot: ctx.theme.provider(pid),
        set: (on) => this.save(ctx, (c) => { const p = c.providers.find((x) => x.id === pid); if (p) p.enabled = on; }),
        enter: () => { this.open = open ? null : pid; },
      });
      if (open) out.push(...this.providerDetail(ctx, plugin).map((r) => (r.kind === 'heading' || r.kind === 'columns' ? r : { ...r, indent: true })));
    }
    return out;
  }

  private providerDetail(ctx: Ctx, plugin: ProviderPlugin): Row[] {
    const pid = plugin.id, config = ctx.state.config;
    const pc = config.providers.find((p) => p.id === pid)!;
    const secrets = new Set(ctx.state.secrets);
    const setting = (key: string, value: string | boolean) => this.save(ctx, (c) => { const p = c.providers.find((x) => x.id === pid); if (p) p.settings[key] = value; });
    const out: Row[] = [];
    if (plugin.needsLocalLogin) out.push({ kind: 'note', text: PROVIDER_TEXT.localLogin(plugin.name) });
    for (const f of plugin.fields) {
      const id = `p:${pid}:${f.key}`;
      if (f.kind === 'secret') {
        const name = `${pid}.${f.key}`, has = secrets.has(name);
        out.push({ kind: 'text', id, label: f.label, desc: f.help, value: '', mask: true, placeholder: has ? PROVIDER_TEXT.keyReplace : f.placeholder ?? '',
          ...(has ? { badge: PROVIDER_TEXT.keySaved } : {}),
          save: async (v) => { if (v) await this.act(ctx, 'setProviderKey', [pid, f.key, v], SETTINGS_TEXT.keySaved); } });
        if (has) out.push({ kind: 'action', id: `${id}:del`, label: '', button: PROVIDER_TEXT.keyRemove, run: () => this.act(ctx, 'deleteSecret', [name], SETTINGS_TEXT.keyRemoved).then(() => {}) });
      } else if (f.kind === 'signin') {
        const sessions = (ctx.state.snapshot?.providers[pid]?.notes as { webSessions?: Record<string, boolean> } | null | undefined)?.webSessions ?? {};
        const signedIn = sessions[f.site ?? pid] === true;
        out.push({ kind: 'note', text: `${f.label}: ${signedIn ? PROVIDER_TEXT.signedIn : SETTINGS_TEXT.signIn}`, style: signedIn ? 'good' : 'muted' });
      } else if (f.kind === 'toggle') {
        out.push({ kind: 'toggle', id, label: f.label, desc: f.help, on: !!pc.settings[f.key], set: (on) => setting(f.key, on) });
      } else if (f.kind === 'select') {
        const options = (f.options ?? []).map((o) => [o, o] as const);
        out.push({ kind: 'choice', id, label: f.label, desc: f.help, value: String(pc.settings[f.key] ?? f.options?.[0] ?? ''), options, set: (v) => setting(f.key, v) });
      } else {
        out.push({ kind: 'text', id, label: f.label, desc: f.help, value: String(pc.settings[f.key] ?? ''), placeholder: f.placeholder ?? '', save: (v) => setting(f.key, v) });
      }
    }
    const snap = ctx.state.snapshot?.providers[pid];
    const items = [...(snap?.meters ?? []).map((x) => ({ id: x.id, label: x.label })), ...(snap?.money ?? []).map((x) => ({ id: '$' + x.id, label: x.label }))];
    if (items.length) {
      const hidden = config.layout.hiddenMeters[pid] ?? [];
      out.push({ kind: 'checks', id: `p:${pid}:show`, label: PROVIDER_TEXT.show, cells: items.map((x) => ({ label: x.label, on: !hidden.includes(x.id) })),
        set: (i, on) => this.save(ctx, (c) => {
          const id = items[i]!.id, list = c.layout.hiddenMeters[pid] ?? [];
          c.layout.hiddenMeters[pid] = on ? list.filter((x) => x !== id) : [...new Set([...list, id])];
        }) });
    }
    const choices = [['', refreshDefault(plugin.refreshSeconds)] as const, ...REFRESH_CHOICES.map(([s, l]) => [String(s), l] as const)];
    out.push({ kind: 'choice', id: `p:${pid}:refresh`, label: PROVIDER_TEXT.refresh, desc: PROVIDER_TEXT.refreshHelp, value: pc.refreshSeconds == null ? '' : String(pc.refreshSeconds), options: choices,
      set: (v) => this.save(ctx, (c) => { const p = c.providers.find((x) => x.id === pid); if (p) p.refreshSeconds = v ? Number(v) : null; }) });
    const fallback = (ctx.theme.dark ? plugin.color?.dark : plugin.color?.light) ?? '';
    out.push({ kind: 'text', id: `p:${pid}:color`, label: PROVIDER_TEXT.color, desc: SETTINGS_TEXT.colorHelp, value: typeof pc.settings.color === 'string' ? pc.settings.color : '', placeholder: fallback,
      save: async (v) => {
        if (v && !isHex(v)) { ctx.flash(SETTINGS_TEXT.colorBad, true); return; }
        await this.save(ctx, (c) => { const p = c.providers.find((x) => x.id === pid); if (!p) return; if (v) p.settings.color = v; else delete p.settings.color; });
      } });
    return out;
  }

  private alerts(ctx: Ctx): Row[] {
    const config = ctx.state.config, a = config.alerts;
    const out: Row[] = [{ kind: 'heading', text: ALERT_TEXT.label }];
    out.push({ kind: 'toggle', id: 'alerts', label: ALERT_TEXT.label, desc: ALERT_TEXT.master, on: a.enabled, set: (on) => this.save(ctx, (c) => { c.alerts.enabled = on; }) });
    const cols: Array<[Outlet, string]> = [['system', SYSTEM_NAMES[this.deps.platform] ?? 'System'], ['augur', ALERT_TEXT.keep], ['claude', ALERT_TEXT.claude]];
    if (config.sync?.channel) cols.push(['phone', ALERT_TEXT.phone]);
    const cellW = Math.max(6, ...cols.map(([, l]) => l.length + 2));
    out.push({ kind: 'note', text: ALERT_TEXT.grid, style: 'bold' }, { kind: 'note', text: ALERT_TEXT.gridHelp });
    out.push({ kind: 'columns', id: 'outlets', labels: cols.map(([, l]) => l), cellW });
    for (const k of ALERT_KINDS) {
      out.push({ kind: 'checks', id: `outlet:${k}`, label: KIND_LABELS[k], cellW, cells: cols.map(([o]) => ({ on: !!a.outlets[k]?.[o] })),
        set: (i, on) => this.save(ctx, (c) => { const o = cols[i]![0]; if (c.alerts.outlets[k]) c.alerts.outlets[k][o] = on; }) });
    }
    out.push({ kind: 'text', id: 'pct', label: ALERT_TEXT.pct, value: a.pctThresholds.join(', '), placeholder: '80, 95',
      save: (v) => this.save(ctx, (c) => { c.alerts.pctThresholds = parsePercents(v); }, SETTINGS_TEXT.saved) });
    out.push({ kind: 'note', text: ALERT_TEXT.burn, style: 'bold' }, { kind: 'note', text: ALERT_TEXT.burnHelp });
    for (const [k, label] of [['session', ALERT_TEXT.session], ['weekly', ALERT_TEXT.weekly], ['other', ALERT_TEXT.other]] as const) {
      out.push({ kind: 'text', id: `ratio:${k}`, label, value: a.paceRatio[k] == null ? '' : String(a.paceRatio[k]),
        save: async (v) => {
          const n = Number(v);
          if (v && !Number.isFinite(n)) { ctx.flash(SETTINGS_TEXT.numberBad, true); return; }
          await this.save(ctx, (c) => { c.alerts.paceRatio[k] = v ? n : null; }, SETTINGS_TEXT.saved);
        } });
    }
    const balances = Object.values(ctx.state.snapshot?.providers ?? {}).flatMap((p) => p.money.filter((x) => x.id === 'balance' || x.id === 'prepaid').map((x) => ({ key: `${p.id}.${x.id}`, label: `${p.name}, ${x.label.toLowerCase()}` })));
    if (balances.length) {
      out.push({ kind: 'note', text: ALERT_TEXT.balances, style: 'bold' });
      for (const b of balances) {
        out.push({ kind: 'text', id: `bal:${b.key}`, label: b.label, value: a.balanceBelow[b.key] == null ? '' : String(a.balanceBelow[b.key]), placeholder: '$',
          save: async (v) => {
            const n = Number(v.replace(/^\$/, ''));
            if (v && !Number.isFinite(n)) { ctx.flash(SETTINGS_TEXT.numberBad, true); return; }
            await this.save(ctx, (c) => { if (v) c.alerts.balanceBelow[b.key] = n; else delete c.alerts.balanceBelow[b.key]; }, SETTINGS_TEXT.saved);
          } });
      }
    }
    return out;
  }

  private claude(ctx: Ctx): Row[] {
    const st = ctx.state.claude;
    if (!st) return [];
    const out: Row[] = [{ kind: 'heading', text: CLAUDE_TEXT.heading }];
    const codeDesc = CLAUDE_TEXT.codeDesc + (ctx.state.config.exportPath ? '' : ` ${CLAUDE_TEXT.codeExport}`);
    out.push({ kind: 'toggle', id: 'claude-code', label: CLAUDE_TEXT.code, desc: codeDesc, on: !!st.code, set: (on) => this.act(ctx, 'setClaude', ['code', on]).then(() => {}) });
    if (st.desktopPossible) out.push({ kind: 'toggle', id: 'claude-desktop', label: CLAUDE_TEXT.desktop, desc: CLAUDE_TEXT.desktopDesc, on: st.desktop, set: (on) => this.act(ctx, 'setClaude', ['desktop', on]).then(() => {}) });
    else out.push({ kind: 'note', text: `${CLAUDE_TEXT.desktop}: ${CLAUDE_TEXT.desktopMissing}` });
    if (ctx.state.claudeError) out.push({ kind: 'note', text: ctx.state.claudeError, style: 'crit' });
    return out;
  }

  private custom(ctx: Ctx): Row[] {
    const list = ctx.state.config.custom ?? [];
    const out: Row[] = [{ kind: 'heading', text: CUSTOM_TEXT.heading }, { kind: 'note', text: CUSTOM_TEXT.help }];
    out.push({ kind: 'action', id: 'custom', label: SETTINGS_TEXT.customCount(list.length), desc: SETTINGS_TEXT.customDesc(editorCommand(this.deps.env, this.deps.platform)),
      button: SETTINGS_TEXT.customEdit, run: () => this.editCustom(ctx) });
    if (this.customError) out.push({ kind: 'note', text: this.customError, style: 'crit' });
    return out;
  }

  /** Opens the definitions in the editor, starting from the example when there are none, and saves them when they check out. A draft that
   * fails the check is kept, so the next edit starts from it. */
  async editCustom(ctx: Ctx): Promise<void> {
    const list = ctx.state.config.custom ?? [];
    const start = this.customDraft ?? JSON.stringify(list.length ? list : CUSTOM_EXAMPLE, null, 2) + '\n';
    const text = await editText(start, 'augur-custom-providers.json', this.deps, ctx.pause);
    if (text === null) { ctx.flash(SETTINGS_TEXT.editorFailed, true); return; }
    if (text.trim() === start.trim() && this.customDraft === null) { ctx.flash(SETTINGS_TEXT.unchanged); return; }
    const r = parseCustom(text, ctx.state.config);
    if ('error' in r) { this.customDraft = text; this.customError = r.error; ctx.flash(r.error, true); return; }
    this.customDraft = null; this.customError = '';
    await this.save(ctx, (c) => { c.custom = r.custom; }, SETTINGS_TEXT.saved);
  }

  private phone(ctx: Ctx): Row[] {
    const sync = ctx.state.config.sync ?? null, paired = !!sync?.channel;
    const setSync = (part: { relay?: string; pwaUrl?: string; shareKeys?: boolean }) => this.save(ctx, (c) => {
      c.sync = { ...c.sync, relay: c.sync?.relay ?? '', channel: c.sync?.channel ?? '', pwaUrl: c.sync?.pwaUrl ?? '', ...part };
    }, part.shareKeys === undefined ? SETTINGS_TEXT.saved : '');
    const out: Row[] = [{ kind: 'heading', text: PHONE_TEXT.heading }];
    out.push({ kind: 'text', id: 'relay', label: PHONE_TEXT.relay, desc: PHONE_TEXT.relayHelp, value: sync?.relay || HOSTED, placeholder: HOSTED, save: (v) => setSync({ relay: v }) });
    out.push({ kind: 'text', id: 'pwa', label: PHONE_TEXT.pwa, desc: PHONE_TEXT.pwaHelp, value: sync?.pwaUrl || HOSTED, placeholder: HOSTED, save: (v) => setSync({ pwaUrl: v }) });
    if (paired) {
      out.push({ kind: 'action', id: 'pair-show', label: PHONE_TEXT.paired, desc: PHONE_TEXT.pairedDesc, button: PHONE_TEXT.show,
        run: async () => { const url = await this.act(ctx, 'pairUrl', []); if (typeof url === 'string') ctx.overlay(pairOverlay(url)); } });
      out.push({ kind: 'action', id: 'unpair', label: '', button: PHONE_TEXT.unpair, run: () => this.act(ctx, 'unpair', []).then(() => {}) });
      out.push({ kind: 'toggle', id: 'sharekeys', label: PHONE_TEXT.shareKeys, desc: PHONE_TEXT.shareKeysDesc, on: sync?.shareKeys === true, set: (on) => setSync({ shareKeys: on }) });
    } else {
      out.push({ kind: 'action', id: 'pair', label: PHONE_TEXT.sync, desc: PHONE_TEXT.syncDesc, button: PHONE_TEXT.pair,
        run: async () => { const url = await this.act(ctx, 'pair', []); if (typeof url === 'string') ctx.overlay(pairOverlay(url)); } });
    }
    return out;
  }

  private computer(ctx: Ctx): Row[] {
    const u = ctx.state.update, config = ctx.state.config;
    const status = u.status === 'available' ? COMPUTER_TEXT.available(u.available?.version ?? '') : COMPUTER_TEXT.status[u.status];
    const busy = u.status === 'checking' || u.status === 'installing';
    const out: Row[] = [{ kind: 'heading', text: COMPUTER_TEXT.heading }];
    out.push({ kind: 'action', id: 'update', label: u.version ? COMPUTER_TEXT.version(u.version) : COMPUTER_TEXT.updates, ...(status ? { desc: status } : {}),
      button: COMPUTER_TEXT.check, disabled: busy, run: () => this.act(ctx, 'checkUpdate', []).then(() => {}) });
    const login = this.deps.login?.state();
    if (this.deps.login && login?.supported) {
      const control = this.deps.login;
      out.push({ kind: 'toggle', id: 'login', label: SETTINGS_TEXT.login, desc: SETTINGS_TEXT.loginDesc, on: login.enabled,
        set: async (on) => {
          try { const r = await (on ? control.enable() : control.disable()); ctx.flash(r.message, !r.ok); }
          catch (e) { ctx.flash((e as Error).message, true); }
        } });
    }
    out.push({ kind: 'text', id: 'export', label: COMPUTER_TEXT.export, desc: COMPUTER_TEXT.exportHelp, value: config.exportPath ?? '', placeholder: '.augur/usage.json',
      save: (v) => this.save(ctx, (c) => { c.exportPath = v || null; }, SETTINGS_TEXT.saved) });
    return out;
  }
}

/** The pairing code drawn over the page, with the link under it. A terminal too small for the code shows only the link. Either way the
 * link can be copied, since a link wrapped over several lines does not select cleanly. */
export function pairOverlay(url: string): Overlay {
  const qr = qrEncode(url, 'L');
  return {
    draw(screen, ctx) {
      const full: Rect = { x: 0, y: 0, w: screen.width, h: screen.height };
      const qw = qr.size + 4, qh = Math.ceil(qw / 2);
      const textW = Math.max(20, Math.min(screen.width - 6, Math.max(56, qw)));
      const fits = qw + 4 <= screen.width && qh + 10 <= screen.height;
      const chunks: string[] = [];
      for (let i = 0; i < url.length; i += textW) chunks.push(url.slice(i, i + textW));
      const lead = wrap(fits ? SETTINGS_TEXT.pairScan : SETTINGS_TEXT.pairSmall, textW), tail = wrap(PHONE_TEXT.private, textW);
      const h = Math.min(screen.height - 2, (fits ? qh + 1 : 0) + lead.length + chunks.length + 1 + tail.length + 2);
      const r = center(full, textW + 4, h);
      screen.fill(r.x, r.y, r.w, r.h);
      const inside = inset(box(screen, r, { title: SETTINGS_TEXT.pairTitle }), 0, 1);
      let y = inside.y;
      if (fits) { drawQr(screen, inside.x + Math.floor((inside.w - qw) / 2), y, qr); y += qh + 1; }
      for (const line of lead) spans(screen, inside.x, y++, inside.w, line);
      for (const line of chunks) spans(screen, inside.x, y++, inside.w, line, ctx.theme.accent);
      y++;
      for (const line of tail) if (y < inside.y + inside.h) spans(screen, inside.x, y++, inside.w, line, ctx.theme.muted);
    },
    key(key, ctx) {
      if (key.label !== 'c') return false;
      ctx.copy(url);
      ctx.flash(SETTINGS_TEXT.copied);
      return true;
    },
    hints: () => [['c', SETTINGS_TEXT.copy]],
  };
}
