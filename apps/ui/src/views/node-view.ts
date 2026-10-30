import { ACTIVITIES, ACTIVITY_LABELS, COST_TIERS, DATA_TIERS, DATA_TIER_LABELS, WEIGHT_LABELS, WEIGHT_LEVELS, WEIGHTS, fieldPath, pauseActive, type ActivityId, type DataTier } from '@augur/core';
import { COST_LABELS, NODE_TEXT as T, OUTPUT_LABELS, RULES_TEXT, STATUS_LABELS, clearedFor, dragLevel, nodeActivityLabel, nodeCatalog, nodeMix, nodeTooltip as math, pauseResets, previewCatalog, previewLevel, suggestedThree, statusText, type NodeRow, type NodeState } from '@augur/view-model';
import { activityRows, boolSelect, enumSelect, handlingRows, pauseRows, waitRows, type RulesModel } from './rules';
import { esc } from '../util';

export interface NodeModel extends RulesModel { node: NodeState }
const tip = (text: string): string => `title="${esc(text)}" data-node-tip="${esc(text)}"`;
const lock = '<svg class="nv-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/><circle cx="8" cy="10.5" r=".8"/></svg>';
const nodeId = (value: string): string => [...value].map(char => char.codePointAt(0)!.toString(16)).join('-');
const point = (radius: number, angle: number): [number, number] => [440 + radius * Math.sin(angle * Math.PI / 180), 372 - radius * Math.cos(angle * Math.PI / 180)];

function sector(start: number, end: number): string {
  const [a, b, c, d] = [point(187, start), point(187, end), point(165, end), point(165, start)];
  const large = end - start > 180 ? 1 : 0;
  return `M${a}A187 187 0 ${large} 1 ${b}L${c}A165 165 0 ${large} 0 ${d}Z`;
}

function indicators(row: NodeRow, x: number, y: number): string {
  const level = WEIGHT_LEVELS.indexOf(row.ranked?.level ?? row.resolved.activities.write_code ?? 'normal') + 1;
  const tier = DATA_TIERS.indexOf(row.resolved.dataTier) + 1;
  return `<g aria-hidden="true">${Array.from({ length: 5 }, (_, i) => `<circle cx="${x + i * 7}" cy="${y}" r="2.2" fill="${i < level ? 'var(--focus)' : 'var(--line)'}"/>`).join('')}${Array.from({ length: 4 }, (_, i) => `<rect x="${x + 44 + i * 4}" y="${y + 3 - (i + 1) * 2.5}" width="2.8" height="${(i + 1) * 2.5}" rx=".7" fill="${i < tier ? 'var(--focus)' : 'var(--line)'}"/>`).join('')}</g>`;
}

