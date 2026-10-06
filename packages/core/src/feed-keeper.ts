import { addAlerts, applyAcks, clearResolved, emptyFeed, outletsFor, parseAcks, parseFeed } from './feed.js';
import type { AlertFeed, AlertKind, FeedAlert, FeedFlag, Outlet } from './feed.js';
import { buildPush, generateVapidKeys } from './webpush.js';
import type { PushSubscriptionInfo, VapidKeys } from './webpush.js';
import { policyPathFor } from './policy.js';
import type { AppConfig, Snapshot } from './types.js';
import type { Shell } from './shell.js';
import type { PhoneState } from './sync.js';

/** What the keeper needs from where it runs: the window app's shell, or the engine. */
export type KeeperShell = Pick<Shell, 'host' | 'notify' | 'setSecret' | 'loadAlertFeed' | 'saveAlertFeed' | 'sendWebPush'>;

/** An alert to raise. The keeper adds the time, and the outlet grid picks where it goes. */
export type Raise = Omit<FeedAlert, 'raisedAt' | 'outlets'>;

export const FEED_FILE = 'alerts.json';
export const ACKS_FILE = 'alerts-acks.jsonl';
const VAPID_SECRET = 'push.vapid';
/** Once every line in the acks file has been applied and the file is longer than this, it is emptied. */
const ACKS_PRUNE_LINES = 200;

export const UPDATE_ALERT_TEXT = {
  auto: 'Augur installs it the next time the panel closes.',
  manual: 'Open Settings to install it.',
  managed: 'Update it with your package manager.',
};

export function severityFor(kind: AlertKind): FeedAlert['severity'] {
  return kind === 'models' || kind === 'update' ? 'info' : 'warn';
}

/**
 * Keeps the desktop's alert feed. Each alert goes where the outlet grid sends it: a notification on this computer, a push to the phone,
 * or the bell and Claude Code, where it stays until it is dismissed or stops applying. Those kept alerts are also written to alerts.json
 * beside the export file.
 */
export class FeedKeeper {
  feed: AlertFeed = emptyFeed();
  /** Where to push to the paired phone, read from its relay channel. */
  phonePush: PushSubscriptionInfo | null = null;
  private vapid: VapidKeys | null = null;

  constructor(private shell: KeeperShell, private config: () => AppConfig, private pushSubject: () => string) {}

  async load(): Promise<void> {
    const saved = await this.shell.loadAlertFeed?.().catch(() => null);
    this.feed = saved ? parseFeed(JSON.stringify(saved)) : emptyFeed();
  }

  private path(name: string): string | null {
    const exportPath = this.config().exportPath;
    return exportPath ? policyPathFor(exportPath).replace(/policy\.json$/, name) : null;
  }

  async save(): Promise<void> {
    await this.shell.saveAlertFeed?.(this.feed).catch(() => undefined);
    const path = this.path(FEED_FILE), write = this.shell.host.writeHomeFileAtomic;
    if (path && write) await write(path, JSON.stringify(this.feed, null, 2)).catch(() => undefined);
  }

  /** Sends each alert where the outlet grid says. True when the feed changed. */
  async raise(items: Raise[], now = new Date()): Promise<boolean> {
    const alerts = this.config().alerts;
    // An alert already in the feed was shown when it came in. Raising it again would notify and push a second time.
    items = items.filter((item) => !this.feed.alerts.some((a) => a.id === item.id));
    if (!alerts.enabled || !items.length) return false;
    const kept: FeedAlert[] = [];
    for (const item of items) {
      const outlets = outletsFor(alerts.outlets, item.kind);
      if (outlets.includes('system')) await this.shell.notify(item.title, item.body).catch(() => undefined);
      if (outlets.includes('phone')) await this.sendPush(item);
      const keep = outlets.filter((o): o is Outlet => o === 'augur' || o === 'claude');
      if (keep.length) kept.push({ ...item, raisedAt: now.toISOString(), outlets: keep });
    }
    if (!kept.length) return false;
    if (kept.every((k) => this.feed.alerts.some((a) => a.id === k.id))) return false;
    this.feed = addAlerts(this.feed, kept, now);
    await this.save();
    return true;
  }

  /** Drops alerts that have stopped applying. True when the feed changed. */
  async clear(snapshot: Snapshot | null, flags: Record<FeedFlag, boolean>, now = new Date()): Promise<boolean> {
    const r = clearResolved(this.feed, snapshot, flags, now);
    if (!r.changed) return false;
    this.feed = r.feed;
    await this.save();
    return true;
  }

  async dismiss(ids: string[]): Promise<boolean> {
    const r = applyAcks(this.feed, ids);
    if (!r.changed) return false;
    this.feed = r.feed;
    await this.save();
    return true;
  }

  /** Applies dismissals from the Claude Code mod. True when the feed changed. */
  async checkAcks(): Promise<boolean> {
    const path = this.path(ACKS_FILE), read = this.shell.host.readHomeFile, write = this.shell.host.writeHomeFileAtomic;
    if (!path || !read) return false;
    const text = await read(path).catch(() => null);
    if (!text) return false;
    const changed = await this.dismiss(parseAcks(text));
    // All lines are applied now. The file is only emptied if the mod has not written to it since it was read.
    if (write && text.split('\n').length > ACKS_PRUNE_LINES && (await read(path).catch(() => null)) === text) await write(path, '').catch(() => undefined);
    return changed;
  }

  /** Takes the phone's upload: what it dismissed and where to push. True when the feed changed. */
  async mergePhone(state: PhoneState): Promise<boolean> {
    this.phonePush = state.push;
    return this.dismiss(state.acks);
  }

  /** The public half of this desktop's VAPID key. It is made once and kept in the keychain, and is null when the keychain is unavailable. */
  async pushKey(): Promise<string | null> {
    if (this.vapid) return this.vapid.publicKey;
    try {
      const saved = await this.shell.host.secret(VAPID_SECRET);
      if (saved) this.vapid = JSON.parse(saved) as VapidKeys;
      else {
        const made = await generateVapidKeys();
        await this.shell.setSecret(VAPID_SECRET, JSON.stringify(made));
        this.vapid = made;
      }
      return this.vapid.publicKey;
    } catch { return null; }
  }

  private async sendPush(item: Raise): Promise<void> {
    const sub = this.phonePush, send = this.shell.sendWebPush;
    if (!sub || !send || !(await this.pushKey()) || !this.vapid) return;
    try {
      const req = await buildPush(sub, { id: item.id, title: item.title, body: item.body }, this.vapid, this.pushSubject());
      const status = await send(req.endpoint, req.headers, req.body);
      // The push service no longer knows this subscription. The phone sends a new one the next time push is turned on.
      if (status === 404 || status === 410) this.phonePush = null;
    } catch { /* a push that cannot be sent leaves the alert in the feed */ }
  }
}
