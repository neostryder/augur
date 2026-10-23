// The settings drawer: the system prompt and every setting the model offers, with a plain-language card on each and the rare ones under Advanced.
// Only a setting you change is sent. A changed one shows a Reset, and an untouched one shows the model's own default.
import type { ChatSettingDef } from '@augur/dispatch-protocol';
import { SETTINGS_NOTE } from './copy';
import { clear, h, icon, iconButton } from './dom';
import { activeRoute, activeSettings, activeSystem, model, setSettings, setSystem, state, emit } from './state';

const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
const rangeText = (d: ChatSettingDef): string => (d.min !== undefined || d.max !== undefined ? `Range ${d.min ?? '...'} to ${d.max ?? '...'}` : '');
const defText = (d: ChatSettingDef): string => [d.default !== undefined && d.default !== '' ? `Model default: ${String(d.default)}` : 'Model default is used', rangeText(d)].filter(Boolean).join('. ');

function control(d: ChatSettingDef, value: unknown, set: (v: unknown) => void): HTMLElement {
  const unset = !isSet(value);
  switch (d.type) {
    case 'number':
    case 'integer': {
      const num = h('input', { type: 'number', class: 'sm', ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}), step: d.step ?? (d.type === 'integer' ? 1 : 'any'), value: unset ? '' : String(value), placeholder: d.default !== undefined ? String(d.default) : 'default', 'aria-label': d.label });
      num.addEventListener('change', () => set(num.value === '' ? undefined : Number(num.value)));
      const ctl = h('div', { class: 'ctl' });
      if (d.type === 'number' && d.min !== undefined && d.max !== undefined) {
        const range = h('input', { type: 'range', min: d.min, max: d.max, step: d.step ?? 0.01, value: String(unset ? (d.default ?? d.min) : value), 'aria-label': `${d.label} slider` });
        range.addEventListener('input', () => { num.value = range.value; });
        range.addEventListener('change', () => set(Number(range.value)));
        ctl.append(range);
      }
      ctl.append(num);
      return ctl;
    }
    case 'boolean': {
      const cb = h('input', { type: 'checkbox', checked: unset ? d.default === true : value === true, 'aria-label': d.label });
      cb.addEventListener('change', () => set(cb.checked));
      return h('div', { class: 'ctl' }, h('span', { class: 'switch' }, cb, h('span')), h('span', { class: 'hint' }, unset ? 'Not set' : value === true ? 'On' : 'Off'));
    }
    case 'choice': {
      const sel = h('select', { 'aria-label': d.label }, h('option', { value: '' }, 'Model default'), ...(d.choices ?? []).map(c => h('option', { value: c, selected: value === c }, c)));
      sel.addEventListener('change', () => set(sel.value || undefined));
      return h('div', { class: 'ctl' }, sel);
    }
    case 'text': {
      const ta = h('textarea', { value: unset ? '' : String(value), placeholder: d.default ? String(d.default) : '', 'aria-label': d.label });
      ta.addEventListener('change', () => set(ta.value.trim() ? ta.value : undefined));
      return h('div', { class: 'ctl' }, ta);
    }
    case 'text_list': {
      const ta = h('textarea', { value: Array.isArray(value) ? value.join('\n') : '', placeholder: 'One per line', 'aria-label': d.label });
      ta.addEventListener('change', () => set(ta.value.split('\n').filter(Boolean)));
      return h('div', { class: 'ctl' }, ta);
    }
  }
}

function field(d: ChatSettingDef, settings: Record<string, unknown>, change: (key: string, v: unknown) => void): HTMLElement {
  const value = settings[d.key], on = isSet(value);
  const info = h('button', { class: 'info', type: 'button', 'aria-label': `About ${d.label}`, 'data-card-title': d.label, 'data-card': d.tooltip, 'data-card-def': defText(d) }, icon('info', 14));
  return h('div', { class: `field${on ? '' : ' unset'}` },
    h('div', { class: 'lbl' }, d.label, info, on ? h('button', { class: 'set', type: 'button', on: { click: () => change(d.key, undefined) } }, 'Reset') : null),
    control(d, value, v => change(d.key, v)),
    !on && d.default !== undefined && d.default !== '' && d.type !== 'text' ? h('span', { class: 'hint' }, `Model default: ${String(d.default)}`) : null);
}

let host: HTMLElement | null = null;

export function closeDrawer(): void { state.settingsOpen = false; host?.remove(); host = null; document.querySelector('.scrim.dim')?.remove(); emit('overlay'); }

export function openDrawer(): void {
  if (host) closeDrawer();
  const m = model(activeRoute());
  state.settingsOpen = true;
  const scrim = h('div', { class: 'scrim dim', on: { pointerdown: closeDrawer } });
  const body = h('div', { class: 'scroll' });
  const draw = (): void => {
    clear(body);
    if (!m) { body.append(h('p', { class: 'empty-list' }, 'Pick a model to see its settings.')); return; }
    const settings = activeSettings();
    const change = (key: string, v: unknown): void => { const next = { ...activeSettings() }; if (!isSet(v)) delete next[key]; else next[key] = v; setSettings(next); draw(); };
    const defs = m.settings.filter(s => s.key !== 'system' && s.via !== 'messages[system]');
    const sysDef = m.settings.find(s => s.key === 'system' || s.via === 'messages[system]');
    if (sysDef) {
      const ta = h('textarea', { value: activeSystem(), placeholder: 'For example: You are a careful reviewer. Answer in short paragraphs.', 'aria-label': sysDef.label });
      ta.addEventListener('change', () => void setSystem(ta.value));
      body.append(h('div', { class: 'field' }, h('div', { class: 'lbl' }, sysDef.label, h('button', { class: 'info', type: 'button', 'aria-label': `About ${sysDef.label}`, 'data-card-title': sysDef.label, 'data-card': sysDef.tooltip }, icon('info', 14))), ta));
    }
    for (const d of defs.filter(s => !s.advanced)) body.append(field(d, settings, change));
    const adv = defs.filter(s => s.advanced);
    if (adv.length) body.append(h('details', { class: 'adv', open: adv.some(s => isSet(settings[s.key])) }, h('summary', {}, `Advanced (${adv.length})`), h('div', { class: 'fields' }, ...adv.map(d => field(d, settings, change)))));
  };
  draw();
  const reset = h('button', { class: 'btn', type: 'button', on: { click: () => { setSettings({}); void setSystem(''); draw(); } } }, 'Reset all');
  host = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Model settings' },
    h('header', {}, h('h2', {}, m ? `${m.label} settings` : 'Settings'), iconButton('close', 'Close', closeDrawer)),
    body, h('footer', {}, h('span', {}, SETTINGS_NOTE), reset));
  document.body.append(scrim, host);
  const key = (e: KeyboardEvent): void => { if (e.key === 'Escape' && host) { closeDrawer(); document.removeEventListener('keydown', key); } };
  document.addEventListener('keydown', key);
  host.querySelector<HTMLElement>('textarea, input, select')?.focus();
}