function ring(m: NodeModel, rows: NodeRow[], selected: NodeRow | undefined, mini = false): string {
  const mix = rows.filter(row => row.share > 0), sum = mix.reduce((total, row) => total + row.ranked!.score, 0);
  let angle = 0;
  const slices = mix.map(row => {
    const sweep = row.ranked!.score / sum * 360, start = angle, end = angle + sweep; angle = end;
    const middle = (start + end) / 2, [x, initialY] = point(248, middle), right = middle < 180, lx = x + (right ? 8 : -8), on = row.label === selected?.label;
    const y = right && lx > 620 && initialY < 245 ? 245 : initialY;
    const attrs = `data-node-select="${esc(row.label)}" data-provider="${esc(row.provider)}"`;
    const [hx, hy] = point(189, start + Math.min(22, sweep / 2));
    return `<g class="nv-slice ${on ? 'on' : ''} ${row.label === m.nodeGhost ? 'ghost' : ''}"><path id="nv-slice-${nodeId(row.label)}" d="${sector(start + Math.min(.8, sweep / 4), end - Math.min(.8, sweep / 4))}" fill="${m.config.layout.nodeView?.sheen === false ? 'var(--accent)' : on ? 'url(#nv-selected)' : 'url(#nv-blue)'}" ${attrs} tabindex="0" role="button" aria-label="${esc(math(row))}" ${tip(math(row))}/>${mini ? '' : `<g class="nv-label" id="nv-label-${nodeId(row.label)}" ${attrs} tabindex="0" role="button" aria-label="${esc(math(row))}" ${tip(math(row))}><path d="M${point(221, middle)}L${right ? lx - 6 : lx + 6},${y - 4}" stroke="var(--line)"/><text x="${lx}" y="${y}" text-anchor="${right ? 'start' : 'end'}">${esc(row.slug)} <tspan fill="var(--focus)">${row.share}%</tspan></text>${indicators(row, right ? lx : lx - 60, y + 13)}${row.tag ? `<text class="nv-tag" x="${lx}" y="${y + 30}" text-anchor="${right ? 'start' : 'end'}">${esc(row.tag)}</text>` : ''}</g><circle class="nv-edge" cx="${hx}" cy="${hy}" r="6" id="nv-edge-${nodeId(row.label)}" data-node-edge="${esc(row.label)}" data-provider="${esc(row.provider)}" tabindex="0" role="slider" aria-label="${esc(`${row.slug}: ${T.level}`)}" aria-valuemin="1" aria-valuemax="5" aria-valuenow="${WEIGHT_LEVELS.indexOf(row.ranked!.level) + 1}" aria-valuetext="${WEIGHT_LABELS[row.ranked!.level]}" ${tip(T.dragHelp)}/>${on ? `<text class="nv-drag-label" x="${hx - 10}" y="${hy - 25}" text-anchor="end">${T.dragCue}</text>` : ''}`}</g>`;
  }).join('');
  const ticks = m.config.layout.nodeView?.ticks === false || mini ? '' : Array.from({ length: 100 }, (_, i) => `<path d="M${point(201, i * 3.6)}L${point(i % 10 ? 208 : 216, i * 3.6)}" stroke="${i % 10 ? 'var(--line)' : 'var(--muted)'}"/>`).join('');
  return `<svg class="nv-ring" viewBox="${mini ? '230 162 420 420' : '0 0 880 744'}" aria-label="${esc(ACTIVITY_LABELS[m.node.activity])}" role="group"><defs><radialGradient id="nv-blue" gradientUnits="userSpaceOnUse" cx="440" cy="372" r="194"><stop offset=".83" stop-color="#245a9f"/><stop offset="1" stop-color="#5d9be3"/></radialGradient><radialGradient id="nv-selected" gradientUnits="userSpaceOnUse" cx="440" cy="372" r="194"><stop offset=".83" stop-color="#2f78d6"/><stop offset="1" stop-color="#9cc7f4"/></radialGradient></defs><g class="nv-bezel" fill="none"><circle cx="440" cy="372" r="220" stroke="var(--line)"/>${ticks}${!mini && m.config.layout.nodeView?.ticks !== false ? [0, 25, 50, 75].map((value, index) => { const [x, y] = point(142, index * 90); return `<text class="nv-scale" x="${x}" y="${y + 3}" text-anchor="middle">${value}</text>`; }).join('') : ''}<circle cx="440" cy="372" r="155" stroke="var(--line)"/><circle cx="440" cy="372" r="176" stroke="var(--line)" stroke-width="22"/></g>${slices}<g class="nv-center"><text x="440" y="360" text-anchor="middle" class="nv-number">${mini ? '' : mix.length}</text><text x="440" y="386" text-anchor="middle">${mini ? '' : T.inMix}</text><text x="440" y="419" text-anchor="middle" class="nv-subtle">${mini ? '' : `${T.sum} ${sum ? 100 : 0}%`}</text></g><g class="nv-phone-center"><text x="440" y="330" text-anchor="middle">${esc(selected?.slug ?? '')}</text><text x="440" y="385" text-anchor="middle" class="nv-number">${selected?.share ?? 0}%</text><text x="440" y="411" text-anchor="middle">${esc(ACTIVITY_LABELS[m.node.activity])}</text></g></svg>`;
}

function editButton(path: string, value: string, label: string, on: boolean, help: string, icon = ''): string {
  return `<button type="button" id="nv-edit-${nodeId(path + value)}" data-node-edit="${esc(path)}" data-value="${esc(value)}" aria-pressed="${on}" class="${on ? 'on' : ''}" ${tip(help)}>${icon}${esc(label)}</button>`;
}

function weightPanel(m: NodeModel, selected: NodeRow): string {
  const { provider, label, resolved } = selected, activity = m.node.activity, level = selected.ranked?.level ?? resolved.activities[activity] ?? 'normal';
  const path = fieldPath(provider, label, `activities.${activity}`);
  const stops = WEIGHT_LEVELS.map(value => nodeMix(previewLevel(m.config, provider, label, activity, value), m.snapshot, activity, m.node.dataTier).find(row => row.label === label)?.share ?? 0);
  const heat = ACTIVITIES.map(id => {
    const row = nodeMix(m.config, m.snapshot, id, m.node.dataTier).find(row => row.label === label), own = resolved.activities[id];
    const why = row ? nodeActivityLabel(row, id, m.catalog) : T.notInMix;
    return `<button class="nv-heat ${activity === id ? 'on' : ''}" data-node-activity="${id}" ${tip(row?.reason || ACTIVITY_LABELS[id])}><span>${ACTIVITY_LABELS[id]}</span><span class="nv-dots">${WEIGHT_LEVELS.map((_, i) => `<i class="${own && i <= WEIGHT_LEVELS.indexOf(own) ? 'on' : ''}"></i>`).join('')}</span><small>${esc(why)}</small></button>`;
  }).join('');
  return `<section><h3>${T.level} / ${ACTIVITY_LABELS[activity]}</h3><div class="nv-level"><output style="left:${Math.max(12, Math.min(88, WEIGHT_LEVELS.indexOf(level) * 25))}%">${WEIGHT_LABELS[level]} x${WEIGHTS[level]}</output><input id="nv-level" type="range" min="0" max="4" step="1" value="${WEIGHT_LEVELS.indexOf(level)}" style="--nv-stop:${WEIGHT_LEVELS.indexOf(level) * 25}%" data-node-level="${esc(path)}" aria-label="${esc(T.levelHelp)}" ${tip(T.levelHelp)}><div class="nv-detents" aria-hidden="true">${WEIGHT_LEVELS.map(() => '<i></i>').join('')}</div><div class="nv-stops">${WEIGHT_LEVELS.map((value, i) => `<button data-node-edit="${esc(path)}" data-value="${value}" class="${level === value ? 'on' : ''}" ${tip(T.levelHelp)}>${WEIGHT_LABELS[value]}<small>${stops[i]}%</small></button>`).join('')}</div></div><p class="nv-note">${esc(T.stopHelp)}</p></section><section><h3>${T.allActivities} / ${esc(selected.slug)}</h3><div class="nv-heat-strip">${heat}</div></section><details data-node-details="weight"><summary ${tip(T.advanced)}>${T.advanced}</summary>${activityRows(provider, label, selected.entry.rule, m.config.policy!.providers[provider]!.defaults)}</details>`;
}

