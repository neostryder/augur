// `augur web`: where the web app is served and the links that open it. The web app is the same view of the engine the desktop panel is, shown in a
// browser on any device that can reach this computer. It is off until web.enabled is set.
import { isLoopbackHost, webTlsMode, type WebSettings } from '@augur/augurd';

export const WEB_HELP = `augur web                               show whether the web app is on, with a link for each address (each link carries the web token)
augur web rotate                        make a new web token; browsers that used the old one ask for the new one`;

export interface WebDeps {
  settings: Pick<WebSettings, 'enabled' | 'host' | 'port' | 'tlsCert' | 'tlsKey' | 'tlsAuto'>;
  /** The web token, made on first use. */
  token(): string;
  rotate(): string;
  addresses(): string[];
  /** SHA-256 fingerprint of the self-signed certificate the service made, or null before its first https start. */
  fingerprint?(): string | null;
}

export function webCmd(rest: string[], say: (human: string, data: unknown) => void, deps: WebDeps, err: (text: string) => void): number {
  const [sub] = rest;
  if (sub !== undefined && sub !== 'rotate') { err(`${WEB_HELP}\n`); return 2; }
  if (sub === 'rotate') {
    const token = deps.rotate();
    say(`Augur made a new web token. Every browser that used the old one now asks for the new one.\n${linksOf(deps.addresses(), token).join('\n')}`, { rotated: true, token });
    return 0;
  }
  const { settings } = deps;
  if (!settings.enabled) {
    say('The web app is off. Turn it on with "augur config set web.enabled true", then restart the service.', { enabled: false });
    return 0;
  }
  const token = deps.token(), links = linksOf(deps.addresses(), token);
  const mode = webTlsMode(settings), auto = mode === 'auto', secure = mode !== 'none';
  const note = !isLoopbackHost(settings.host) && !secure
    ? '\nThe web app is open to the network over plain http because web.tlsAuto is off, so anyone who can watch the traffic can read the token. Set web.tlsAuto to auto or on to serve https, or set web.tlsCert and web.tlsKey to your own certificate, then restart the service.'
    : '';
  const print = auto ? deps.fingerprint?.() ?? null : null;
  const trust = auto
    ? print
      ? `\nThe certificate is self-signed, so each browser warns about it once. Before you continue past the warning, check that the SHA-256 fingerprint it shows matches this one:\n${print}`
      : '\nThe service makes the certificate the next time it starts. Restart it with augur service stop and augur service start, then run augur web again to see the fingerprint to check.'
    : '';
  say(`The web app is on at ${settings.host}:${settings.port}. Open one of these links in a browser:\n${links.join('\n')}${note}${trust}`, { enabled: true, host: settings.host, port: settings.port, tls: secure, links, ...(print ? { fingerprint: print } : {}) });
  return 0;
}

const linksOf = (addresses: string[], token: string): string[] => addresses.map(a => `${a}#token=${token}`);
