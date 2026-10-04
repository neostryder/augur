import { ALERT_KINDS } from '@augur/core';
import type { AlertKind, AppConfig, ClaudeStatus, Outlet, Platform, ProviderPlugin, PushStatus, Snapshot } from '@augur/core';
import type { UpdateState } from '../app';
import { ICON, esc } from '../util';
import { ALERT_TEXT, CLAUDE_TEXT, COMPUTER_TEXT, CUSTOM_TEXT, KIND_LABELS, PHONE_TEXT, PROVIDER_TEXT, REFRESH_CHOICES, STARTER_RULES_TEXT, refreshDefault } from '@augur/view-model';
import { classifierChooser, modeChooser } from './service';

export { ALERT_TEXT, CLAUDE_TEXT, CUSTOM_EXAMPLE, KIND_LABELS, STARTER_RULES_TEXT } from '@augur/view-model';

export interface SettingsModel {
  config: AppConfig;
  plugins: Map<string, ProviderPlugin>;
  snapshot: Snapshot | null;
  secrets: Set<string>;
  shellKind: 'desktop' | 'pwa';
  autostart: boolean | null;
  openProvider: string | null;
  customDraft: string;
  customError: string;
  firstRun: boolean;
  savedFlash: string | null;
  sync: NonNullable<AppConfig['sync']> | null;
  relay: string;
  pwaUrl: string;
  update: UpdateState;
  pairQr: string | null;
  pairUrl: string | null;
  scanError: string;
  hotkeyError: string;
  canHotkey: boolean;
  /** iPhone or iPad Safari, not yet on the home screen: it has no install prompt of its own. */
  iosInstallHint: boolean;
  /** True where the app carries the dispatch service. */
  canDispatch: boolean;
  runJobs: boolean;
  /** The task classifier the service is set to, or null before the service settings have been read. */
  classifier: string | null;
  platform: Platform;
  /** Phone only: where push stands in this browser, the last error, and whether the desktop has sent its push key. */
  push: { status: PushStatus | null; error: string; hasKey: boolean } | null;
  /** Desktop only: where the two Claude installs stand, and the last error from turning one on or off. */
  claude: { status: ClaudeStatus | null; error: string } | null;
}

export const PUSH_TEXT = {
  label: 'Push notifications',
  on: "Your computer's alerts arrive here even when Augur is closed.",
  off: 'Turn this on to get alerts from your computer on this phone.',
  needsInstall: 'On iPhone, push works only in the Home Screen app. Tap Share, then Add to Home Screen, open Augur from there, pair it, and turn this on.',
  denied: 'Notifications are blocked for this site. Allow them in the browser settings, then turn this on.',
  unsupported: 'This browser cannot receive push notifications.',
  noKey: 'Your computer has not sent its push key yet. Open Augur on the computer, wait for it to sync, then try again.',
  refused: 'The browser did not allow notifications, so push is still off.',
  where: 'Your computer picks which alerts reach this phone, in its own Alerts settings.',
};

/** Desktop: turns the Claude Code mod and the Claude Desktop MCP entry on and off. */
function claudeSection(m: SettingsModel): string {
  const st = m.claude?.status;
  if (!st) return '';
  const codeDesc = CLAUDE_TEXT.codeDesc + (m.config.exportPath ? '' : ` ${CLAUDE_TEXT.codeExport}`);
  const desktop = st.desktopPossible
    ? toggle('claude-desktop', st.desktop, CLAUDE_TEXT.desktop)
    : '';
  return `<h2 class="sec">${CLAUDE_TEXT.heading}</h2><div class="card">
    <div class="row"><label class="name">${CLAUDE_TEXT.code}<span class="desc">${codeDesc}</span></label>${toggle('claude-code', !!st.code, CLAUDE_TEXT.code)}</div>
    <div class="row"><label class="name">${CLAUDE_TEXT.desktop}<span class="desc">${st.desktopPossible ? CLAUDE_TEXT.desktopDesc : CLAUDE_TEXT.desktopMissing}</span></label>${desktop}</div>
    ${m.claude?.error ? `<div class="field"><span class="bad-json">${esc(m.claude.error)}</span></div>` : ''}
  </div>`;
}