function dataPanel(m: NodeModel, selected: NodeRow): string {
  const { provider, label, resolved, entry } = selected, defaults = m.config.policy!.providers[provider]!.defaults;
  return `<section><h3 ${tip(T.tierHelp)}>${T.highestTier}</h3><div class="nv-ladder">${DATA_TIERS.map((tier, i) => editButton(fieldPath(provider, label, 'dataTier'), tier, `${i + 1}. ${DATA_TIER_LABELS[tier]}`, resolved.dataTier === tier, T.tierHelp, lock)).join('')}</div><p class="nv-clearance ${clearedFor(resolved.dataTier, m.node.dataTier) ? '' : 'warn'}">${esc(clearedFor(resolved.dataTier, m.node.dataTier) ? `${T.clearance}: ${DATA_TIER_LABELS[resolved.dataTier]}. ${ACTIVITY_LABELS[m.node.activity]}: ${DATA_TIER_LABELS[m.node.dataTier]}.` : T.refuseTier)}</p><label class="nv-sr" for="r-dataTier">${RULES_TEXT.dataTier}</label>${enumSelect(provider, label, 'dataTier', DATA_TIERS, DATA_TIER_LABELS, entry.rule.dataTier, defaults.dataTier, 'Public')}</section><section class="nv-handling"><h3>${T.handling}</h3>${handlingRows(provider, label, entry.rule.dataHandling, defaults.dataHandling)}</section>`;
}

function behaviorPanel(m: NodeModel, selected: NodeRow): string {
  const { provider, label, entry, resolved } = selected, defaults = m.config.policy!.providers[provider]!.defaults, path = fieldPath(provider, label, 'pause');
  const meters = pauseResets(m.snapshot, provider).meters;
  return `<section><h3>${RULES_TEXT.pause}</h3><div class="nv-quick">${pauseActive(resolved.pause) ? `<button class="btn small" data-pause-clear="${esc(path)}" ${tip(RULES_TEXT.resume)}>${RULES_TEXT.resume}</button>` : `<button class="btn small" data-node-pause="hour" data-path="${esc(path)}" ${tip(RULES_TEXT.pauseUntilHelp)}>${T.oneHour}</button><button class="btn small" data-node-pause="tomorrow" data-path="${esc(path)}" ${tip(RULES_TEXT.pauseUntilHelp)}>${T.tomorrow}</button><button class="btn small" data-node-pause="reset" data-path="${esc(path)}" ${meters.length ? '' : 'disabled'} ${tip(meters[0]?.label ?? T.reset)}>${T.reset}</button>`}</div><details data-node-details="pause"><summary ${tip(RULES_TEXT.pauseUntilHelp)}>${T.custom}</summary>${pauseRows(m, provider, label, entry.rule.pause, defaults.pause)}</details></section><section>${field(RULES_TEXT.askFirst, boolSelect(provider, label, 'askFirst', entry.rule.askFirst, defaults.askFirst), RULES_TEXT.askFirstHelp)}<h3>${RULES_TEXT.cost}</h3><div class="nv-segments">${COST_TIERS.map(cost => editButton(fieldPath(provider, label, 'cost'), cost, COST_LABELS[cost]!, resolved.cost === cost, RULES_TEXT.costHelp)).join('')}</div>${field(RULES_TEXT.output, enumSelect(provider, label, 'output', ['write_files', 'patch_only', 'text_only'], OUTPUT_LABELS, entry.rule.output, defaults.output, OUTPUT_LABELS.text_only!), T.behaviorHelp)}${field(RULES_TEXT.sandbox, boolSelect(provider, label, 'sandbox', entry.rule.sandbox, defaults.sandbox), T.behaviorHelp)}${field(RULES_TEXT.effort, `<input type="text" id="nv-effort" data-rule="${esc(fieldPath(provider, label, 'effort'))}" data-kind="text" value="${esc(entry.rule.effort ?? '')}" placeholder="${esc(defaults.effort ?? T.useDefault)}" aria-label="${RULES_TEXT.effort}">`, T.behaviorHelp)}</section><details data-node-details="behavior"><summary ${tip(T.advanced)}>${T.advanced}</summary><label class="nv-sr" for="r-cost">${RULES_TEXT.cost}</label>${enumSelect(provider, label, 'cost', COST_TIERS, COST_LABELS, entry.rule.cost, defaults.cost, COST_LABELS.moderate!)}${waitRows(m, provider, label, entry.rule.useAfter, defaults.useAfter)}<label class="nv-field">${RULES_TEXT.notes}<textarea id="nv-notes" data-rule="${esc(fieldPath(provider, label, 'notes'))}" data-kind="text" ${tip(RULES_TEXT.notesHint)}>${esc(entry.rule.notes ?? '')}</textarea></label><label class="nv-field">${T.seriesKind}<select id="nv-series-kind" data-node-series="${esc(label)}" data-provider="${esc(provider)}">${['llm', 'image', 'speech', 'embed'].map(kind => `<option ${entry.series?.kind === kind ? 'selected' : ''}>${kind}</option>`).join('')}</select></label><label class="nv-field">${T.seriesPattern}<input type="text" id="nv-series-pattern" data-node-series="${esc(label)}" data-provider="${esc(provider)}" value="${esc(entry.series?.pattern ?? '')}" ${tip(T.series)}></label></details>`;
}

