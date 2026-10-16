// `augur web`: where the web app is served and the links that open it. The web app is the same view of the engine the desktop panel is, shown in a
// browser on any device that can reach this computer. It is off until web.enabled is set.
import { isLoopbackHost, type WebSettings } from '@augur/augurd';

export const WEB_HELP = `augur web                               show whether the web app is on, and the links that open it (each carries the web token)
augur web rotate                        make a new web token; every browser signed in with the old one is asked for the new one`;

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
    say(`The web token was replaced. Every browser signed in with the old one is asked for the new one.\n${linksOf(deps.addresses(), token).join('\n')}`, { rotated: true, token });
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
    ? '\nThis address is on the network without TLS, so the token is readable by anyone who can see the traffic. Set web.tlsCert and web.tlsKey, or keep to a network you trust.'
    : '';
  say(`The web app is on, at ${settings.host}:${settings.port}. Open one of these in a browser:\n${links.join('\n')}${note}`, { enabled: true, host: settings.host, port: settings.port, tls: secure, links });
  return 0;
}

const linksOf = (addresses: string[], token: string): string[] => addresses.map(a => `${a}#token=${token}`);
