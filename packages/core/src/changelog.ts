export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export interface ReleaseChanges {
  version: string;
  changes: string[];
}

/** Each entry is cut to its bold lead sentence so the update tooltip stays short enough to read at a glance. */
export function releaseChanges(changelog: string, from: string, to: string): ReleaseChanges[] {
  const out: ReleaseChanges[] = [];
  let current: ReleaseChanges | null = null;
  for (const line of changelog.split(/\r?\n/)) {
    const heading = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (heading) {
      const v = heading[1]!;
      current = compareVersions(v, from) > 0 && compareVersions(v, to) <= 0 ? { version: v, changes: [] } : null;
      if (current) out.push(current);
      continue;
    }
    if (line.startsWith('## ')) { current = null; continue; }
    const entry = current && line.match(/^- \[Visible\]((?:\s*\[[^\]]+\])*)\s*(.*)$/);
    if (!entry) continue;
    const text = entry[2]!;
    const lead = text.match(/^\*\*(.+?)\*\*/)?.[1] ?? text.replace(/\*\*/g, '');
    current!.changes.push(lead.trim());
  }
  return out.filter((r) => r.changes.length);
}
