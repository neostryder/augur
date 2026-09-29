// augurd: the local dispatch service. Jobs run in their own runner processes, so stopping or restarting this process never stops a job.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enabledAdapters } from './adapters/index.js';
import { loadConfig } from './config.js';
import { IpcServer, ensureToken } from './ipc.js';
import { augurHome, dataDir, pipeName } from './paths.js';
import { policySource, routeSource, usageSource } from './sources.js';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';

export interface ServiceOptions { dir?: string; home?: string; pipe?: string; routesPath?: string }

export async function startService(opts: ServiceOptions = {}) {
  const dir = opts.dir ?? dataDir(), home = opts.home ?? augurHome();
  mkdirSync(dir, { recursive: true });
  const log = (msg: string) => { try { appendFileSync(join(dir, 'service.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* logging is best effort */ } };
  const config = loadConfig(dir), store = new Store(dir), token = ensureToken(dir);
  const policy = policySource(join(home, 'policy.json')), usage = usageSource(join(home, 'usage.json'));
  const routes = routeSource(opts.routesPath ?? process.env.AUGURD_ROUTES ?? join(home, 'dispatch', 'routes.json'));
  const supervisor = new Supervisor({ store, config, dir, adapters: enabledAdapters(config.adapters), routes: () => routes.read(), policy: () => policy.read(), usage: () => usage.read() });
  const server = new IpcServer(supervisor, store, token, () => routes.read());
  try { await server.start(opts.pipe ?? pipeName(dir)); }
  catch (e) { store.close(); throw e; }
  supervisor.reconcile();
  const timer = setInterval(() => { try { supervisor.tick(); } catch (e) { log(`tick failed: ${(e as Error).message}`); } }, 500);
  const daily = setInterval(() => { try { supervisor.purge(); } catch (e) { log(`purge failed: ${(e as Error).message}`); } }, 86400000);
  log('started');
  return {
    supervisor, store, config,
    async stop() { clearInterval(timer); clearInterval(daily); await server.close(); store.close(); log('stopped'); },
  };
}

if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'))) {
  startService().then(svc => {
    const quit = () => { void svc.stop().then(() => process.exit(0)); };
    process.on('SIGINT', quit); process.on('SIGTERM', quit);
  }).catch(e => {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') { console.error('augurd is already running.'); process.exit(0); }
    console.error(e); process.exit(1);
  });
}
