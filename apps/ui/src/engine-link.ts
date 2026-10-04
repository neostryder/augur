// How the desktop panel reaches the engine. Inside the window app the engine runs in this page for now; a later build connects to the
// engine in the background service instead, through the same EngineApi.
import { UsageEngine, type EngineApi, type Shell } from '@augur/core';
import { HOSTED } from './hosted';

export async function connectEngine(shell: Shell): Promise<EngineApi> {
  const engine = new UsageEngine(shell, { hosted: HOSTED });
  await engine.start();
  return engine;
}
