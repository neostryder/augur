// Installs Augur's Claude Code mod and registers Augur's MCP server with Claude Desktop, from the engine. Each install touches one entry in one file and
// its removal takes out exactly that entry, leaving everything else in the file as it was. The window app's installer writes the same entries.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeStatus, ClaudeTarget } from '@augur/core';
import { atomicWrite, homeRelative } from './home-files.js';

const PLUGIN_DIRS = 'CLAUDE_CODE_PLUGIN_DIRS';
type Json = Record<string, unknown>;

export interface ClaudePaths {
  home: string;
  /** The mod as this build carries it (the folder holding .claude-plugin/plugin.json), or null. */
  bundledMod: string | null;
  /** The command Claude Desktop starts for Augur's MCP server, or null when this build has none. */
  mcpCommand: string | null;
  /** The window app, so the mod can open it; empty when only the terminal app is installed. */
  appExe: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

const listSep = (p: NodeJS.Platform) => (p === 'win32' ? ';' : ':');
const samePath = (p: NodeJS.Platform, a: string, b: string) => (p === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export const modDir = (home: string) => join(home, '.augur', 'claude-mod');
export const settingsPath = (home: string) => join(home, '.claude', 'settings.json');

export function desktopConfigPath(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const dir = platform === 'win32' ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude')
      : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude');
  return join(dir, 'claude_desktop_config.json');
}

/** Where the mod and the MCP launcher sit: beside the bundled service in an install, in the source tree otherwise. AUGUR_SERVICE_DIR overrides both. */
export function defaultClaudePaths(callerUrl: string, appExe = '', env: NodeJS.ProcessEnv = process.env): ClaudePaths {
  const here = env.AUGUR_SERVICE_DIR ?? dirname(fileURLToPath(callerUrl));
  const platform = process.platform;
  // An installed app keeps claude-mod beside the service folder; a source checkout keeps it in apps.
  const mods = [env.AUGUR_CLAUDE_MOD, join(here, 'claude-mod'), join(here, '..', 'claude-mod'), join(here, '..', '..', '..', 'apps', 'claude-mod')].filter((d): d is string => !!d);
  const launcher = join(here, platform === 'win32' ? 'augur-mcp.cmd' : 'augur-mcp');
  return {
    home: homedir(), platform, env, appExe,
    bundledMod: mods.find(d => existsSync(join(d, '.claude-plugin', 'plugin.json'))) ?? null,
    mcpCommand: existsSync(launcher) ? launcher : null,
  };
}

function pluginVersion(dir: string): string | null {
  try { const v = (JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as Json).version; return typeof v === 'string' ? v : null; } catch { return null; }
}

/** Reads a JSON settings file. A missing or blank file reads as an empty object; one that does not parse is an error, so it is never overwritten. */
export function readJson(path: string): Json {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not valid JSON, so Augur left it alone`);
  return value as Json;
}

export function writeJson(path: string, value: Json): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
}

const splitList = (list: string, p: NodeJS.Platform) => list.split(listSep(p)).filter(d => d.trim() !== '');

/** Adds `dir` to the plugin folder list in a settings value. Returns whether anything changed. */
export function addPluginDir(settings: Json, dir: string, p: NodeJS.Platform): boolean {
  const env = (settings.env && typeof settings.env === 'object' ? settings.env : (settings.env = {})) as Json;
  const dirs = splitList(typeof env[PLUGIN_DIRS] === 'string' ? env[PLUGIN_DIRS] as string : '', p);
  if (dirs.some(d => samePath(p, d.trim(), dir))) return false;
  env[PLUGIN_DIRS] = [...dirs, dir].join(listSep(p));
  return true;
}

/** Takes `dir` out of the plugin folder list, dropping the variable and the env block when they end up empty. */
export function removePluginDir(settings: Json, dir: string, p: NodeJS.Platform): boolean {
  const env = settings.env as Json | undefined;
  if (!env || typeof env !== 'object' || typeof env[PLUGIN_DIRS] !== 'string') return false;
  const dirs = splitList(env[PLUGIN_DIRS] as string, p), kept = dirs.filter(d => !samePath(p, d.trim(), dir));
  if (kept.length === dirs.length) return false;
  if (kept.length) env[PLUGIN_DIRS] = kept.join(listSep(p)); else delete env[PLUGIN_DIRS];
  if (!Object.keys(env).length) delete settings.env;
  return true;
}

export function hasPluginDir(settings: Json, dir: string, p: NodeJS.Platform): boolean {
  const list = (settings.env as Json | undefined)?.[PLUGIN_DIRS];
  return typeof list === 'string' && list.split(listSep(p)).some(d => samePath(p, d.trim(), dir));
}

export function setMcp(config: Json, command: string): boolean {
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : (config.mcpServers = {})) as Json;
  const now = servers.augur as Json | undefined;
  if (now && Object.keys(now).length === 1 && now.command === command) return false;
  servers.augur = { command };
  return true;
}

export function mcpIs(config: Json, command: string, p: NodeJS.Platform): boolean {
  const c = ((config.mcpServers as Json | undefined)?.augur as Json | undefined)?.command;
  return typeof c === 'string' && samePath(p, c, command);
}

/** Removes the `augur` server only when it is the one Augur added, so a hand-made entry under that name stays. */
export function removeMcp(config: Json, command: string, p: NodeJS.Platform): boolean {
  if (!mcpIs(config, command, p)) return false;
  delete (config.mcpServers as Json).augur;
  return true;
}

export function claudeStatus(paths: ClaudePaths): ClaudeStatus {
  const dir = modDir(paths.home);
  let loaded = false, desktop = false;
  try { loaded = hasPluginDir(readJson(settingsPath(paths.home)), dir, paths.platform); } catch { /* unreadable settings count as not installed */ }
  if (paths.mcpCommand) { try { desktop = mcpIs(readJson(desktopConfigPath(paths.home, paths.platform, paths.env)), paths.mcpCommand, paths.platform); } catch { /* likewise */ } }
  return { code: loaded ? pluginVersion(dir) : null, bundled: paths.bundledMod ? pluginVersion(paths.bundledMod) : null, desktop, desktopPossible: paths.mcpCommand !== null };
}

/** Copies the mod to ~/.augur/claude-mod, tells it where the usage file and the app are, and adds that folder to Claude Code's plugin folders. Run again after an update, it refreshes the copy. */
export function claudeInstall(paths: ClaudePaths, target: ClaudeTarget, exportPath: string): void {
  if (target === 'desktop') {
    if (!paths.mcpCommand) throw new Error('This build does not include the MCP server');
    const path = desktopConfigPath(paths.home, paths.platform, paths.env), config = readJson(path);
    if (setMcp(config, paths.mcpCommand)) writeJson(path, config);
    return;
  }
  const usage = join(paths.home, homeRelative(exportPath));
  if (!paths.bundledMod) throw new Error('This build does not include the Claude Code mod');
  const dir = modDir(paths.home);
  rmSync(dir, { recursive: true, force: true });
  cpSync(paths.bundledMod, dir, { recursive: true });
  writeJson(join(dir, 'augur-app.json'), { usageFile: usage, exe: paths.appExe });
  const path = settingsPath(paths.home), settings = readJson(path);
  if (addPluginDir(settings, dir, paths.platform)) writeJson(path, settings);
}

export function claudeRemove(paths: ClaudePaths, target: ClaudeTarget): void {
  if (target === 'desktop') {
    if (!paths.mcpCommand) return;
    const path = desktopConfigPath(paths.home, paths.platform, paths.env), config = readJson(path);
    if (removeMcp(config, paths.mcpCommand, paths.platform)) writeJson(path, config);
    return;
  }
  const dir = modDir(paths.home), path = settingsPath(paths.home), settings = readJson(path);
  if (removePluginDir(settings, dir, paths.platform)) writeJson(path, settings);
  rmSync(dir, { recursive: true, force: true });
}
