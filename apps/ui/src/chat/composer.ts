// The box a message is written in: text, attachments (picked, pasted or dropped), the model and data-level chips, and send or stop.
import { CHAT_FILE_MAX_MB } from '@augur/dispatch-protocol';
import { TIER_COPY } from './copy';
import { bytesLabel, clear, h, icon } from './dom';
import { hueOf, openModelPicker, openTierMenu, pips } from './picker';
import { stickToBottom, editLast } from './thread';
import { activeRoute, activeTier, fits, model, notify, sendMessage, setRoute, setTier, state, stop } from './state';

const MAX_FILES = 8;
let files: File[] = [];
let area: HTMLTextAreaElement, strip: HTMLElement, bar: HTMLElement, box: HTMLElement, sendBtn: HTMLButtonElement;
const drafts = new Map<string, string>();
let draftKey = '';

const keyOf = (): string => state.current?.id ?? '';

function grow(): void { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, innerHeight * 0.4)}px`; }

function addFiles(list: Iterable<File>): void {
  const m = model(activeRoute());
  for (const f of list) {
    if (files.length >= MAX_FILES) { notify(`At most ${MAX_FILES} files go with one message.`, 'error'); break; }
    if (f.size > CHAT_FILE_MAX_MB * 1048576) { notify(`${f.name} is larger than ${CHAT_FILE_MAX_MB} MB.`, 'error'); continue; }
    if (f.size === 0) { notify(`${f.name} is empty.`, 'error'); continue; }
    if (f.type.startsWith('image/') && m && !m.vision) notify(`${m.label} cannot see images. Pick a model that can before you send.`);
    files.push(f);
  }
  drawStrip();
  syncSend();
}

function drawStrip(): void {
  clear(strip);
  strip.hidden = !files.length;
  files.forEach((f, i) => {
    const thumb = f.type.startsWith('image/') ? h('img', { src: URL.createObjectURL(f), alt: '' }) : h('span', { class: 'ico' }, icon(f.type.startsWith('audio/') ? 'audio' : 'file', 18));
    strip.append(h('span', { class: 'pend' }, thumb, h('span', {}, `${f.name} `, h('small', { style: 'color:var(--muted)' }, bytesLabel(f.size))),
      h('button', { type: 'button', 'aria-label': `Remove ${f.name}`, on: { click: () => { files.splice(i, 1); drawStrip(); syncSend(); } } }, icon('close', 14))));
  });
}

function syncSend(): void {
  const busy = !!state.streaming;
  const m = model(activeRoute());
  sendBtn.classList.toggle('stop', busy);
  sendBtn.replaceChildren(icon(busy ? 'stop' : 'send', 18));
  sendBtn.setAttribute('aria-label', busy ? 'Stop the reply' : 'Send');
  sendBtn.dataset.tip = busy ? 'Stop (Esc)' : 'Send (Enter)';
  sendBtn.disabled = !busy && (!(area.value.trim() || files.length) || !m || !fits(m, activeTier()));
}

async function submit(): Promise<void> {
  if (state.streaming) { stop(); return; }
  const text = area.value.trim(), m = model(activeRoute());
  if (!text && !files.length) return;
  if (!m) { notify('Pick a model first.', 'error'); return; }
  if (!fits(m, activeTier())) { notify(`${m.label} is not cleared for ${TIER_COPY[activeTier()].name.toLowerCase()} data.`, 'error'); return; }
  if (!m.vision && files.some(f => f.type.startsWith('image/'))) { notify(`${m.label} cannot see images. Pick a model that can, or remove the image.`, 'error'); return; }
  const send = { text, files };
  area.value = '';
  files = [];
  drawStrip();
  grow();
  stickToBottom();
  drafts.delete(keyOf());
  const ok = await sendMessage(send);
  if (!ok) { area.value = send.text; files = send.files; drawStrip(); grow(); }
  syncSend();
  area.focus();
}

/** Redraws the parts of the composer that follow the chat: the chips and the send button. */
export function renderComposer(): void {
  if (draftKey !== keyOf()) { drafts.set(draftKey, area.value); draftKey = keyOf(); area.value = drafts.get(draftKey) ?? ''; files = []; drawStrip(); grow(); }
  const m = model(activeRoute()), tier = activeTier(), locked = !!state.current && state.current.tree.length > 0;
  clear(bar);
  const modelChip = h('button', { class: 'chip', type: 'button', 'aria-haspopup': 'dialog', 'data-tip': 'Choose the model', on: { click: e => openModelPicker(e.currentTarget as HTMLElement, { current: activeRoute(), onPick: r => void setRoute(r), up: true }) } },
    h('span', { class: 'dot', style: { background: m ? hueOf(m.route) : 'var(--muted)' } }), h('span', { class: 'lab' }, m?.label ?? 'Choose a model'), m ? icon(m.local ? 'home' : 'cloud', 14) : null, icon('up', 14));
  const tierChip = h('button', { class: `chip${m && !fits(m, tier) ? ' warn' : ''}`, type: 'button', 'aria-haspopup': 'menu', 'data-card-title': `Data level: ${TIER_COPY[tier].name}`, 'data-card': TIER_COPY[tier].blurb, on: { click: e => openTierMenu(e.currentTarget as HTMLElement, tier, locked, t => void setTier(t), true) } },
    icon('lock', 14), pips(tier), h('span', { class: 'lab' }, TIER_COPY[tier].name));
  const attach = h('button', { class: 'ib', type: 'button', 'aria-label': 'Attach files', 'data-tip': 'Attach files', on: { click: () => picker.click() } }, icon('clip'));
  bar.append(attach, modelChip, tierChip, h('span', { class: 'grow' }), sendBtn);
  syncSend();
}

const picker = h('input', { type: 'file', multiple: true, hidden: true, on: { change: () => { addFiles(picker.files ? [...picker.files] : []); picker.value = ''; } } });

export function mountComposer(host: HTMLElement): void {
  area = h('textarea', { rows: 1, placeholder: 'Message the model', 'aria-label': 'Message', enterKeyHint: 'send', autocomplete: 'off', spellcheck: true });
  strip = h('div', { class: 'pending', hidden: true });
  bar = h('div', { class: 'bar' });
  sendBtn = h('button', { class: 'send', type: 'button', on: { click: () => void submit() } });
  box = h('div', { class: 'box' }, strip, area, bar, picker);
  host.append(h('div', { class: 'col' }, box, h('div', { class: 'foot-note' }, 'Models can be wrong. Check anything that matters.')));
  area.addEventListener('input', () => { grow(); syncSend(); });
  area.addEventListener('keydown', e => {
    const coarse = matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); void submit(); }
    else if (e.key === 'Escape' && state.streaming) { e.preventDefault(); stop(); }
    else if (e.key === 'ArrowUp' && !area.value && editLast()) e.preventDefault();
  });
  area.addEventListener('paste', e => { const got = [...(e.clipboardData?.files ?? [])]; if (got.length) { e.preventDefault(); addFiles(got); } });
  const over = (e: DragEvent): void => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); box.classList.add('drop'); } };
  for (const t of ['dragenter', 'dragover']) document.addEventListener(t, over as EventListener);
  document.addEventListener('dragleave', e => { if (!(e as DragEvent).relatedTarget) box.classList.remove('drop'); });
  document.addEventListener('drop', e => { const d = e as DragEvent; if (!d.dataTransfer?.files.length) return; e.preventDefault(); box.classList.remove('drop'); addFiles([...d.dataTransfer.files]); area.focus(); });
  draftKey = keyOf();
  renderComposer();
}

export const focusComposer = (): void => area?.focus();
