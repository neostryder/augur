// Where an API key may be sent. A key goes over https, or over plain http only to this computer or a machine on the home network.

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** True for a private, loopback or link-local IPv4 literal: four decimal octets in range, never a name that merely starts like one. */
function privateIPv4(h: string): boolean {
  if (!IPV4.test(h)) return false;
  const [a, b] = h.split('.').map(Number) as [number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
}

/** True for localhost, a name with no dots (a machine on the home network), a private or link-local address, and the .local, .lan and .home.arpa suffixes. */
export function isHomeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || /[\s@/\\]/.test(h)) return false;
  if (/^[\d.]+$/.test(h)) return privateIPv4(h);
  return h === 'localhost' || h === '::1' || !h.includes('.') && !h.includes(':') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa');
}

/** Whether a key may be sent to this base URL: https anywhere, http only to a home host. An address with a user name or password in it is refused, because the host that counts is the one after the at sign. */
export function keyMayGoTo(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return false; }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return !!parsed.hostname;
  return parsed.protocol === 'http:' && isHomeHost(parsed.hostname);
}
