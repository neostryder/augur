import { createPublicKey, verify, type webcrypto } from 'node:crypto';

export type AccessFetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export class AccessVerifier {
  private keys: Array<webcrypto.JsonWebKey & { kid?: string }> = [];
  private expires = 0;
  private lastUnknown = -Infinity;
  private pending: Promise<void> | null = null;

  constructor(private team: string, private aud: string, private fetcher: AccessFetcher = fetch, private now: () => number = Date.now) {}

  private async refresh(): Promise<void> {
    if (!this.pending) this.pending = (async () => {
      const res = await this.fetcher(`https://${this.team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('Access certificates are unavailable.');
      const body = await res.json() as { keys?: Array<webcrypto.JsonWebKey & { kid?: string }> };
      if (!Array.isArray(body.keys)) throw new Error('Access certificates are invalid.');
      this.keys = body.keys;
      this.expires = this.now() + 3_600_000;
    })().finally(() => { this.pending = null; });
    await this.pending;
  }

  async email(token: string): Promise<string | null> {
    try {
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { alg?: string; kid?: string };
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
      if (this.now() >= this.expires) await this.refresh();
      let key = this.keys.find(k => k.kid === header.kid);
      if (!key && this.now() - this.lastUnknown >= 60_000) {
        this.lastUnknown = this.now();
        await this.refresh();
        key = this.keys.find(k => k.kid === header.kid);
      }
      if (!key || key.kty !== 'RSA' || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'))) return null;
      const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>, now = this.now() / 1000;
      if (claims.iss !== `https://${this.team}` || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(this.aud)) return null;
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now - 30) return null;
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now + 30)) return null;
      return typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    } catch { return null; }
  }
}
