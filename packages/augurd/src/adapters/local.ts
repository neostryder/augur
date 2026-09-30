// Adapters that live on one computer only. An installed service looks for `local-adapters.mjs` beside itself, and a source checkout for `private/index.ts`
// beside this file. Neither ships with Augur. A local adapter runs only when the service's config.json lists its id, which the settings pages do not offer.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Adapter } from '@augur/dispatch-protocol';

export async function loadLocalAdapters(): Promise<{ adapters: readonly Adapter[]; error: string | null }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = [join(here, 'local-adapters.mjs'), join(here, 'private', 'index.ts')].find(existsSync);
  if (!file) return { adapters: [], error: null };
  try {
    const mod = await import(pathToFileURL(file).href) as { adapters?: readonly Adapter[] };
    return { adapters: Array.isArray(mod.adapters) ? mod.adapters : [], error: null };
  } catch (e) { return { adapters: [], error: e instanceof Error ? e.message : String(e) }; }
}