const SYSTEM_NAMES: Record<Platform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux', browser: 'Browser' };

/** The desktop's grid of alert kinds against the places an alert can go. The Phone column shows once a phone is paired. */
function outletGrid(m: SettingsModel): string {
  const cols: Array<[Outlet, string]> = [['system', SYSTEM_NAMES[m.platform]], ['augur', ALERT_TEXT.keep], ['claude', ALERT_TEXT.claude]];
  if (m.sync?.channel) cols.push(['phone', ALERT_TEXT.phone]);
  const o = m.config.alerts.outlets;
  return `<div class="field"><label>${ALERT_TEXT.grid}</label><span class="help">${ALERT_TEXT.gridHelp}</span>
    <table class="outlets"><thead><tr><th></th>${cols.map(([, label]) => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>
    ${ALERT_KINDS.map((k) => `<tr><th scope="row">${KIND_LABELS[k]}</th>${cols.map(([out, label]) =>
      `<td><input type="checkbox" data-outlet="${k}.${out}" ${o[k][out] ? 'checked' : ''} aria-label="${esc(`${KIND_LABELS[k]}: ${label}`)}"></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}

/** A paired phone's alert settings: only push, since the computer raises every alert. */
function phoneAlerts(m: SettingsModel): string {
  const p = m.push!;
  const blocked = p.status === 'needs-install' || p.status === 'denied' || p.status === 'unsupported';
  const desc = p.status === 'needs-install' ? PUSH_TEXT.needsInstall : p.status === 'denied' ? PUSH_TEXT.denied : p.status === 'unsupported' ? PUSH_TEXT.unsupported
    : p.status === 'on' ? PUSH_TEXT.on : PUSH_TEXT.off;
  return `<h2 class="sec">Alerts</h2><div class="card">
    <div class="row"><label class="name">${PUSH_TEXT.label}<span class="desc">${esc(desc)}</span></label>
      <label class="switch"><input type="checkbox" data-toggle="push" ${p.status === 'on' ? 'checked' : ''} ${blocked ? 'disabled' : ''} aria-label="${PUSH_TEXT.label}"><span></span></label></div>
    ${p.error ? `<span class="bad-json">${esc(p.error)}</span>` : ''}
    <div class="field"><span class="help">${PUSH_TEXT.where}</span></div></div>`;
}

function agentsSection(m: SettingsModel, first: boolean): string {
  if (!m.canDispatch) return '';
  return `<h2 class="sec">Agents</h2><div class="card">${modeChooser(m.runJobs)}${first && m.runJobs && m.classifier !== null ? `<div class="rsec">Who classifies tasks</div>${classifierChooser(m.classifier)}` : ''}
    <p class="help">${first ? 'You can change this later on the Service page.' : 'Jobs, routes and the service settings are on their own pages.'}</p>${first ? '' : '<div class="actions"><button class="btn small" data-action="jobs">Open jobs, routes and service</button></div>'}</div>`;
}

const seg = (name: string, value: string, options: Array<[string, string]>) =>
  `<div class="seg" role="radiogroup" aria-label="${esc(name)}">${options.map(([v, label]) =>
    `<button role="radio" aria-checked="${v === value}" class="${v === value ? 'on' : ''}" data-set="${esc(name)}" data-value="${esc(v)}">${esc(label)}</button>`).join('')}</div>`;

const toggle = (key: string, on: boolean, label: string) =>
  `<label class="switch"><input type="checkbox" data-toggle="${esc(key)}" ${on ? 'checked' : ''} aria-label="${esc(label)}"><span></span></label>`;

function providerCard(m: SettingsModel, pid: string): string {
  const pc = m.config.providers.find((p) => p.id === pid)!;
  const plugin = m.plugins.get(pid);
  if (!plugin) return '';
  const synced = m.shellKind === 'pwa' && plugin.needsLocalLogin && !!m.sync?.channel;
  const unavailable = m.shellKind === 'pwa' && plugin.needsLocalLogin && !synced;
  const open = m.openProvider === pid;
  const color = (pc.settings.color as string) || (plugin.color?.light ?? '#898781');
  let detail = '';
  if (open) {
    if (plugin.needsLocalLogin) {
      detail += `<div class="field"><span class="help">${m.shellKind === 'pwa'
        ? 'Reads the login of the command-line app on your computer, so it only works in the desktop app.'
        : esc(PROVIDER_TEXT.localLogin(plugin.name))}</span></div>`;
    }
    for (const f of plugin.fields) {
      const id = `f-${pid}-${f.key}`;
      if (f.kind === 'secret') {
        const has = m.secrets.has(`${pid}.${f.key}`);
        detail += `<div class="field"><label for="${id}">${esc(f.label)} ${has ? `<span class="saved">${PROVIDER_TEXT.keySaved}</span>` : ''}</label>
          <div class="row" style="padding:0;border:0"><input type="password" id="${id}" autocomplete="off" spellcheck="false" placeholder="${has ? PROVIDER_TEXT.keyReplace : esc(f.placeholder ?? '')}">
          <button class="btn small" data-secret-save="${esc(pid)}|${esc(f.key)}">Save</button>
          ${has ? `<button class="btn small" data-secret-del="${esc(pid)}|${esc(f.key)}">${PROVIDER_TEXT.keyRemove}</button>` : ''}</div>
          ${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</div>`;
      } else if (f.kind === 'signin') {
        const signedIn = ((m.snapshot?.providers[pid]?.notes as { webSessions?: Record<string, boolean> } | null | undefined)?.webSessions ?? {})[f.site ?? pid] === true;
        if (m.shellKind === 'desktop') detail += `<div class="row"><label class="name">${esc(f.label)} ${signedIn ? `<span class="saved">${PROVIDER_TEXT.signedIn}</span>` : ''}${f.help ? `<span class="desc">${esc(f.help)}</span>` : ''}</label><button class="btn small" data-signin="${esc(f.site ?? pid)}">${signedIn ? 'Sign in again' : 'Sign in'}</button></div>`;
      } else if (f.kind === 'toggle') {
        detail += `<div class="row"><label class="name">${esc(f.label)}${f.help ? `<span class="desc">${esc(f.help)}</span>` : ''}</label>${toggle(`setting:${pid}:${f.key}`, !!pc.settings[f.key], f.label)}</div>`;
      } else if (f.kind === 'select') {
        detail += `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-field="${esc(pid)}|${esc(f.key)}">${(f.options ?? []).map((o) =>
          `<option ${pc.settings[f.key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</div>`;
      } else {
        detail += `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="text" id="${id}" data-field="${esc(pid)}|${esc(f.key)}" value="${esc(pc.settings[f.key] ?? '')}" placeholder="${esc(f.placeholder ?? '')}">${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</div>`;
      }
    }
    const snap = m.snapshot?.providers[pid];
    const items = [...(snap?.meters ?? []).map((x) => ({ id: x.id, label: x.label })), ...(snap?.money ?? []).map((x) => ({ id: '$' + x.id, label: x.label }))];
    if (items.length) {
      const hidden = m.config.layout.hiddenMeters[pid] ?? [];
      detail += `<div class="field"><label>${PROVIDER_TEXT.show}</label><div class="metersel">${items.map((x) =>
        `<label><input type="checkbox" data-meter-vis="${esc(pid)}|${esc(x.id)}" ${hidden.includes(x.id) ? '' : 'checked'}>${esc(x.label)}</label>`).join('')}</div></div>`;
    }
    detail += refreshRow(m, pid, plugin);
    detail += `<div class="row"><label class="name" for="c-${pid}">${PROVIDER_TEXT.color}</label><input type="color" id="c-${pid}" data-color="${esc(pid)}" value="${esc(color)}">
      <button class="btn small" data-color-reset="${esc(pid)}">${PROVIDER_TEXT.colorDefault}</button></div>`;
  }
  return `<section class="card" data-pid="${esc(pid)}"><div class="phead">
      <span class="handle" title="Drag to reorder" aria-label="Drag to reorder">${ICON.grip}</span>
      <span class="dot" style="background:${esc(color)}"></span>
      <span class="pname">${esc(plugin.name)}${unavailable ? '<span class="chip">Desktop only</span>' : synced ? '<span class="chip">From desktop</span>' : ''}</span>
      <button class="link" data-open-provider="${esc(pid)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} ${esc(plugin.name)} settings" style="transform:rotate(${open ? 0 : -90}deg)">${ICON.chevron}</button>
      ${toggle(`enabled:${pid}`, pc.enabled && !unavailable, `Track ${plugin.name}`)}</div>
    ${open ? `<div class="body" style="margin-top:6px">${detail}</div>` : ''}</section>`;
}

export function renderSettings(m: SettingsModel): string {
  const c = m.config;
  const a = c.alerts;
  const ratio = (k: 'session' | 'weekly' | 'other') => a.paceRatio[k] == null ? '' : String(a.paceRatio[k]);
  const balances = Object.values(m.snapshot?.providers ?? {}).flatMap((p) => p.money.filter((x) => x.id === 'balance' || x.id === 'prepaid').map((x) => ({ key: `${p.id}.${x.id}`, label: `${p.name}, ${x.label.toLowerCase()}` })));

  let html = `<div class="settings"><header class="top">
    ${m.firstRun ? '' : `<button class="icon" data-action="back" title="Back to usage" aria-label="Back to usage">${ICON.back}</button>`}
    <div><h1>${m.firstRun ? 'Set up Augur' : 'Settings'}</h1>${m.firstRun ? '<div class="sub">Turn on what you want to track. You can change this any time.</div>' : ''}</div>
    <span class="grow"></span>${m.savedFlash ? `<span class="saved">${esc(m.savedFlash)}</span>` : ''}</header>`;

  if (m.firstRun && m.shellKind === 'pwa') html += phoneSection(m);
  html += `<h2 class="sec">${PROVIDER_TEXT.heading}</h2><div id="provider-list">${c.providers.map((p) => providerCard(m, p.id)).join('')}</div>`;

  if (m.firstRun) {
    html += agentsSection(m, true);
    html += `<h2 class="sec">Model rules</h2><div class="card"><p class="help">${esc(STARTER_RULES_TEXT)}</p></div>`;
    html += `<div class="actions"><button class="btn primary" data-action="finish-setup">Start tracking</button></div></div>`;
    return html;
  }

  html += agentsSection(m, false);
  html += `<h2 class="sec">Model rules</h2><div class="card"><div class="row"><label class="name">What agents may use each model for<span class="desc">Saved to policy.json beside the usage file, for agents to read.</span></label><button class="btn small" data-action="rules">Open</button></div></div>`;
  html += `<h2 class="sec">Appearance</h2><div class="card">
    <div class="row"><label class="name">Theme</label>${seg('theme', c.layout.theme, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])}</div>
    <div class="row"><label class="name">Columns<span class="desc">Auto uses two columns only when one column would run past the bottom of the screen.</span></label>${seg('columns', String(c.layout.columns), [['auto', 'Auto'], ['1', 'One'], ['2', 'Two']])}</div></div>`;

  if (m.push && m.sync?.channel) html += phoneAlerts(m);
  else html += `<h2 class="sec">Alerts</h2><div class="card">
    <div class="row"><label class="name">${ALERT_TEXT.label}<span class="desc">${m.shellKind === 'desktop' ? ALERT_TEXT.master : ALERT_TEXT.masterPhone}</span></label>${toggle('alerts', a.enabled, 'Alerts')}</div>
    ${m.shellKind === 'desktop' ? outletGrid(m) : ''}
    <div class="field"><label for="pct">${ALERT_TEXT.pct}</label><input type="text" id="pct" data-alert="pct" value="${esc(a.pctThresholds.join(', '))}" placeholder="80, 95"></div>
    <div class="field"><label>${ALERT_TEXT.burn}</label><span class="help">${ALERT_TEXT.burnHelp}</span>
      <div class="row" style="border:0;gap:14px">
        <label>${ALERT_TEXT.session} <input type="number" step="0.05" min="0" max="2" data-alert="ratio:session" value="${ratio('session')}"></label>
        <label>${ALERT_TEXT.weekly} <input type="number" step="0.05" min="0" max="2" data-alert="ratio:weekly" value="${ratio('weekly')}"></label>
        <label>${ALERT_TEXT.other} <input type="number" step="0.05" min="0" max="2" data-alert="ratio:other" value="${ratio('other')}"></label></div></div>
    ${balances.length ? `<div class="field"><label>${ALERT_TEXT.balances}</label>${balances.map((b) =>
      `<div class="row" style="border:0;padding:2px 0"><label class="name">${esc(b.label)}</label>$ <input type="number" step="1" min="0" data-alert="bal:${esc(b.key)}" value="${a.balanceBelow[b.key] ?? ''}"></div>`).join('')}</div>` : ''}
  </div>`;

  if (m.shellKind === 'desktop') html += claudeSection(m);

  html += `<h2 class="sec">${CUSTOM_TEXT.heading}</h2><div class="card">
    <div class="field"><span class="help">${CUSTOM_TEXT.help}</span>
    <textarea data-custom spellcheck="false" aria-label="Custom provider definitions">${esc(m.customDraft)}</textarea>
    ${m.customError ? `<span class="bad-json">${esc(m.customError)}</span>` : ''}
    <div class="actions" style="margin-top:4px"><button class="btn small" data-action="custom-example">Insert example</button><button class="btn small primary" data-action="custom-save">Save definitions</button></div></div></div>`;

  html += phoneSection(m);

  if (m.shellKind === 'desktop') {
    html += `<h2 class="sec">${COMPUTER_TEXT.heading}</h2><div class="card">
      ${updateRows(m)}
      ${m.autostart != null ? `<div class="row"><label class="name">Start at login</label>${toggle('autostart', m.autostart, 'Start at login')}</div>` : ''}
      <div class="row"><label class="name">Open the panel at launch<span class="desc">Shows the usage view each time Augur starts. Turn off to keep it in the tray until you open it.</span></label>${toggle('openonlaunch', m.config.openOnLaunch !== false, 'Open the panel at launch')}</div>
      ${m.config.exportPath ? `<div class="row"><label class="name">${COMPUTER_TEXT.exportFile}<span class="desc">${COMPUTER_TEXT.exportFileDesc}</span></label><button class="btn small" data-action="open-export">Open</button></div>` : ''}
      ${m.canHotkey ? `<div class="field"><label for="hotkey">Keyboard shortcut</label><input type="text" id="hotkey" data-hotkey value="${esc(c.hotkey ?? '')}" placeholder="Ctrl+Super+U" spellcheck="false" autocomplete="off">
      <span class="help">Opens and closes the panel from anywhere. Super is the Windows key, or Command on a Mac. Leave blank to turn it off.</span>${m.hotkeyError ? `<span class="bad-json">${esc(m.hotkeyError)}</span>` : ''}</div>` : ''}
      <div class="field"><label for="export">${COMPUTER_TEXT.export}</label><input type="text" id="export" data-export value="${esc(c.exportPath ?? '')}" placeholder=".augur/usage.json">
      <span class="help">${COMPUTER_TEXT.exportHelp}</span></div></div>`;
  }
  return html + '</div>';
}

function refreshRow(m: SettingsModel, pid: string, plugin: ProviderPlugin): string {
  const pc = m.config.providers.find((p) => p.id === pid);
  const fallback = refreshDefault(plugin.refreshSeconds);
  const current = pc?.refreshSeconds ?? null;
  const options = [`<option value="" ${current == null ? 'selected' : ''}>${esc(fallback)}</option>`,
    ...REFRESH_CHOICES.map(([sec, label]) => `<option value="${sec}" ${current === sec ? 'selected' : ''}>${esc(label)}</option>`)].join('');
  return `<div class="field"><label for="r-${esc(pid)}">${PROVIDER_TEXT.refresh}</label><select id="r-${esc(pid)}" data-provider-refresh="${esc(pid)}">${options}</select>
      <span class="help">${PROVIDER_TEXT.refreshHelp}</span></div>`;
}

function updateRows(m: SettingsModel): string {
  const u = m.update;
  const status = u.status === 'available' ? COMPUTER_TEXT.available(u.available?.version ?? '') : COMPUTER_TEXT.status[u.status];
  const busy = u.status === 'checking' || u.status === 'installing';
  const button = u.status === 'available'
    ? '<button class="btn small primary" data-action="update-install">Install and restart</button>'
    : `<button class="btn small" data-action="update-check" ${busy ? 'disabled' : ''}>${COMPUTER_TEXT.check}</button>`;
  return `<div class="row"><label class="name">${u.version ? esc(COMPUTER_TEXT.version(u.version)) : COMPUTER_TEXT.updates}${status ? `<span class="desc">${esc(status)}</span>` : ''}</label>${button}</div>
      <div class="row"><label class="name">Install updates automatically<span class="desc">Augur installs each new version while the panel is closed, then restarts.</span></label>${toggle('autoupdate', m.config.autoUpdate !== false, 'Install updates automatically')}</div>`;
}

function phoneSection(m: SettingsModel): string {
  const relayField = `<div class="field"><label for="relay">${PHONE_TEXT.relay}</label><input type="text" id="relay" data-sync="relay" value="${esc(m.relay)}" placeholder="https://augur.rpgm.tools">
    <span class="help">${m.shellKind === 'pwa'
      ? 'Sends requests to providers that do not allow browser apps, and brings updates from your desktop. It keeps nothing it passes along.'
      : PHONE_TEXT.relayHelp}</span></div>`;
  if (m.shellKind === 'pwa') {
    const paired = !!m.sync?.channel;
    return `<h2 class="sec">Desktop sync</h2><div class="card">
      <div class="row"><label class="name">${paired ? 'Paired with your desktop' : 'Not paired'}<span class="desc">${paired
        ? "Your desktop sends its readings, settings and API keys here. Claude, Codex and Grok always come from the desktop, since only the apps signed in on the computer can see those plan limits."
        : "Scan the code from Pair a phone in the desktop app's settings. This phone then shows everything the desktop tracks and gets its API keys, so there is nothing to type here."}</span></label>
      ${paired ? '<button class="btn small" data-action="sync-unpair">Unpair</button>' : ''}</div>
      <div class="actions" style="justify-content:flex-start;margin-top:4px"><button class="btn ${paired ? '' : 'primary'}" data-action="sync-scan">Scan pairing code</button></div>
      ${m.scanError ? `<span class="bad-json">${esc(m.scanError)}</span>` : ''}
      ${m.iosInstallHint ? `<div class="field"><span class="help">To add Augur to your home screen, tap Share in Safari (on newer iPhones it is in the menu at the bottom), then Add to Home Screen. The home-screen app keeps its own storage, so open it and scan the pairing code from there.</span></div>` : ''}
      ${relayField}</div>`;
  }
  const paired = !!m.sync?.channel;
  return `<h2 class="sec">${PHONE_TEXT.heading}</h2><div class="card">${relayField}
    <div class="field"><label for="pwa">${PHONE_TEXT.pwa}</label><input type="text" id="pwa" data-sync="pwaUrl" value="${esc(m.pwaUrl)}" placeholder="https://augur.rpgm.tools">
      <span class="help">${PHONE_TEXT.pwaHelp}</span></div>
    <div class="row"><label class="name">${paired ? PHONE_TEXT.paired : PHONE_TEXT.sync}<span class="desc">${paired ? PHONE_TEXT.pairedDesc : PHONE_TEXT.syncDesc}</span></label>
      ${paired ? `<button class="btn small" data-action="sync-show">${PHONE_TEXT.show}</button><button class="btn small" data-action="sync-unpair">${PHONE_TEXT.unpair}</button>`
        : `<button class="btn small primary" data-action="sync-pair" ${m.relay && m.pwaUrl ? '' : 'disabled'}>${PHONE_TEXT.pair}</button>`}</div>
    ${paired ? `<div class="row"><label class="name">${PHONE_TEXT.shareKeys}<span class="desc">${PHONE_TEXT.shareKeysDesc}</span></label>${toggle('sharekeys', m.sync?.shareKeys === true, PHONE_TEXT.shareKeys)}</div>` : ''}
    ${m.pairQr ? `<div class="field" style="align-items:center">${m.pairQr}<span class="help">Scan it with the phone's camera, or open the <a href="#" data-open="${esc(m.pairUrl ?? '')}">pairing link</a> on the phone. ${PHONE_TEXT.private}</span></div>` : ''}
  </div>`;
}

