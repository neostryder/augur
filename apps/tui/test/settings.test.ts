import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, EngineState } from '@augur/core';
import { Screen } from '@augur/terminal';
import { pages } from '../src/index.js';
import { SettingsPage, type SettingsDeps } from '../src/screens/settings.js';
import { ch, k, setup, state } from './fixtures.js';

function settings(deps: Partial<SettingsDeps> = {}, s: EngineState = state(), results: Record<string, unknown> = {}) {
  const page = new SettingsPage({ platform: 'linux', env: { EDITOR: 'ed' }, ...deps });
  const list = pages();
  list[4] = page;
  const t = setup(s, { pages: list, results });
  t.app.active = 4;
  const saved = () => t.calls.filter(([m]) => m === 'saveConfig').map(([, a]) => a[0] as AppConfig);
  return { ...t, page, saved };
}

describe('settings page', () => {
  it('lists the providers with their switches, then each section', () => {
    const { draw } = settings();
    const text = draw(100, 200);
    expect(text).toMatch(/Claude +\[x\] On  \(Enter for more\)/);
    expect(text).toMatch(/Jev +\[ \] Off/);
    for (const heading of ['Providers', 'Appearance', 'Alerts', 'Custom providers', 'Phone', 'This computer']) expect(text).toContain(heading);
    expect(text).toMatch(/notify-send +Keep in Augur +Claude Code/);
    expect(text).not.toMatch(/Keep in Augur +Claude Code +Phone/);
  });

  it('says what to do about an available update for this kind of install', () => {
    const s = state();
    s.update = { version: '1.3.0', status: 'available', available: { version: '1.4.0' }, changes: null };
    expect(settings({ updateAdvice: 'Run augur update to install it.' }, s).draw(120, 200)).toContain('Version 1.4.0 is available. Run augur update to install it.');
    expect(settings({}, s).draw(120, 200)).toContain('Version 1.4.0 is available.');
  });

  it('names the system column after the platform and adds Phone once paired', () => {
    const s = state();
    s.config.sync = { relay: 'https://r', channel: 'c1', pwaUrl: 'https://p' };
    const { draw } = settings({ platform: 'darwin' }, s);
    expect(draw(110, 200)).toMatch(/macOS +Keep in Augur +Claude Code +Phone/);
  });

  it('turns a provider on with Space and saves the whole config', async () => {
    const { app, page, saved } = settings();
    page.form.focus = 'p:jev';
    await app.key(ch(' '));
    expect(saved()[0]!.providers.find((p) => p.id === 'jev')!.enabled).toBe(true);
  });

  it('opens a provider with Enter: keys are typed masked and saved, sign-ins point to the window app', async () => {
    const { app, page, calls, draw } = settings();
    page.form.focus = 'p:jev';
    await app.key(k('enter'));
    const text = draw(100, 60);
    expect(text).toContain('Signing in needs the window app');
    expect(text).toContain('Refresh every');
    page.form.focus = 'p:jev:apiKey';
    await app.key(k('enter'));
    expect(page.typing()).toBe(true);
    for (const c of 'q1z') await app.key(ch(c));
    expect(app.active).toBe(4);
    expect(draw(100, 60)).not.toContain('q1z');
    await app.key(k('enter'));
    expect(calls).toContainEqual(['setProviderKey', ['jev', 'apiKey', 'q1z']]);
    expect(page.typing()).toBe(false);
  });

  it('cancels an edit with Escape and refuses a bad color', async () => {
    const { app, page, saved, draw } = settings();
    page.open = 'claude';
    page.form.focus = 'p:claude:color';
    await app.key(k('enter'));
    for (const c of 'blue') await app.key(ch(c));
    await app.key(k('escape'));
    expect(saved()).toHaveLength(0);
    await app.key(k('enter'));
    for (const c of 'blue') await app.key(ch(c));
    await app.key(k('enter'));
    expect(saved()).toHaveLength(0);
    expect(draw()).toContain('That is not a hex color');
  });

  it('ticks a cell of the alert grid', async () => {
    const { app, page, saved } = settings();
    page.form.focus = 'outlet:pace';
    const before = state().config.alerts.outlets.pace.augur;
    await app.key(k('right'));
    await app.key(ch(' '));
    expect(saved()[0]!.alerts.outlets.pace.augur).toBe(!before);
  });

  it('reads the percentage list the way the window app does', async () => {
    const { app, page, saved } = settings();
    page.form.focus = 'pct';
    await app.key(k('enter'));
    await app.key(k('u', { ctrl: true }));
    for (const c of '95, 50 x 120') await app.key(ch(c));
    await app.key(k('enter'));
    expect(saved()[0]!.alerts.pctThresholds).toEqual([50, 95]);
  });

  it('edits custom providers in the editor, keeping a draft that fails the check', async () => {
    let next = '[{"id":"mine"}]';
    const spawn = vi.fn((cmd: string, file: string) => { expect(cmd).toBe('ed'); expect(readFileSync(file, 'utf8')).toContain('"id": "example"'); writeFileSync(file, next); return true; });
    const { app, page, saved, draw } = settings({ spawn });
    page.form.focus = 'custom';
    await app.key(k('enter'));
    expect(saved()).toHaveLength(0);
    expect(draw(100, 200)).toContain('Each definition needs id, name, auth and requests.');
    spawn.mockImplementation((_cmd, file) => { expect(readFileSync(file, 'utf8')).toBe('[{"id":"mine"}]'); next = '[{"id":"mine","name":"Mine","auth":{"type":"none"},"requests":{"main":{"url":"https://x"}}}]'; writeFileSync(file, next); return true; });
    await app.key(k('enter'));
    expect(saved()[0]!.custom![0]!.id).toBe('mine');
  });

  it('pairs a phone and draws the code with the link, which c copies', async () => {
    const url = 'https://augur.rpgm.tools/#pair=abc123';
    const { app, page, calls, copied, draw } = settings({}, state(), { pair: url });
    page.form.focus = 'pair';
    await app.key(k('enter'));
    expect(calls.map(([m]) => m)).toContain('pair');
    const text = draw(100, 50);
    expect(text).toContain('Pair a phone');
    expect(text).toContain(url);
    expect(text).toMatch(/[▀▄█]{6}/);
    expect(draw(60, 20)).toContain('too small for the code');
    await app.key(ch('c'));
    expect(copied).toEqual([url]);
  });

  it('turns start at login on through the service command, where the platform has it', async () => {
    const enable = vi.fn(async () => ({ ok: true, message: 'Augur starts at login.' }));
    const login = { state: () => ({ supported: true, enabled: false }), enable, disable: vi.fn() };
    const { app, page, draw } = settings({ login });
    page.form.focus = 'login';
    await app.key(ch(' '));
    expect(enable).toHaveBeenCalled();
    expect(draw()).toContain('Augur starts at login.');
    const none = settings({ login: { ...login, state: () => ({ supported: false, enabled: false }) } });
    expect(none.draw(100, 200)).not.toContain('Start at login');
  });

  it('shows first-run setup with the providers and a start button', async () => {
    const s = state();
    s.firstRun = true;
    const { app, page, calls, draw } = settings({}, s);
    const text = draw(100, 60);
    expect(text).toContain('Set up Augur');
    expect(text).not.toContain('Appearance');
    page.form.focus = 'finish';
    await app.key(k('enter'));
    expect(calls.map(([m]) => m)).toContain('finishSetup');
  });

  it('switches the theme with the arrow keys', async () => {
    const { app, page, saved } = settings();
    page.form.focus = 'theme';
    await app.key(k('right'));
    expect(saved()[0]!.layout.theme).toBe('light');
  });

  it('scrolls to keep the focused row in view', async () => {
    const { app, page, draw } = settings();
    page.form.focus = 'export';
    const sc = new Screen(100, 20);
    app.draw(sc);
    expect(sc.text()).toContain('Also save the latest numbers');
    await app.key(k('home'));
    expect(draw(100, 20)).toContain('Providers');
  });
});