const field = (label: string, input: string, help: string): string => `<div class="nv-field" ${tip(help)}><label for="${input.match(/id="([^"]+)"/)?.[1] ?? ''}">${esc(label)}</label>${input}</div>`;

function panel(m: NodeModel, selected: NodeRow | undefined): string {
  if (!selected) return `<aside class="nv-panel"><p class="nv-note">${T.selectionHelp}</p></aside>`;
  const status = fieldPath(selected.provider, selected.label, 'status');
  return `<aside class="nv-panel" aria-label="${esc(selected.label)}"><div class="nv-grabber"></div><header class="nv-panel-head"><h2>${esc(selected.slug)}</h2><span class="chip">${STATUS_LABELS[selected.entry.status]}</span><p>${esc(selected.label)}. ${selected.share}% / ${ACTIVITY_LABELS[m.node.activity]}</p></header><div class="nv-tabs" role="tablist" aria-label="${RULES_TEXT.title}">${(['weight', 'data', 'behavior'] as const).map(tab => `<button id="nv-tab-${tab}" role="tab" aria-selected="${m.node.tab === tab}" aria-controls="nv-tab-panel" data-node-tab="${tab}" ${tip(tab === 'weight' ? T.levelHelp : tab === 'data' ? T.tierHelp : T.behaviorHelp)}>${T[tab]}${tab === 'data' ? `<small>${DATA_TIER_LABELS[selected.resolved.dataTier]}</small>` : ''}</button>`).join('')}</div><div class="nv-panel-body" id="nv-tab-panel" role="tabpanel" aria-labelledby="nv-tab-${m.node.tab}">${m.node.tab === 'weight' ? weightPanel(m, selected) : m.node.tab === 'data' ? dataPanel(m, selected) : behaviorPanel(m, selected)}<div class="nv-status"><button class="btn small nv-phone-dial" data-action="rules-dial">${RULES_TEXT.dialTitle}</button><p>${esc(statusText(m.config.policy!, selected.provider, selected.entry))}</p>${selected.entry.status !== 'confirmed' && selected.entry.status !== 'hidden' ? `<button class="btn small primary" data-status="${esc(status)}" data-value="confirmed" ${tip(RULES_TEXT.confirm)}>${RULES_TEXT.confirm}</button>` : ''}<button class="btn small" data-status="${esc(status)}" data-value="${selected.entry.status === 'hidden' ? 'unreviewed' : 'hidden'}" ${tip(RULES_TEXT.hide)}>${selected.entry.status === 'hidden' ? RULES_TEXT.show : RULES_TEXT.hide}</button></div></div></aside>`;
}

