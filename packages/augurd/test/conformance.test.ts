// Opt-in runs against the real harnesses, each on a cheap model with a one-word task.
// AUGUR_CONFORMANCE is a comma-separated list of: hermes, copilot, grok, mcode, opencode, api. Unset runs nothing.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteConfig } from '@augur/dispatch-protocol';
import { makeEnv, request, submitOk, terminal } from './harness.js';
import type { Env } from './harness.js';

vi.setConfig({ testTimeout: 300000 });
const wanted = new Set((process.env.AUGUR_CONFORMANCE ?? '').split(',').map(s => s.trim()).filter(Boolean));
const envs: Env[] = [];
afterEach(() => { while (envs.length) envs.pop()!.dispose(); });

const TASK = 'Reply with exactly the single word pong and nothing else.';
const local = process.env.LOCALAPPDATA ?? '';

interface Case { name: string; adapter: string; model: string; options: Record<string, string | number | boolean>; route?: Partial<RouteConfig> }
const CASES: Case[] = [
  { name: 'hermes', adapter: 'hermes-exec', model: 'test/fake', options: { model: 'gpt-6-luna', command: join(local, 'hermes/hermes-agent/venv/Scripts/hermes.exe') } },
  { name: 'copilot', adapter: 'copilot-exec', model: 'test/fake', options: { model: 'gpt-6-luna' } },
  { name: 'grok', adapter: 'grok-exec', model: 'test/fake', options: { model: 'grok-4.7-fast' } },
  { name: 'mcode', adapter: 'mcode-sbx', model: 'test/patch', options: { sandbox: 'mc-m3', workRoot: 'C:/Temp/sbx/work/mc-m3', model: 'custom_provider:minimax-direct/MiniMax-M3', maxSteps: 8 } },
  { name: 'opencode', adapter: 'opencode-sbx', model: 'test/patch', options: { sandbox: 'oc-ds', workRoot: 'C:/Temp/sbx/work/oc-ds', model: 'openrouter/deepseek/deepseek-v4.1-flash' } },
  { name: 'api', adapter: 'openai-api', model: 'test/text', options: { baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4.1-flash', apiKeyEnv: 'OPENROUTER_API_KEY', maxTokens: 64 } },
];

describe('real harnesses', () => {
  for (const c of CASES) {
    it.skipIf(!wanted.has(c.name))(`${c.name} answers a one-word task and reports usage`, async () => {
      const e = makeEnv({ adapters: [c.adapter] }); envs.push(e);
      if (c.options.workRoot) mkdirSync(String(c.options.workRoot), { recursive: true });
      e.writeRoutes({ [c.name]: { model: c.model, adapter: c.adapter, options: c.options, ...c.route } });
      const project = join(e.root, 'project'); mkdirSync(project, { recursive: true });
      const id = submitOk(e.sup, request({ route: c.name, activity: 'research', tools: 'read', output: 'text_only', text: TASK }, project));
      const job = await terminal(e.sup, e.store, id);
      const detail = `${job.state} ${job.reason ?? ''}\n${e.sup.logs(id, 'stderr')?.text.slice(-800) ?? ''}`;
      expect(job.state, detail).toBe('completed');
      expect(e.sup.result(id)?.answer?.toLowerCase()).toContain('pong');
      expect(job.usage?.inputTokens ?? 0, 'input tokens reported').toBeGreaterThan(0);
      expect(job.usage?.outputTokens ?? 0, 'output tokens reported').toBeGreaterThan(0);
      if (process.env.AUGUR_CONFORMANCE_OUT) appendFileSync(process.env.AUGUR_CONFORMANCE_OUT, `${c.name}: ${JSON.stringify(job.usage)}\n`);
      if (c.options.workRoot) expect(existsSync(project)).toBe(true);
    });
  }
});
