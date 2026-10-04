import { describe, expect, it } from 'vitest';
import { addModels, emptyPolicy, setField, type AppConfig, type EngineState } from '@augur/core';
import { parseWhen, RulesPage } from '../src/screens/rules.js';
import { pages } from '../src/index.js';
import { NOW, ch, k, setup, state } from './fixtures.js';

function withModels(): EngineState {
  const s = state();
  const policy = emptyPolicy();
  addModels(policy, 'claude', [{ label: 'claude/sonnet', id: 'sonnet', name: 'Sonnet' }, { label: 'claude/haiku', id: 'haiku', name: 'Haiku' }], 'manual');
  addModels(policy, 'codex', [{ label: 'codex/sol', id: 'sol', name: 'Sol' }], 'manual');
  s.config.policy = policy;
  return s;
}

function rules(s: EngineState = withModels()) {
  const page = new RulesPage();
  const list = pages();
  list[2] = page;
  const t = setup(s, { pages: list });
  t.app.active = 2;
  const saved = () => t.calls.filter(([m]) => m === 'saveConfig').map(([, a]) => a[0] as AppConfig);
  return { ...t, page, saved };
}

describe('rules page', () => {
  it('lists the providers collapsed, with a count of models', () => {
    const { draw } = rules();
    const text = draw(100, 40);
    expect(text).toMatch(/Claude.*2 models/);
    expect(text).toMatch(/Codex.*1 model\b/);
    expect(text).not.toContain('Sonnet');
  });

  it('opens a provider with Enter and shows its models', async () => {
    const { app, page, draw } = rules();
    page.form.focus = 'prov:claude';
    await app.key(k('enter'));
    const text = draw(100, 40);
    expect(text).toContain('Sonnet');
    expect(text).toContain('Haiku');
  });

  it('searches by name and hides the providers with no match', async () => {
    const { app, draw } = rules();
    await app.key(ch('/'));
    for (const c of 'sol') await app.key(ch(c));
    await app.key(k('enter'));
    const text = draw(100, 40);
    expect(text).toContain('Sol');
    expect(text).not.toContain('Sonnet');
  });

  it('confirms a model from its detail page and saves the whole config', async () => {
    const { app, page, saved } = rules();
    page.openDetail('claude', 'claude/sonnet');
    page.form.focus = 'status';
    await app.key(k('enter'));
    expect(saved()[0]!.policy!.providers.claude!.models['claude/sonnet']!.status).toBe('confirmed');
  });

  it('sets an activity weight and stamps the edit', async () => {
    const { app, page, saved } = rules();
    page.openDetail('claude', 'claude/sonnet');
    page.form.focus = 'act-write_code';
    await app.key(k('right'));
    const policy = saved()[0]?.policy;
    expect(policy).toBeDefined();
    expect(Object.keys(policy!.stamps).some((p) => p.includes('claude/sonnet'))).toBe(true);
  });

  it('picks models with Space and shows the bulk controls', async () => {
    const { app, page, draw } = rules();
    page.open.add('claude');
    page.form.focus = 'm:claude|claude/haiku';
    await app.key(ch(' '));
    expect(page.picked.has('claude|claude/haiku')).toBe(true);
    expect(draw(100, 60)).toContain('1 selected');
  });

  it('shows the history and undoes a change', async () => {
    const s = withModels();
    setField(s.config.policy!, 'providers.claude.models.claude/sonnet.rule.effort', 'high', 'phone');
    const { app, draw, saved } = rules(s);
    await app.key(ch('c'));
    expect(draw(100, 40)).toContain('Rule changes');
    await app.key(k('enter'));
    expect(saved().length).toBe(1);
  });

  it('previews a dial-back before applying it', async () => {
    const { app, draw, saved } = rules();
    await app.key(ch('d'));
    expect(draw(100, 40)).toContain('Dial back usage');
    expect(saved()).toHaveLength(0);
  });
});

describe('parseWhen', () => {
  it('reads a length from now', () => {
    expect(parseWhen('12h', NOW)).toBe(new Date(NOW + 12 * 3_600_000).toISOString());
    expect(parseWhen('1w', NOW)).toBe(new Date(NOW + 7 * 86_400_000).toISOString());
  });
  it('reads a local date with or without a time', () => {
    expect(parseWhen('2026-10-11 17:00', NOW)).toBe(new Date(2026, 9, 11, 17, 0).toISOString());
    expect(parseWhen('2026-10-11', NOW)).toBe(new Date(2026, 9, 11).toISOString());
  });
  it('refuses anything else, including a date that rolls over', () => {
    expect(parseWhen('soon', NOW)).toBeNull();
    expect(parseWhen('2026-02-31', NOW)).toBeNull();
  });
});