function switcher(m: NodeModel): string {
  if (!m.node.switching) return '';
  const activities = ACTIVITIES.filter(activity => ACTIVITY_LABELS[activity].toLowerCase().includes(m.node.search.toLowerCase()));
  return `<div class="nv-switch-backdrop"><section class="nv-switch" role="dialog" aria-modal="true" aria-label="${T.activity}"><header><input type="search" id="nv-activity-search" aria-label="${T.searchActivities}" placeholder="${T.searchActivities}" value="${esc(m.node.search)}" data-node-search ${tip(T.switchHelp)}><button class="btn small" data-node-switch="close" ${tip(T.close)}>${T.close}</button></header><label class="nv-dialog-gate">${T.dataGate}<select id="nv-gate-dialog" data-node-gate ${tip(T.tierHelp)}>${DATA_TIERS.map(tier => `<option value="${tier}" ${tier === m.node.dataTier ? 'selected' : ''}>${DATA_TIER_LABELS[tier]}</option>`).join('')}</select></label><div class="nv-activity-results">${activities.map(activity => {
    const rows = nodeMix(m.config, m.snapshot, activity, m.node.dataTier), mix = rows.filter(row => row.share > 0), leader = mix[0];
    const total = mix.reduce((sum, row) => sum + row.ranked!.score, 0); let offset = 0;
    const circles = mix.map(row => { const share = row.ranked!.score / total * 100; const html = `<circle r="16" cx="20" cy="20" fill="none" stroke="var(--focus)" stroke-width="4" pathLength="100" stroke-dasharray="${Math.max(0, share - 2)} ${100 - Math.max(0, share - 2)}" stroke-dashoffset="${-offset}"/>`; offset += share; return html; }).join('');
    return `<button id="nv-choose-${activity}" data-node-activity="${activity}" class="${m.node.activity === activity ? 'on' : ''}" ${tip(T.switchHelp)}><svg viewBox="0 0 40 40" aria-hidden="true"><circle r="16" cx="20" cy="20" fill="none" stroke="var(--line)" stroke-width="4"/>${circles}</svg><span><b>${ACTIVITY_LABELS[activity]}</b><small>${mix.length} ${T.inMix.toLowerCase()}${leader ? ` / ${T.leader}: ${esc(leader.slug)} ${leader.share}%` : ''}</small></span><em>${DATA_TIER_LABELS[m.node.dataTier]}</em></button>`;
  }).join('') || `<p>${T.noMatch}</p>`}</div></section></div>`;
}

export function renderNodeView(m: NodeModel): string {
  const rows = nodeMix(m.config, m.snapshot, m.node.activity, m.node.dataTier), selected = rows.find(row => row.provider === m.sel?.provider && row.label === m.sel.model) ?? rows.find(row => row.share > 0) ?? rows[0];
  const active = rows.filter(row => row.share > 0), out = rows.filter(row => row.share === 0);
  const items = nodeCatalog(m.config, m.catalog, m.snapshot).filter(item => !active.some(row => row.label === item.label) && `${item.name} ${item.description}`.toLowerCase().includes(m.node.query.toLowerCase()));
  const suggests = suggestedThree(nodeCatalog(m.config, m.catalog, m.snapshot), m.node.activity, m.node.dataTier);
  return `<div class="nv-layout ${m.config.layout.nodeView?.animation === false ? 'nv-still' : ''} ${m.config.layout.nodeView?.sheen === false ? 'nv-flat' : ''}" data-node-drop><main class="nv-stage"><div class="nv-heading"><button id="nv-activity" class="nv-activity" data-node-switch="open" ${tip(T.switchHelp)}>${ACTIVITY_LABELS[m.node.activity]} <span>v</span></button><label class="nv-gate">${T.dataGate}<select id="nv-gate" data-node-gate ${tip(T.tierHelp)}>${DATA_TIERS.map(tier => `<option value="${tier}" ${tier === m.node.dataTier ? 'selected' : ''}>${DATA_TIER_LABELS[tier]}</option>`).join('')}</select></label><div class="nv-activity-chips">${ACTIVITIES.map(activity => `<button id="nv-quick-${activity}" data-node-activity="${activity}" class="${activity === m.node.activity ? 'on' : ''}" aria-pressed="${activity === m.node.activity}" ${tip(T.switchHelp)}>${ACTIVITY_LABELS[activity]}</button>`).join('')}</div><button class="nv-phone-search" data-node-switch="open" aria-label="${T.searchActivities}" ${tip(T.switchHelp)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4"/><path d="m9.5 9.5 4 4"/></svg></button></div><div class="nv-gauge" data-node-drop>${ring(m, rows, selected)}${selected?.ranked ? `<div class="nv-math" ${tip(T.mathHelp)}><b>${esc(selected.slug)} <span>${selected.share}%</span></b><div class="nv-factors"><span><b>${selected.ranked.weight}</b><small>${T.level}</small></span><i>x</i><span><b>${selected.ranked.fit.toFixed(2)}</b><small>${T.fit}</small></span><i>x</i><span><b>${selected.ranked.usage.toFixed(2)}</b><small>${T.usage}</small></span></div><p>${DATA_TIER_LABELS[selected.resolved.dataTier]} <span>${COST_LABELS[selected.resolved.cost]}</span></p>${selected.ranked.tilt !== 1 || selected.ranked.boost !== 1 ? `<small>${T.balance}: ${selected.ranked.tilt} x ${selected.ranked.boost}</small>` : ''}<small class="nv-pin-note">${T.pinHelp}</small></div>` : ''}${!active.length ? `<div class="nv-empty"><h2>${T.emptyTitle}</h2><p>${T.emptyHelp}</p><button class="btn primary" data-node-suggest ${suggests.length ? '' : 'disabled'} ${tip(suggests.map(item => item.name).join(', ') || T.noSuggestions)}>${T.suggested}</button><label>${T.copy}<select id="nv-copy" data-node-copy ${tip(T.copy)}><option value="">${T.activity}</option>${ACTIVITIES.filter(activity => activity !== m.node.activity).map(activity => `<option value="${activity}">${ACTIVITY_LABELS[activity]}</option>`).join('')}</select></label></div>` : ''}</div><div class="nv-chips" role="group" aria-label="${T.inMix}">${rows.map(row => `<button id="nv-chip-${nodeId(row.label)}" class="${row.label === selected?.label ? 'on' : ''}" data-node-select="${esc(row.label)}" data-provider="${esc(row.provider)}" ${tip(math(row))}><b>${esc(row.slug)}</b>${row.tag ? `<small>${esc(row.tag)}</small>` : ''}<span>${row.share}%</span><span class="nv-sr">${esc(row.reason)}</span></button>`).join('')}</div><div class="nv-legend"><span>${T.level} <i class="nv-sample-dots"></i></span><span>${T.highestTier} <i class="nv-sample-bars"></i></span><small>${T.dragHelp}</small></div><p class="nv-touch-hint">${T.touchHelp}</p><p class="nv-preview ${m.nodeNote ? 'nv-feedback' : ''}" role="status">${esc(m.nodeNote || T.preview)}</p><section class="nv-tray"><header><h3>${T.catalog}</h3><input id="nv-catalog-search" type="search" aria-label="${T.searchCatalog}" placeholder="${T.searchCatalog}" data-node-query value="${esc(m.node.query)}" ${tip(T.addHelp)}></header><div class="nv-catalog">${items.map(item => `<button id="nv-catalog-${nodeId(item.label)}" draggable="true" data-node-add="${esc(item.label)}" class="nv-candidate" ${tip(`${item.description} ${item.limits} ${clearedFor(item.tier, m.node.dataTier) ? T.addHelp : T.refuseTier}`)}><b>${esc(item.name)}</b><small>${esc(item.description || item.provider)}</small><span>${DATA_TIER_LABELS[item.tier]}</span></button>`).join('')}</div></section><section class="nv-out"><h3>${T.out}</h3>${out.map(row => `<button id="nv-out-${nodeId(row.label)}" data-node-select="${esc(row.label)}" data-provider="${esc(row.provider)}" ${tip(row.reason)}><b>${esc(row.slug)}</b>${row.tag ? `<small>${esc(row.tag)}</small>` : ''}<span>${esc(row.reason)}</span><em>0%</em></button>`).join('')}</section></main>${panel(m, selected)}</div>${switcher(m)}`;
}

