import { describe, expect, it } from 'vitest';
import { parsePairing } from '@augur/core';
import { pairingQuestion, replacesPairing } from '../src/pairing';

const channel = 'a'.repeat(64), other = 'b'.repeat(64);
const link = (relay: string, c = channel) => ({ relay, channel: c });

describe('a pairing link', () => {
  it('names the relay and says when it replaces a working pairing', () => {
    expect(pairingQuestion(link('https://relay.example.com'), null)).toContain('relay.example.com');
    expect(pairingQuestion(link('https://relay.example.com'), null)).not.toContain('replaces');
    expect(pairingQuestion(link('https://relay.example.com'), link('https://augur.rpgm.tools', other))).toContain('replaces the desktop');
  });
  it('asks a scan question only when a working pairing would change', () => {
    expect(replacesPairing(link('https://r.example'), null)).toBe(false);
    expect(replacesPairing(link('https://r.example'), { relay: 'https://r.example', channel: '' })).toBe(false);
    expect(replacesPairing(link('https://r.example'), link('https://r.example'))).toBe(false);
    expect(replacesPairing(link('https://r.example'), link('https://r.example', other))).toBe(true);
    expect(replacesPairing(link('https://evil.example'), link('https://r.example'))).toBe(true);
  });
  it('is refused when the relay is plain http to a public host or carries a login', () => {
    const at = (r: string) => parsePairing(`#pair?r=${encodeURIComponent(r)}&c=${channel}&k=abc_-`);
    expect(at('https://relay.example.com')?.relay).toBe('https://relay.example.com');
    expect(at('http://192.168.1.5:8787')?.relay).toBe('http://192.168.1.5:8787');
    expect(at('http://relay.example.com')).toBeNull();
    expect(at('https://user:pw@relay.example.com')).toBeNull();
    expect(at('javascript:alert(1)')).toBeNull();
  });
});
