// Shared parts of the adapters that run a harness inside a Docker Sandboxes microVM.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteConfig } from '@augur/dispatch-protocol';
import { insideSandbox, optStr, resolveExecutable } from './util.js';

/** The sbx program: the `sbx` route option, then PATH, then the installer's own folder. */
export function sbxCommand(route: RouteConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  const given = optStr(route.options, 'sbx');
  if (given) return existsSync(given) ? given : null;
  const found = resolveExecutable('sbx', env);
  if (found) return found.command;
  const own = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'DockerSandboxes', 'bin', 'sbx.exe') : null;
  return own && existsSync(own) ? own : null;
}

export function sandboxOptions(route: RouteConfig): string | null {
  if (!optStr(route.options, 'sandbox')) return 'route option sandbox is required';
  if (!optStr(route.options, 'workRoot')) return 'route option workRoot (the sandbox workspace folder on this computer) is required';
  if (!optStr(route.options, 'model')) return 'route option model is required';
  return sbxCommand(route) ? null : 'sbx (Docker Sandboxes) was not found';
}

/** Arguments placed before sbx's own. Tests use this to run a stand-in script; a real setup leaves it unset. */
export function sbxPrefix(route: RouteConfig): string[] {
  const raw = optStr(route.options, 'sbxPrefixJson');
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export const workRoot = (route: RouteConfig): string => optStr(route.options, 'workRoot') as string;

/** The job folder as the sandbox sees it. The sandbox mounts its workspace at the host path with the drive letter first. */
export const insidePath = (workspace: string): string => insideSandbox(workspace);