export function registerNodeView(): void {
  if (customElements.get('augur-node-view')) return;
  class NodeView extends HTMLElement {
    private current!: NodeModel;
    private dragged: string | null = null;
    private stopDrag: (() => void) | null = null;
    private stopHold: (() => void) | null = null;
    private held = false;
    set model(value: NodeModel) {
      if (!value.sel?.model) {
        const rows = nodeMix(value.config, value.snapshot, value.node.activity, value.node.dataTier), row = rows.find(row => row.share > 0) ?? rows[0];
        if (row) { value.sel = { provider: row.provider, model: row.label }; this.emit('node-select', value.sel); }
      }
      this.current = value; this.draw();
    }
    set activity(value: ActivityId) { this.state({ activity: value }); }
    private emit(name: string, detail: unknown): void { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true })); }
    private draw(): void {
      const expanded = [...this.querySelectorAll<HTMLDetailsElement>('details[open]')].map(detail => detail.dataset.nodeDetails);
      const previous = new Map([...this.querySelectorAll<SVGPathElement>('.nv-slice > path')].map(path => [path.dataset.nodeSelect, path.getAttribute('d')!]));
      const active = document.activeElement as HTMLInputElement | null, id = active?.id, caret = active?.selectionStart;
      this.innerHTML = renderNodeView(this.current);
      for (const key of expanded) { const detail = this.querySelector<HTMLDetailsElement>(`[data-node-details="${key}"]`); if (detail) detail.open = true; }
      if (this.current.config.layout.nodeView?.animation !== false && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const path of this.querySelectorAll<SVGPathElement>('.nv-slice > path')) {
          const before = previous.get(path.dataset.nodeSelect), after = path.getAttribute('d');
          if (before && after && before !== after) path.animate([{ d: `path("${before}")` }, { d: `path("${after}")` }], { duration: 250, easing: 'ease-out' });
        }
      }
      for (const control of this.querySelectorAll<HTMLElement>('button,input,select,textarea,summary')) {
        if (!control.dataset.nodeTip) { const text = control.getAttribute('aria-label') || control.closest('label,.row,.nv-field')?.textContent?.trim() || control.textContent?.trim() || T.advanced; control.dataset.nodeTip = text; control.title = text; }
      }
      if (id) { const next = this.querySelector<HTMLInputElement>(`#${id}`); if (next) next.focus(); else if (!this.current.node.switching) this.querySelector<HTMLElement>('#nv-activity')?.focus(); if (caret !== null && caret !== undefined && next?.type === 'search') next.setSelectionRange(caret, caret); }
    }
    connectedCallback(): void {
      this.addEventListener('click', this.onNodeClick);
      this.addEventListener('input', this.input);
      this.addEventListener('change', this.change);
      this.addEventListener('keydown', this.key);
      this.addEventListener('pointerdown', this.pointer);
      this.addEventListener('dragstart', this.dragstart);
      this.addEventListener('dragover', this.dragover);
      this.addEventListener('drop', this.drop);
      this.addEventListener('dragend', this.dragend);
    }
    disconnectedCallback(): void { this.stopDrag?.(); this.stopHold?.(); }
    private state(patch: Partial<NodeState>): void { this.current.node = { ...this.current.node, ...patch }; this.emit('node-state', patch); this.draw(); }
    private onNodeClick = (event: MouseEvent): void => {
      if (this.held) { this.held = false; event.preventDefault(); event.stopPropagation(); return; }
      const element = (event.target as Element).closest<HTMLElement>('button,[data-node-select]');
      if (!element) return;
      const d = element.dataset;
      if (d.nodeTab) this.state({ tab: d.nodeTab as NodeState['tab'] });
      if (d.nodeSwitch) { this.state({ switching: d.nodeSwitch === 'open' }); this.querySelector<HTMLInputElement>('#nv-activity-search')?.focus(); }
      if (d.nodeActivity) this.state({ activity: d.nodeActivity as ActivityId, switching: false });
      if (d.nodeSelect) { this.current.sel = { provider: d.provider!, model: d.nodeSelect }; this.emit('node-select', this.current.sel); this.draw(); }
      if (d.nodeEdit) this.emit('node-edit', { path: d.nodeEdit, value: d.value });
      if (d.nodePause) {
        const now = new Date(), tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
        const meter = pauseResets(this.current.snapshot, d.path!.split('|')[0]!).meters[0];
        const until = d.nodePause === 'hour' ? new Date(now.getTime() + 3600000).toISOString() : d.nodePause === 'tomorrow' ? tomorrow.toISOString() : meter?.resetsAt;
        if (until) this.emit('node-edit', { path: d.path, value: { until, weights: null, ...(d.nodePause === 'reset' && meter ? { meter: meter.id } : {}) } });
      }
      if (d.nodeAdd) this.emit('node-add', { label: d.nodeAdd });
      if (d.nodeSuggest !== undefined) this.emit('node-suggest', {});
    };
    private input = (event: Event): void => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.nodeSearch !== undefined) this.state({ search: input.value });
      if (input.dataset.nodeQuery !== undefined) this.state({ query: input.value });
      if (input.dataset.nodeLevel) {
        const [provider, label] = input.dataset.nodeLevel.split('|') as [string, string], level = WEIGHT_LEVELS[Number(input.value)]!;
        const rows = nodeMix(previewLevel(this.current.config, provider, label, this.current.node.activity, level), this.current.snapshot, this.current.node.activity, this.current.node.dataTier);
        const row = rows.find(item => item.label === label);
        input.style.setProperty('--nv-stop', `${Number(input.value) * 25}%`);
        const output = this.querySelector('output'); if (output) { output.textContent = `${WEIGHT_LABELS[level]} x${WEIGHTS[level]} / ${row?.share ?? 0}%`; (output as HTMLElement).style.left = `${Math.max(12, Math.min(88, Number(input.value) * 25))}%`; }
        this.querySelector('.nv-gauge .nv-ring')!.outerHTML = ring(this.current, rows, row);
      }
    };
    private change = (event: Event): void => {
      const input = event.target as HTMLInputElement, d = input.dataset;
      if (d.nodeGate !== undefined) this.state({ dataTier: input.value as DataTier });
      if (d.nodeCopy !== undefined && input.value) this.emit('node-copy', { activity: input.value });
      if (d.nodeLevel) this.emit('node-edit', { path: d.nodeLevel, value: WEIGHT_LEVELS[Number(input.value)] });
      if (d.nodeSeries) { const pattern = this.querySelector<HTMLInputElement>('#nv-series-pattern')!.value.trim(), kind = this.querySelector<HTMLSelectElement>('#nv-series-kind')!.value; this.emit('node-edit', { path: fieldPath(d.provider!, d.nodeSeries, 'series'), value: pattern ? { kind, pattern } : undefined }); }
    };
    private key = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape' && this.current.node.switching) { event.preventDefault(); event.stopPropagation(); this.state({ switching: false }); this.querySelector<HTMLElement>('[data-node-switch]')?.focus(); }
      if (target.matches('[data-node-tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const tabs = ['weight', 'data', 'behavior'] as const, at = tabs.indexOf(this.current.node.tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (at + (event.key === 'ArrowLeft' ? 2 : 1)) % 3;
        this.state({ tab: tabs[next]! }); this.querySelector<HTMLElement>(`#nv-tab-${tabs[next]}`)?.focus();
      }
      const edge = target.closest<HTMLElement>('[data-node-edge]');
      if (edge && ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const level = Number(edge.getAttribute('aria-valuenow')) - 1;
        const value = event.key === 'Home' ? WEIGHT_LEVELS[0] : event.key === 'End' ? WEIGHT_LEVELS[4] : WEIGHT_LEVELS[Math.max(0, Math.min(4, level + (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1)))];
        this.emit('node-edit', { path: fieldPath(edge.dataset.provider!, edge.dataset.nodeEdge!, `activities.${this.current.node.activity}`), value });
      }
      if (target.matches('path[data-node-select],g[data-node-select]') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      if (this.current.node.switching && event.key === 'Tab') {
        const controls = [...this.querySelectorAll<HTMLElement>('.nv-switch input,.nv-switch button')], first = controls[0], last = controls.at(-1);
        if (event.shiftKey && target === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && target === last) { event.preventDefault(); first?.focus(); }
      }
    };
    private pointer = (event: PointerEvent): void => {
      const edge = (event.target as Element).closest<HTMLElement>('[data-node-edge]');
      this.stopHold?.(); this.held = false;
      if (!edge) {
        const slice = (event.target as Element).closest<HTMLElement>('[data-node-select]');
        if (!slice) return;
        const timer = setTimeout(() => {
          this.held = true; const width = Math.min(300, innerWidth - 24), left = Math.max(12, Math.min(event.clientX - width / 2, innerWidth - width - 12)), top = Math.max(12, Math.min(event.clientY - 100, innerHeight - 140));
          this.insertAdjacentHTML('beforeend', `<div class="nv-touch-tip" role="tooltip" style="width:${width}px;left:${left}px;top:${top}px">${esc(slice.dataset.nodeTip ?? slice.getAttribute('aria-label') ?? '')}</div>`);
        }, 400);
        const stop = () => { clearTimeout(timer); this.querySelector('.nv-touch-tip')?.remove(); document.removeEventListener('pointerup', stop); document.removeEventListener('pointercancel', stop); this.stopHold = null; };
        this.stopHold = stop; document.addEventListener('pointerup', stop, { once: true }); document.addEventListener('pointercancel', stop, { once: true }); return;
      }
      event.preventDefault(); const original = this.current.config, label = edge.dataset.nodeEdge!, provider = edge.dataset.provider!, activity = this.current.node.activity;
      const row = nodeMix(original, this.current.snapshot, activity, this.current.node.dataTier).find(item => item.label === label)!;
      const start = row.ranked?.level ?? row.resolved.activities[activity] ?? 'normal', x = event.clientX, y = event.clientY;
      let value = start;
      const move = (next: PointerEvent) => { value = dragLevel(start, (next.clientX - x) - (next.clientY - y)); this.current = { ...this.current, config: previewLevel(original, provider, label, activity, value), sel: { provider, model: label } }; this.draw(); };
      const stop = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); this.stopDrag = null; };
      const up = () => { stop(); this.current.config = original; this.emit('node-edit', { path: fieldPath(provider, label, `activities.${activity}`), value }); };
      const cancel = () => { stop(); this.current.config = original; this.draw(); };
      this.stopDrag = stop; document.addEventListener('pointermove', move); document.addEventListener('pointerup', up, { once: true }); document.addEventListener('pointercancel', cancel, { once: true });
    };
    private dragstart = (event: DragEvent): void => {
      const item = (event.target as Element).closest<HTMLElement>('[data-node-add]');
      if (!item) return;
      this.dragged = item.dataset.nodeAdd!; event.dataTransfer?.setData('text/plain', this.dragged);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    };
    private dragover = (event: DragEvent): void => {
      if (!(event.target as Element).closest('.nv-gauge') || !this.dragged) return;
      event.preventDefault(); const item = nodeCatalog(this.current.config, this.current.catalog, this.current.snapshot).find(row => row.label === this.dragged);
      if (!item) return;
      if (!clearedFor(item.tier, this.current.node.dataTier)) { if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; this.current.nodeNote = T.refuseTier; this.querySelector('.nv-preview')!.textContent = T.refuseTier; if (!this.querySelector('.nv-drop-tip')) this.querySelector('.nv-gauge')!.insertAdjacentHTML('beforeend', `<div class="nv-drop-tip" role="tooltip">${esc(T.refuseTier)}</div>`); return; }
      if (this.current.nodeGhost === item.label) return;
      this.current.nodeGhost = item.label;
      this.querySelector('.nv-preview')!.textContent = item.exists ? T.preview : T.awaitingReview;
      const config = previewCatalog(this.current.config, item, this.current.node.activity);
      const rows = nodeMix(config, this.current.snapshot, this.current.node.activity, this.current.node.dataTier), row = rows.find(row => row.label === item.label);
      this.querySelector('.nv-gauge .nv-ring')!.outerHTML = ring({ ...this.current, config }, rows, row);
    };
    private drop = (event: DragEvent): void => { if ((event.target as Element).closest('.nv-gauge') && this.dragged) { event.preventDefault(); this.emit('node-add', { label: this.dragged }); } this.dragend(); };
    private dragend = (): void => { this.dragged = null; this.current.nodeGhost = undefined; this.draw(); };
  }
  customElements.define('augur-node-view', NodeView);
}
