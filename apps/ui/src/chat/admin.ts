import type { ChatModelInfo, ChatUser, ChatUserPatch } from '@augur/dispatch-protocol';
import type { DataTier } from '@augur/core';
import { adminApi } from './api';
import { MULTI_USER, TIER_COPY } from './copy';
import { h, iconButton } from './dom';
import { closeDrawer } from './drawer';
import { closePop } from './picker';
import { TIERS, state } from './state';

const A = MULTI_USER.ADMIN;
const message = (e: unknown): string => e instanceof Error ? e.message : A.error;
const button = (text: string, click: () => void): HTMLButtonElement => h('button', { class: 'btn', type: 'button', on: { click } }, text);
const field = (text: string, control: HTMLElement): HTMLElement => h('label', { class: 'field' }, h('span', { class: 'lbl' }, text), control);

function tokenBox(value: string): HTMLElement {
  const input = h('input', { type: 'text', value, readOnly: true, 'aria-label': A.token, autocomplete: 'off', spellcheck: false });
  const status = h('span', { class: 'hint', role: 'status' });
  const copy = button(A.copy, () => {
    if (!navigator.clipboard) { input.select(); status.textContent = A.copyFailed; return; }
    void navigator.clipboard.writeText(value).then(() => { status.textContent = A.copied; }, () => { input.select(); status.textContent = A.copyFailed; });
  });
  return h('div', { class: 'field admin-token' }, field(A.token, input), h('span', { class: 'hint' }, A.tokenOnce), h('div', { class: 'admin-actions' }, copy), status);
}

function userCard(initial: ChatUser, routes: ChatModelInfo[]): HTMLElement {
  let user = initial, queue = Promise.resolve(), revision = 0;
  const errors = new Map<string, string>();
  const title = h('h3', {}, user.name), status = h('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const panel = h('div', { class: 'admin-panel' }), secret = h('div'), devices = h('div', { class: 'field' });
  const saved = (): void => { status.textContent = errors.values().next().value ?? A.saved; status.classList.toggle('error', errors.size > 0); };
  const save = (patch: ChatUserPatch): void => {
    const version = ++revision;
    status.textContent = A.saving;
    status.classList.remove('error');
    queue = queue.then(async () => {
      try { user = await adminApi.patchUser(user.id, patch); title.textContent = user.name; for (const key of Object.keys(patch)) errors.delete(key); }
      catch (e) { for (const key of Object.keys(patch)) errors.set(key, message(e)); }
      if (version === revision) saved();
    });
  };
  const run = async (source: HTMLButtonElement, action: () => Promise<void>): Promise<void> => {
    source.disabled = true;
    try { await queue; await action(); saved(); }
    catch (e) { status.textContent = message(e); status.classList.add('error'); }
    finally { source.disabled = false; }
  };
  const drawDevices = (): void => {
    devices.replaceChildren(h('b', { class: 'lbl' }, A.devices));
    if (!user.devices.length) devices.append(h('span', { class: 'hint' }, A.noDevices));
    for (const device of user.devices) {
      const revoke = button(device.revoked ? A.revoked : A.revoke, () => void run(revoke, async () => {
        await adminApi.revokeDevice(user.id, device.id);
        device.revoked = true;
        drawDevices();
      }));
      revoke.disabled = device.revoked;
      devices.append(h('div', { class: 'admin-device' }, h('span', {}, device.label), revoke));
    }
  };
  const email = h('input', { type: 'email', value: user.email ?? '', 'aria-label': A.email });
  email.addEventListener('change', () => { if (email.reportValidity()) save({ email: email.value.trim() || null }); });
  const enabled = h('input', { type: 'checkbox', checked: !user.disabled, 'aria-label': A.enabled });
  enabled.addEventListener('change', () => save({ disabled: !enabled.checked }));
  const tier = h('select', { 'aria-label': A.tierCap }, ...TIERS.map(t => h('option', { value: t, selected: t === user.tierCap }, TIER_COPY[t].name)));
  tier.addEventListener('change', () => save({ tierCap: tier.value as DataTier }));
  const limit = h('input', { type: 'number', min: 0, step: 1, value: user.dailyMessages === null ? '' : String(user.dailyMessages), 'aria-label': A.dailyMessages });
  limit.addEventListener('change', () => { if (limit.reportValidity()) save({ dailyMessages: limit.value === '' ? null : Number(limit.value) }); });
  const models = h('fieldset', { class: 'field admin-models' }, h('legend', { class: 'lbl' }, A.models));
  const choices: Array<{ route: string; input: HTMLInputElement }> = [];
  for (const route of routes) {
    const refused = !route.usable || route.tierMax === null;
    const input = h('input', { type: 'checkbox', checked: user.models.includes(route.route), disabled: refused });
    choices.push({ route: route.route, input });
    input.addEventListener('change', () => save({ models: [...user.models.filter(r => !routes.some(m => m.route === r)), ...choices.filter(c => c.input.checked).map(c => c.route)] }));
    models.append(h('label', { class: 'admin-model' }, input, h('span', {}, route.label, refused ? h('small', { class: 'hint' }, route.why || A.refused) : null)));
  }
  if (!routes.length) models.append(h('span', { class: 'hint' }, A.noRoutes));
  const confirm = (text: string, action: (purge: boolean) => Promise<void>, deleting = false): void => {
    secret.replaceChildren();
    const purge = h('input', { type: 'checkbox' });
    const cancel = button(A.cancel, () => { panel.replaceChildren(); (deleting ? remove : rotate).focus(); });
    const accept = button(A.confirm, () => void run(accept, async () => { await action(purge.checked); panel.replaceChildren(); }));
    panel.replaceChildren(h('p', {}, text), ...(deleting ? [h('label', { class: 'admin-model' }, purge, A.purge)] : []), h('div', { class: 'admin-actions' }, cancel, accept));
    cancel.focus();
  };
  const add = button(A.addDevice, () => {
    secret.replaceChildren();
    const label = h('input', { type: 'text', required: true, maxLength: 200, 'aria-label': A.deviceLabel });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, A.addDevice);
    panel.replaceChildren(h('form', { class: 'field', on: { submit: e => {
      e.preventDefault();
      if (submit.disabled) return;
      void run(submit, async () => {
        const created = await adminApi.addDevice(user.id, label.value.trim());
        user.devices.push(created.device);
        drawDevices();
        panel.replaceChildren();
        secret.replaceChildren(tokenBox(created.token));
        secret.querySelector('input')?.focus();
      });
    } } }, field(A.deviceLabel, label), h('div', { class: 'admin-actions' }, button(A.cancel, () => { panel.replaceChildren(); add.focus(); }), submit)));
    label.focus();
  });
  const rotate = button(A.newToken, () => confirm(A.rotateConfirm, async () => {
    const rotated = await adminApi.rotateUserToken(user.id);
    secret.replaceChildren(tokenBox(rotated.token));
    secret.querySelector('input')?.focus();
  }));
  const remove = button(A.deleteUser, () => confirm(A.deleteConfirm, async purge => {
    await adminApi.deleteUser(user.id, purge);
    const next = card.nextElementSibling ?? card.previousElementSibling;
    card.remove();
    (next?.querySelector('input, button') as HTMLElement | null)?.focus();
  }, true));
  const card = h('section', { class: 'admin-card', 'aria-label': user.name },
    h('div', { class: 'field' }, title, h('span', { class: 'hint' }, user.id)),
    field(A.email, email),
    h('label', { class: 'admin-model' }, h('span', { class: 'switch' }, enabled, h('span')), A.enabled),
    field(A.tierCap, tier), field(A.dailyMessages, limit), h('span', { class: 'hint' }, A.unlimited), models, devices,
    h('div', { class: 'admin-actions' }, add, rotate, remove), panel, secret, status);
  drawDevices();
  return card;
}

