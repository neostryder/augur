// `augur web`: where the web app is served and the links that open it. The web app is the same view of the engine the desktop panel is, shown in a
// browser on any device that can reach this computer. It is off until web.enabled is set.
import { isLoopbackHost, type WebSettings } from '@augur/augurd';

export const WEB_HELP = `augur web                               show whether the web app is on, with a link for each address (each link carries the web token)
augur web rotate                        make a new web token; browsers that used the old one ask for the new one`;

export interface WebDeps {
  settings: Pick<WebSettings, 'enabled' | 'host' | 'port' | 'tlsCert' | 'tlsKey'>;
  /** The web token, made on first use. */
  token(): string;
  rotate(): string;
  addresses(): string[];
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
  const secure = !!(settings.tlsCert && settings.tlsKey);
  const note = !isLoopbackHost(settings.host) && !secure
    ? '\nThis address is open to the network over plain http, so anyone who can watch the traffic can read the token. Set web.tlsCert and web.tlsKey to serve https, or use it only on a network you trust.'
    : '';
  say(`The web app is on at ${settings.host}:${settings.port}. Open one of these links in a browser:\n${links.join('\n')}${note}`, { enabled: true, host: settings.host, port: settings.port, tls: secure, links });
  return 0;
}

const linksOf = (addresses: string[], token: string): string[] => addresses.map(a => `${a}#token=${token}`);
