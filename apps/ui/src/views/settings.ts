import type { AppConfig, ProviderPlugin, Snapshot } from '@augur/core';
import type { UpdateState } from '../app';
import { ICON, esc } from '../util';
import { DEFAULT_REFRESH_SECONDS } from '../core';

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
        : `Reads the login of the ${esc(plugin.name)} command-line app on this computer. Sign in there first. No key is needed here.`}</span></div>`;
    }
    for (const f of plugin.fields) {
      const id = `f-${pid}-${f.key}`;
      if (f.kind === 'secret') {
        const has = m.secrets.has(`${pid}.${f.key}`);
        detail += `<div class="field"><label for="${id}">${esc(f.label)} ${has ? '<span class="saved">Saved</span>' : ''}</label>
          <div class="row" style="padding:0;border:0"><input type="password" id="${id}" autocomplete="off" spellcheck="false" placeholder="${has ? 'Enter a new key to replace it' : esc(f.placeholder ?? '')}">
          <button class="btn small" data-secret-save="${esc(pid)}|${esc(f.key)}">Save</button>
          ${has ? `<button class="btn small" data-secret-del="${esc(pid)}|${esc(f.key)}">Remove</button>` : ''}</div>
          ${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</div>`;
      } else if (f.kind === 'signin') {
        if (m.shellKind === 'desktop') detail += `<div class="row"><label class="name">${esc(f.label)}${f.help ? `<span class="desc">${esc(f.help)}</span>` : ''}</label><button class="btn small" data-signin="${esc(f.site ?? pid)}">Sign in</button></div>`;
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
      detail += `<div class="field"><label>Show on the dashboard</label><div class="metersel">${items.map((x) =>
        `<label><input type="checkbox" data-meter-vis="${esc(pid)}|${esc(x.id)}" ${hidden.includes(x.id) ? '' : 'checked'}>${esc(x.label)}</label>`).join('')}</div></div>`;
    }
    detail += refreshRow(m, pid, plugin);
    detail += `<div class="row"><label class="name" for="c-${pid}">Color</label><input type="color" id="c-${pid}" data-color="${esc(pid)}" value="${esc(color)}">
      <button class="btn small" data-color-reset="${esc(pid)}">Default</button></div>`;
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
  html += `<h2 class="sec">Providers</h2><div id="provider-list">${c.providers.map((p) => providerCard(m, p.id)).join('')}</div>`;

  if (m.firstRun) {
    html += `<div class="actions"><button class="btn primary" data-action="finish-setup">Start tracking</button></div></div>`;
    return html;
  }

  html += `<h2 class="sec">Appearance</h2><div class="card">
    <div class="row"><label class="name">Theme</label>${seg('theme', c.layout.theme, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])}</div>
    <div class="row"><label class="name">Columns<span class="desc">Auto uses two columns only when one column would run past the bottom of the screen.</span></label>${seg('columns', String(c.layout.columns), [['auto', 'Auto'], ['1', 'One'], ['2', 'Two']])}</div></div>`;

  html += `<h2 class="sec">Alerts</h2><div class="card">
    <div class="row"><label class="name">Notifications<span class="desc">Each alert fires once per window, then waits for the next reset.</span></label>${toggle('alerts', a.enabled, 'Notifications')}</div>
    <div class="field"><label for="pct">Notify when a limit passes these percentages</label><input type="text" id="pct" data-alert="pct" value="${esc(a.pctThresholds.join(', '))}" placeholder="80, 95"></div>
    <div class="field"><label>Burn-rate warning</label><span class="help">Warns when usage left divided by time left in the window drops below this number. 1 means you run out right at the reset; 0.8 warns a bit earlier than that. Leave blank to turn one off.</span>
      <div class="row" style="border:0;gap:14px">
        <label>Session <input type="number" step="0.05" min="0" max="2" data-alert="ratio:session" value="${ratio('session')}"></label>
        <label>Weekly <input type="number" step="0.05" min="0" max="2" data-alert="ratio:weekly" value="${ratio('weekly')}"></label>
        <label>Other <input type="number" step="0.05" min="0" max="2" data-alert="ratio:other" value="${ratio('other')}"></label></div></div>
    ${balances.length ? `<div class="field"><label>Notify when a balance drops below</label>${balances.map((b) =>
      `<div class="row" style="border:0;padding:2px 0"><label class="name">${esc(b.label)}</label>$ <input type="number" step="1" min="0" data-alert="bal:${esc(b.key)}" value="${a.balanceBelow[b.key] ?? ''}"></div>`).join('')}</div>` : ''}
  </div>`;

  html += `<h2 class="sec">Custom providers</h2><div class="card">
    <div class="field"><span class="help">Track a provider that is not built in by pasting its definition as JSON: the address to call, how to send its key, and where each number sits in the answer. Once saved, it appears in the provider list above, where you add its key.</span>
    <textarea data-custom spellcheck="false" aria-label="Custom provider definitions">${esc(m.customDraft)}</textarea>
    ${m.customError ? `<span class="bad-json">${esc(m.customError)}</span>` : ''}
    <div class="actions" style="margin-top:4px"><button class="btn small" data-action="custom-example">Insert example</button><button class="btn small primary" data-action="custom-save">Save definitions</button></div></div></div>`;

  html += phoneSection(m);

  if (m.shellKind === 'desktop') {
    html += `<h2 class="sec">This computer</h2><div class="card">
      ${updateRows(m)}
      ${m.autostart != null ? `<div class="row"><label class="name">Start at login</label>${toggle('autostart', m.autostart, 'Start at login')}</div>` : ''}
      ${m.canHotkey ? `<div class="field"><label for="hotkey">Keyboard shortcut</label><input type="text" id="hotkey" data-hotkey value="${esc(c.hotkey ?? '')}" placeholder="Ctrl+Super+U" spellcheck="false" autocomplete="off">
      <span class="help">Opens and closes the panel from anywhere. Super is the Windows key, or Command on a Mac. Leave blank to turn it off.</span>${m.hotkeyError ? `<span class="bad-json">${esc(m.hotkeyError)}</span>` : ''}</div>` : ''}
      <div class="field"><label for="export">Also save the latest numbers to this file</label><input type="text" id="export" data-export value="${esc(c.exportPath ?? '')}" placeholder=".augur/usage.json">
      <span class="help">After each refresh, Augur writes the latest numbers to this file in your home folder, so scripts and coding assistants can read them. Leave blank to turn this off.</span></div></div>`;
  }
  return html + '</div>';
}

const REFRESH_CHOICES: Array<[number, string]> = [[15, '15 seconds'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours'], [86400, '1 day'], [604800, '1 week']];

function refreshRow(m: SettingsModel, pid: string, plugin: ProviderPlugin): string {
  const pc = m.config.providers.find((p) => p.id === pid);
  const name = (sec: number) => REFRESH_CHOICES.find(([s]) => s === sec)?.[1] ?? `${Math.round(sec / 60)} min`;
  const fallback = `Default (${name(plugin.refreshSeconds ?? DEFAULT_REFRESH_SECONDS)})`;
  const current = pc?.refreshSeconds ?? null;
  const options = [`<option value="" ${current == null ? 'selected' : ''}>${esc(fallback)}</option>`,
    ...REFRESH_CHOICES.map(([sec, label]) => `<option value="${sec}" ${current === sec ? 'selected' : ''}>${esc(label)}</option>`)].join('');
  return `<div class="field"><label for="r-${esc(pid)}">Refresh every</label><select id="r-${esc(pid)}" data-provider-refresh="${esc(pid)}">${options}</select>
      <span class="help">How often Augur reads this provider on its own. The refresh button reads every provider at once.</span></div>`;
}

function updateRows(m: SettingsModel): string {
  const u = m.update;
  const status = {
    idle: '',
    checking: 'Checking for updates.',
    current: 'This is the latest version.',
    available: `Version ${u.available?.version ?? ''} is available.`,
    installing: 'Installing the update.',
    error: 'Could not check for updates. Try again later.',
  }[u.status];
  const busy = u.status === 'checking' || u.status === 'installing';
  const button = u.status === 'available'
    ? '<button class="btn small primary" data-action="update-install">Install and restart</button>'
    : `<button class="btn small" data-action="update-check" ${busy ? 'disabled' : ''}>Check for updates</button>`;
  return `<div class="row"><label class="name">${u.version ? `Version ${esc(u.version)}` : 'Updates'}${status ? `<span class="desc">${esc(status)}</span>` : ''}</label>${button}</div>
      <div class="row"><label class="name">Install updates automatically<span class="desc">Augur installs each new version while the panel is closed, then restarts.</span></label>${toggle('autoupdate', m.config.autoUpdate !== false, 'Install updates automatically')}</div>`;
}

function phoneSection(m: SettingsModel): string {
  const relayField = `<div class="field"><label for="relay">Relay address</label><input type="text" id="relay" data-sync="relay" value="${esc(m.relay)}" placeholder="https://augur.rpgm.tools">
    <span class="help">${m.shellKind === 'pwa'
      ? 'Sends requests to providers that do not allow browser apps, and brings updates from your desktop. It keeps nothing it passes along.'
      : "Carries updates to your phone, locked with a key only your devices have. You can run your own relay from the project's source."}</span></div>`;
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
  return `<h2 class="sec">Phone</h2><div class="card">${relayField}
    <div class="field"><label for="pwa">Web app address</label><input type="text" id="pwa" data-sync="pwaUrl" value="${esc(m.pwaUrl)}" placeholder="https://augur.rpgm.tools">
      <span class="help">Where the phone opens Augur.</span></div>
    <div class="row"><label class="name">${paired ? 'Phone paired' : 'Phone sync'}<span class="desc">${paired
      ? 'Each refresh sends an encrypted copy to your phone.'
      : 'Shows a code to scan with your phone. Needs both addresses above.'}</span></label>
      ${paired ? '<button class="btn small" data-action="sync-show">Show code</button><button class="btn small" data-action="sync-unpair">Unpair</button>'
        : `<button class="btn small primary" data-action="sync-pair" ${m.relay && m.pwaUrl ? '' : 'disabled'}>Pair a phone</button>`}</div>
    ${paired ? `<div class="row"><label class="name">Send API keys to the phone<span class="desc">Lets the phone refresh key-based providers on its own. The keys travel inside the same encrypted sync, which only your paired phone can read.</span></label>${toggle('sharekeys', m.sync?.shareKeys !== false, "Send API keys to the phone")}</div>` : ''}
    ${m.pairQr ? `<div class="field" style="align-items:center">${m.pairQr}<span class="help">Scan it with the phone's camera, or open the <a href="#" data-open="${esc(m.pairUrl ?? '')}">pairing link</a> on the phone. Anyone with the link can read your usage, so keep it to yourself.</span></div>` : ''}
  </div>`;
}

export const CUSTOM_EXAMPLE = [
  {
    id: 'example',
    name: 'Example provider',
    color: { light: '#2a78d6', dark: '#3987e5' },
    links: { usage: 'https://example.com/billing' },
    auth: { type: 'bearer' },
    requests: { main: { url: 'https://api.example.com/v1/usage' } },
    meters: [
      { id: 'monthly', label: 'Monthly quota', usedPct: '=100 * main:$.used / main:$.limit', resetsAt: 'main:$.reset_at', resetsAtFormat: 'iso', windowSeconds: 2592000, windowKind: 'monthly' },
    ],
    money: [{ id: 'balance', label: 'Credits left', amount: 'main:$.balance', currency: 'USD' }],
  },
];
