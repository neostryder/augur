// Shared setup for the integration tests: a temp data folder, policy.json, usage.json and routes.json, and a supervisor over them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPolicyFile, emptyPolicy, fieldPath, importPolicy, setField } from '@augur/core';
import type { JobRecord, JobRequest } from '@augur/dispatch-protocol';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { ServiceConfig } from '../src/config.js';
import { enabledAdapters } from '../src/adapters/index.js';
import { policySource, routeSource, usageSource } from '../src/sources.js';
import { Store } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';

export const FAKE = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));
export const JOBHOST = fileURLToPath(new URL('../native/bin/jobhost.exe', import.meta.url));
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const now = new Date('2026-09-28T12:00:00Z');
const RULES = { providers: { test: { defaults: { dataTier: 'internal', output: 'write_files' }, models: {
  'test/fake': { id: 'fake-1', rule: { activities: { write_code: 'preferred', research: 'normal' } } },
  'test/ask': { id: 'ask-1', rule: { askFirst: true, activities: { write_code: 'normal' } } },
  'test/text': { id: 'text-1', rule: { output: 'text_only', activities: { research: 'normal' } } },
  'test/sandboxed': { id: 'sbx-1', rule: { sandbox: true, activities: { write_code: 'normal' } } },
  'test/public': { id: 'pub-1', rule: { dataTier: 'public', activities: { write_code: 'normal' } } } } } } };

export interface Env {
  root: string; dir: string; home: string; store: Store; sup: Supervisor; config: ServiceConfig; routesPath: string;
  writePolicy(confirm?: boolean): void; writeRoutes(routes: Record<string, unknown>): void; writeUsage(pct: number): void;
  make(over?: Partial<ServiceConfig>, env?: NodeJS.ProcessEnv): Supervisor; dispose(): void;
}

const nodeRoute = (extra: Record<string, unknown> = {}) => ({ command: process.execPath, prefixArgsJson: JSON.stringify([FAKE]), ...extra });
export const ROUTES = {
  fake: { model: 'test/fake', adapter: 'codex-exec', options: nodeRoute({ model: 'fake-1', effort: 'low' }) },
  raw: { model: 'test/fake', adapter: 'exec', options: { command: process.execPath, argsJson: JSON.stringify([FAKE]) } },
  boss: { model: 'test/fake', adapter: 'codex-exec', delegation: true, options: nodeRoute() },
  ask: { model: 'test/ask', adapter: 'codex-exec', options: nodeRoute() },
  text: { model: 'test/text', adapter: 'codex-exec', options: nodeRoute() },
  sandboxed: { model: 'test/sandboxed', adapter: 'codex-exec', options: nodeRoute() },
  pub: { model: 'test/public', adapter: 'codex-exec', options: nodeRoute() },
  ghost: { model: 'test/none', adapter: 'codex-exec', options: nodeRoute() },
};

export function makeEnv(over: Partial<ServiceConfig> = {}, env: NodeJS.ProcessEnv = { ...process.env }): Env {
  const root = mkdtempSync(join(tmpdir(), 'augurd-')), dir = join(root, 'data'), home = join(root, 'home');
  mkdirSync(dir, { recursive: true }); mkdirSync(join(home, 'dispatch'), { recursive: true });
  const routesPath = join(home, 'dispatch', 'routes.json');
  const config: ServiceConfig = { ...DEFAULT_CONFIG, adapters: ['codex-exec', 'exec'], jobhostPath: existsSync(JOBHOST) ? JOBHOST : null, ...over };
  const store = new Store(dir), policy = policySource(join(home, 'policy.json')), usage = usageSource(join(home, 'usage.json')), routes = routeSource(routesPath);
  const stores: Store[] = [store];
  const build = (st: Store, cfg: ServiceConfig, e: NodeJS.ProcessEnv) => new Supervisor({ store: st, config: cfg, dir, adapters: enabledAdapters(cfg.adapters), routes: () => routes.read(), policy: () => policy.read(), usage: () => usage.read(), env: e });
  const e: Env = {
    root, dir, home, store, config, routesPath, sup: build(store, config, env),
    writePolicy(confirm = true) {
      const p = emptyPolicy(); importPolicy(p, RULES, now);
      if (confirm) for (const [id, prov] of Object.entries(p.providers)) for (const label of Object.keys(prov.models)) setField(p, fieldPath(id, label, 'status'), 'confirmed', 'test', now);
      writeFileSync(join(home, 'policy.json'), JSON.stringify(buildPolicyFile(p, [{ id: 'test', name: 'Test', metered: true }], now)));
    },
    writeRoutes(routes) { writeFileSync(routesPath, JSON.stringify({ routes })); },
    writeUsage(pct) { writeFileSync(join(home, 'usage.json'), JSON.stringify({ providers: { test: { meters: [{ id: 'weekly', usedPct: pct }] } } })); },
    make(cfg = {}, e2 = env) { const st = new Store(dir); stores.push(st); return build(st, { ...config, ...cfg }, e2); },
    dispose() { for (const s of stores) { try { s.close(); } catch { /* closed */ } } killEverything(root); try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp folder */ } },
  };
  e.writePolicy(); e.writeRoutes(ROUTES);
  return e;
}

/** Ends any process whose command line names the test folder or a marker, so a failed test leaves nothing behind. */
export function killEverything(marker: string): void {
  spawnSync('pwsh', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker.replace(/'/g, "''")}*' -and $_.Name -notmatch 'pwsh' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true });
}
export function processesWith(marker: string): number {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -notmatch 'pwsh' } | Measure-Object).Count`], { encoding: 'utf8', windowsHide: true });
  return Number(r.stdout.trim());
}

export const request = (over: Partial<JobRequest> & { text?: string } = {}, cwd = tmpdir()): JobRequest => {
  const { text, ...rest } = over;
  return { route: 'fake', activity: 'write_code', dataTier: 'internal', tools: 'write', output: 'write_files', cwd, prompt: { text: text ?? 'SLEEP 0' }, caller: { kind: 'other', label: 'test' }, ...rest };
};

export async function until<T>(sup: Supervisor, check: () => T | null | undefined | false, ms = 40000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    sup.tick(); const v = check();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the job');
    await sleep(120);
  }
}
export const terminal = (sup: Supervisor, store: Store, id: string) => until(sup, () => { const j = store.get(id); return j && !['queued', 'running', 'cancel_requested', 'needs_approval'].includes(j.state) ? j : null; });
export function submitOk(sup: Supervisor, req: JobRequest): string { const r = sup.submit(req); if ('rejected' in r) throw new Error(`rejected ${r.rejected.code}: ${r.rejected.reason}`); return r.id; }
export type { JobRecord };
