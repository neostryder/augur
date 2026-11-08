import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const TITLE_MAX = 80;

/** The folder where the Claude desktop app keeps one JSON file per Claude Code session. */
export function desktopSessionsRoot(env: Record<string, string | undefined> = process.env, os: string = platform(), home: string = homedir()): string {
  if (os === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude-code-sessions');
}

/** A title without its leading status emoji and spaces, or undefined when nothing readable is left. */
export function cleanTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined;
  const text = title.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  return text || undefined;
}

const dirs = (path: string): string[] => { try { return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(path, e.name)); } catch { return []; } };
const sessionFiles = (path: string): string[] => { try { return readdirSync(path).filter(n => /^local_.*\.json$/.test(n)).map(n => join(path, n)); } catch { return []; } };

/**
 * Looks up the title the Claude desktop app shows for a Claude Code session id. Only the id and title fields are read, a file is read again only when
 * it changes, and a missing folder or an unreadable file reads as no title. Display only: the title is never stored with a job.
 */
export class SessionTitles {
  private seen = new Map<string, { mtime: number; ids: string[]; title: string | undefined }>();
  private byId = new Map<string, string>();
  private scannedAt = -Infinity;

  constructor(private root: string, private now = Date.now, private ttlMs = 30000) {}

  lookup(id: string | undefined): string | undefined {
    if (!id) return undefined;
    this.refresh();
    return this.byId.get(id);
  }

  private refresh(): void {
    const now = this.now();
    if (now >= this.scannedAt && now - this.scannedAt < this.ttlMs) return;
    this.scannedAt = now;
    const live = new Set<string>();
    for (const account of dirs(this.root).flatMap(dirs)) {
      for (const file of sessionFiles(account)) {
        live.add(file);
        try {
          const mtime = statSync(file).mtimeMs;
          if (this.seen.get(file)?.mtime === mtime) continue;
          const data = JSON.parse(readFileSync(file, 'utf8')) as { cliSessionId?: unknown; priorCliSessionIds?: unknown; title?: unknown };
          const ids = [data.cliSessionId, ...(Array.isArray(data.priorCliSessionIds) ? data.priorCliSessionIds : [])].filter((x): x is string => typeof x === 'string' && x.length > 0);
          this.seen.set(file, { mtime, ids, title: cleanTitle(data.title) });
        } catch { this.seen.delete(file); }
      }
    }
    for (const file of this.seen.keys()) if (!live.has(file)) this.seen.delete(file);
    const next = new Map<string, string>();
    for (const entry of this.seen.values()) if (entry.title) for (const id of entry.ids) next.set(id, entry.title);
    this.byId = next;
  }
}
