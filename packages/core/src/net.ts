// Where an API key may be sent. A key goes over https, or over plain http only to this computer or a machine on the home network.

/** True for localhost, a name with no dots (a machine on the home network), a private or link-local address, and the .local, .lan and .home.arpa suffixes. */
export function isHomeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || !h.includes('.') && !h.includes(':') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

/** Whether a key may be sent to this base URL: https anywhere, http only to a home host. */
export function keyMayGoTo(url: string): boolean {
  const m = url.trim().match(/^(https?):\/\/(\[[^\]]+\]|[^/:\s]+)(:\d+)?(\/.*)?$/);
  return !!m && (m[1] === 'https' || isHomeHost(m[2]!));
}
