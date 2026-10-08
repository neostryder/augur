import { describe, expect, it } from 'vitest';
import { emptyDraft, emptyProviderForm, parseRoutesText } from '@augur/view-model';
import { planHtml } from '../src/views/add-provider';
import { renderRoutes, type RoutesModel } from '../src/views/routes';

const fileOf = (text: string) => { const p = parseRoutesText(text); if (!p.ok) throw new Error('bad fixture'); return p.file; };
const model = (over: Partial<RoutesModel> = {}): RoutesModel => ({ file: fileOf(JSON.stringify({ routes: { luna: { model: 'codex/luna', adapter: 'codex-exec' }, Bad: { adapter: 'exec' } } })),
  error: '', health: null, sel: null, draft: null, formError: '', note: '', models: ['codex/luna', 'codex/sol'], confirmDelete: false, busy: false, canTest: true, testing: false, testNote: '', keyStored: null, keyNote: '', add: null, canAdd: true, ...over });

describe('the routes page', () => {
  const apiDraft = (over: Record<string, string> = {}) => ({ ...emptyDraft(), name: 'chat', model: 'openai/gpt', adapter: 'openai-api', options: { baseUrl: 'https://api.example.com/v1', model: 'x', ...over } });

  it('shows a write-only key field instead of the variable name when the key is kept in the credential store', () => {
    const env = renderRoutes(model({ sel: '+', draft: apiDraft({ keySource: 'env', apiKeyEnv: 'KEY_VAR' }) }));
    expect(env).toContain('id="rt-opt-apiKeyEnv"');
    expect(env).not.toContain('id="rt-key"');
    const none = renderRoutes(model({ sel: '+', draft: apiDraft({ keySource: 'store' }), keyStored: false }));
    expect(none).not.toContain('id="rt-opt-apiKeyEnv"');
    expect(none).toContain('type="password"');
    expect(none).toContain('No key is saved yet.');
    expect(none).not.toContain('data-action="route-key-clear"');
    const saved = renderRoutes(model({ sel: '+', draft: apiDraft({ keySource: 'store' }), keyStored: true, keyNote: "The key is saved in this computer's key store." }));
    expect(saved).toMatch(/A key is saved in this computer(&#39;|')s key store\./);
    expect(saved).toContain('data-action="route-key-clear"');
    expect(/<input type="password"[^>]*>/.exec(saved)![0]).not.toContain('value=');
    expect(renderRoutes(model({ sel: '+', draft: apiDraft({ keySource: 'store' }), canTest: false }))).toContain('Keys are saved from the desktop app.');
  });

  it('draws the budget and fallback fields with the values the route has', () => {
    const html = renderRoutes(model({ sel: '+', draft: { ...emptyDraft(), name: 'sol', budgetUsd: '20', budgetJobs: '100', budgetPer: 'week', fallback: 'luna' } }));
    expect(html).toContain('id="rt-budget-usd"');
    expect(html).toContain('value="20"');
    expect(html).toContain('<option value="week" selected>per week</option>');
    expect(html).toContain('id="rt-fallback"');
    expect(html).toContain('value="luna"');
  });

  it('lists routes with the adapter in plain words and names what the service skips', () => {
    const html = renderRoutes(model());
    expect(html).toContain('data-route="luna"');
    expect(html).toContain('Codex CLI');
    expect(html).toContain('The service skips one entry');
    expect(html).toContain('<code>Bad</code>');
  });

  it('shows what the service says about each route once it is running, and asks to start it before that', () => {
    expect(renderRoutes(model())).toContain('Start the service');
    const html = renderRoutes(model({ health: { luna: null } }));
    expect(html).toContain('Ready');
    expect(renderRoutes(model({ health: { luna: 'hermes was not found on PATH' } }))).toContain('Cannot run');
  });

  it('draws the option fields of the chosen adapter, marks required ones, and keeps the name fixed once saved', () => {
    const draft = { ...emptyDraft(), name: 'api', model: 'openai/x', adapter: 'openai-api' };
    const html = renderRoutes(model({ sel: '+', draft }));
    expect(html).toContain('data-rt-opt="baseUrl"');
    expect(html).toContain('(required)');
    expect(html).not.toContain('data-action="route-ask-delete"');
    const edit = renderRoutes(model({ sel: 'luna', draft: { ...emptyDraft(), name: 'luna', model: 'codex/luna' } }));
    expect(edit).toContain('readonly');
    expect(edit).toContain('route-ask-delete');
  });

  it('asks twice before deleting, and shows the reason a save was refused', () => {
    const d = { ...emptyDraft(), name: 'luna', model: 'codex/luna' };
    expect(renderRoutes(model({ sel: 'luna', draft: d, confirmDelete: true }))).toContain('data-action="route-delete"');
    expect(renderRoutes(model({ sel: 'luna', draft: d, formError: 'Model is required.' }))).toContain('Model is required.');
  });

  it('shows a file it cannot use as an error and offers no form', () => {
    const html = renderRoutes(model({ file: null, error: 'routes.json is not valid JSON: x' }));
    expect(html).toContain('cannot be used');
    expect(html).not.toContain('data-rt="name"');
  });

  it('offers Test route for a saved route only, and shows what the last test said', () => {
    const saved = { ...emptyDraft(), name: 'luna', model: 'codex/luna' };
    expect(renderRoutes(model({ sel: 'luna', draft: saved }))).toContain('data-action="route-test"');
    expect(renderRoutes(model({ sel: '+', draft: saved }))).not.toContain('route-test');
    expect(renderRoutes(model({ sel: 'luna', draft: saved, canTest: false }))).not.toContain('route-test');
    expect(renderRoutes(model({ sel: 'luna', draft: saved, testing: true }))).toMatch(/route-test[^>]*disabled/);
    expect(renderRoutes(model({ sel: 'luna', draft: saved, testNote: 'luna works. The model answered: ok' }))).toContain('luna works.');
  });
});

describe('the Add provider page', () => {
  const add = (over: Record<string, unknown> = {}, form: Record<string, unknown> = {}) => ({ form: { ...emptyProviderForm('openai'), ...form }, existing: new Set(['luna']), picked: true, busy: false, error: '', ...over });

  it('offers Add provider beside Add route only where it can run', () => {
    expect(renderRoutes(model())).toContain('data-action="provider-new"');
    expect(renderRoutes(model({ canAdd: false }))).not.toContain('data-action="provider-new"');
  });

  it('lists the services with the chosen one pressed, and shows the fields that service needs', () => {
    const html = renderRoutes(model({ add: add() }));
    expect(html).toContain('data-provider-kind="openrouter"');
    expect(html).toContain('<button class="jrow on" data-provider-kind="openai" aria-pressed="true">');
    expect(html).toContain('id="ap-route"');
    expect(html).toContain('id="ap-model"');
    expect(html).not.toContain('id="ap-baseUrl"');
    expect(/<input type="password"[^>]*>/.exec(html)![0]).not.toContain('value="sk');
    const other = renderRoutes(model({ add: add({}, { kind: 'openai-style' }) }));
    expect(other).toContain('id="ap-baseUrl"');
    expect(other).toContain('id="ap-provider"');
    const jev = renderRoutes(model({ add: add({}, { kind: 'typesafe' }) }));
    expect(jev).not.toContain('id="ap-route"');
    expect(jev).toContain('id="ap-key"');
  });

  it('keeps the list first on a narrow screen until a service is picked', () => {
    expect(renderRoutes(model({ add: add({ picked: false }) }))).not.toContain('has-sel');
    expect(renderRoutes(model({ add: add() }))).toContain('has-sel');
  });

  it('shows a hint while empty, the problem once typing starts, and the plan with Add enabled when it is valid', () => {
    expect(planHtml(add())).toContain('Fill in the route name and the model');
    expect(planHtml(add())).toContain('data-action="provider-apply" disabled');
    expect(planHtml(add({}, { route: 'gpt' }))).toContain('--model needs the model id');
    const ok = planHtml(add({}, { route: 'gpt', model: 'gpt-5' }));
    expect(ok).toContain('gpt, a chat route to https://api.openai.com/v1');
    expect(ok).toContain('waits for you to confirm its rules');
    expect(ok).toContain('Show the route entry');
    expect(ok).not.toContain('provider-apply" disabled');
    expect(planHtml(add({}, { route: 'luna', model: 'gpt-5' }))).toContain('already exists');
  });

  it('disables Add while it works and shows what went wrong', () => {
    const html = planHtml(add({ busy: true, error: 'Could not add the provider. routes.json is not valid JSON.' }, { route: 'gpt', model: 'gpt-5' }));
    expect(html).toContain('provider-apply" disabled');
    expect(html).toContain('>Adding<');
    expect(html).toContain('Could not add the provider.');
  });
});