let host: HTMLDialogElement | null = null;

export function closeAdmin(): void { host?.close(); host?.replaceChildren(); host?.remove(); host = null; }

export function openAdmin(): void {
  if (state.identity?.kind !== 'owner') return;
  closeAdmin();
  closePop();
  closeDrawer();
  const body = h('div', { class: 'scroll' }, h('p', { class: 'hint', role: 'status' }, A.loading));
  const dialog = h('dialog', { class: 'drawer admin', role: 'dialog', 'aria-modal': 'true', 'aria-label': A.title },
    h('header', {}, h('h2', {}, A.title), iconButton('close', A.close, closeAdmin)), body);
  host = dialog;
  dialog.addEventListener('cancel', e => { e.preventDefault(); closeAdmin(); });
  dialog.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')].filter(el => !el.matches(':disabled') && el.tabIndex >= 0 && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  document.body.append(dialog);
  dialog.showModal();
  void Promise.all([adminApi.users(), adminApi.routes()]).then(([users, routes]) => {
    if (host !== dialog) return;
    const list = h('div', { class: 'admin-users' }, ...users.map(user => userCard(user, routes)));
    const empty = h('p', { class: 'hint', hidden: users.length > 0 }, A.empty);
    const id = h('input', { type: 'text', required: true, maxLength: 32, pattern: '[a-z0-9](?:[a-z0-9]|-){0,31}', 'aria-label': A.id, autocomplete: 'off' });
    const name = h('input', { type: 'text', required: true, maxLength: 200, 'aria-label': A.name });
    const email = h('input', { type: 'email', 'aria-label': A.email });
    const status = h('span', { class: 'hint', role: 'status' }), secret = h('div');
    const submit = h('button', { class: 'btn primary', type: 'submit' }, A.addUser);
    const form = h('form', { class: 'admin-card', on: { submit: e => {
      e.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      status.textContent = A.saving;
      secret.replaceChildren();
      void adminApi.createUser({ id: id.value.trim(), name: name.value.trim(), ...(email.value.trim() ? { email: email.value.trim() } : {}) }).then(created => {
        if (host !== dialog) return;
        empty.hidden = true;
        list.append(userCard(created.user, routes));
        form.reset();
        secret.replaceChildren(tokenBox(created.token));
        secret.querySelector('input')?.focus();
        status.textContent = A.saved;
        status.classList.remove('error');
      }, e => { status.textContent = message(e); status.classList.add('error'); }).finally(() => { submit.disabled = false; });
    } } }, h('h3', {}, A.addUser), field(A.id, id), field(A.name, name), field(A.email, email), submit, status, secret);
    body.replaceChildren(empty, list, form);
  }, e => { if (host === dialog) body.replaceChildren(h('p', { class: 'hint error', role: 'alert' }, message(e))); });
}
