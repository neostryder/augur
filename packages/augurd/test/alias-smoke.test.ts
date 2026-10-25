import { describe, expect, it } from 'vitest';
import { createAliasSmoke } from '../src/main.js';
import type { PolicyFile } from '@augur/core';
import type { JobRequest, RouteConfig } from '@augur/dispatch-protocol';

describe('alias smoke submit', () => {
  it('uses the first permitted activity and passes the model override to the fake submit', async () => {
    const model = { provider: 'openrouter', id: 'old', status: 'confirmed', activities: { review_code: 'often' }, dataTier: 'public', dataHandling: {}, inherited: [] };
    const policy = { providers: { openrouter: { models: { 'openrouter/model': model } } } } as unknown as PolicyFile;
    const route: RouteConfig = { model: 'openrouter/model', adapter: 'openai-api', options: { model: 'old' } };
    let request: JobRequest | undefined, override: RouteConfig | undefined;
    const smoke = createAliasSmoke({ home: '/tmp/augur', routes: () => ({ api: route }), policy: () => policy,
      submit: (req, routeArg) => { request = req; override = routeArg; return { rejected: { code: 'not_picked', reason: 'test rejection' } }; }, getJob: () => null });
    expect(await smoke('openrouter', 'openrouter/model', 'new')).toEqual({ status: 'untested', reason: 'test rejection' });
    expect(request).toMatchObject({ activity: 'review_code', dataTier: 'public', tools: 'none', allow: ['unpicked'] });
    expect(override?.options?.model).toBe('new');
  });
  it('skips a rule that permits only activities needing another input kind', async () => {
    const model = { provider: 'openrouter', id: 'old', status: 'confirmed', activities: { read_images: 'often' }, dataTier: 'public', dataHandling: {}, inherited: [] };
    const policy = { providers: { openrouter: { models: { 'openrouter/model': model } } } } as unknown as PolicyFile;
    const route: RouteConfig = { model: 'openrouter/model', adapter: 'openai-api' };
    let submitted = false;
    const smoke = createAliasSmoke({ home: '/tmp/augur', routes: () => ({ api: route }), policy: () => policy,
      submit: () => { submitted = true; return { rejected: { code: 'not_picked', reason: 'test' } }; }, getJob: () => null });
    expect(await smoke('openrouter', 'openrouter/model', 'new')).toMatchObject({ status: 'untested', reason: expect.stringContaining('no text-prompt activity') });
    expect(submitted).toBe(false);
  });
});
