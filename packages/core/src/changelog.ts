export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const match = v.replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
    return match ? { core: match.slice(1, 4).map(n => Number(n ?? 0)), pre: match[4]?.split('.') ?? null } : { core: [0, 0, 0], pre: null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = x.core[i]! - y.core[i]!;
    if (d) return Math.sign(d);
  }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined || y.pre[i] === undefined) return x.pre[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x.pre[i]!), yn = /^\d+$/.test(y.pre[i]!);
    if (xn && yn) { const d = Number(x.pre[i]) - Number(y.pre[i]); if (d) return Math.sign(d); }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x.pre[i] !== y.pre[i]) return x.pre[i]! < y.pre[i]! ? -1 : 1;
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
