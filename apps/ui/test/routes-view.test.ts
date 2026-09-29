import { describe, expect, it } from 'vitest';
import { emptyDraft, parseRoutesText } from '../src/routes-model';
import { renderRoutes, type RoutesModel } from '../src/views/routes';

const fileOf = (text: string) => { const p = parseRoutesText(text); if (!p.ok) throw new Error('bad fixture'); return p.file; };
const model = (over: Partial<RoutesModel> = {}): RoutesModel => ({ file: fileOf(JSON.stringify({ routes: { luna: { model: 'codex/luna', adapter: 'codex-exec' }, Bad: { adapter: 'exec' } } })),
  error: '', health: null, sel: null, draft: null, formError: '', note: '', models: ['codex/luna', 'codex/sol'], confirmDelete: false, busy: false, ...over });

describe('the routes page', () => {
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
});
