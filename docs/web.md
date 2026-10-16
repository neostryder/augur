# The web app on your own computer

The Augur service can serve the app the desktop panel shows to a browser on any device that can reach your computer, such as a laptop in another room or a phone on your home network. The page shows the service's usage engine the same way the terminal app does. It reads no provider itself and holds no provider login, and a change made on the page shows in the window app and the terminal app at once.

## How it differs from the phone relay

The phone app at augur.rpgm.tools works through a relay. Your computer encrypts each update and pushes it to the relay, and the phone fetches it from there, so the phone works from anywhere and your computer only needs to come online now and then.

The web app has no server in between. The browser connects to your computer itself, the way it would to any service you host at home. Your computer has to be on with the service running, and the browser has to be able to reach it: on the same network, over a VPN, or through a tunnel you set up. Nothing about the web app goes through the relay or any other outside server. Who can reach that address depends on your network, and keeping it closed to strangers is up to you.

## Turning it on

The web app is off until you turn it on, and nothing listens on a port before that:

```bash
augur config set web.enabled true
augur service stop
augur service start
augur web
```

`augur web` says whether the web app is on and prints a link for each address it listens on. Every link ends in `#token=` followed by the web token. Open a link once in each browser you use. The page saves the token in that browser and removes it from the address bar, so it does not stay in the history. A page opened without a token asks for one, and `augur web` prints it again.

## Settings

Each setting can be changed with `augur config set <setting> <value>` or on the Service page, and the service reads it the next time it starts.

| Setting | Default | What it does |
| --- | --- | --- |
| `web.enabled` | `false` | Serves the web app from the service. |
| `web.host` | `127.0.0.1` | The address to listen on. The default lets only this computer in. `0.0.0.0` listens on every network address this computer has, and an address of its own listens on that one. |
| `web.port` | `7420` | The port to listen on. |
| `web.allowedHosts` | none | Extra host names the page may be opened by, separated by commas, such as a DNS name or a tunnel address that points here. |
| `web.tlsCert` | none | Path of a PEM certificate chain. |
| `web.tlsKey` | none | Path of the PEM private key for `web.tlsCert`. With both set, the web app uses https. |

The service checks the host name in every request. On the default `127.0.0.1` it answers only `localhost`, a loopback address, and the names in `web.allowedHosts`. On a network address it also answers any numeric IP address, this computer's own host name, that name with `.local` added, and the value of `web.host`. A request that names any other host is refused, so add the name of a tunnel or a reverse proxy to `web.allowedHosts` before you open the page through it.

## The web token

The token is in a file named `web-token` in the service's data folder (`%LOCALAPPDATA%\Augur\dispatch` on Windows, `~/.local/share/augur/dispatch` on macOS and Linux), readable by your account only. It is separate from the owner token the terminal app uses and the agent token the MCP server uses, so it can be changed without touching either.

The web token carries the owner's reach. Whoever holds it can do anything the window app's panel does: change settings and rules, save or remove provider keys, pair or unpair a phone, and sign Augur in to Claude or Codex. Treat it like a password.

`augur web rotate` makes a new token and prints new links. Every browser that saved the old token is asked for the new one, and a page left open stops getting updates within about 20 seconds.

## Plain http and https

Without `web.tlsCert` and `web.tlsKey` the web app uses plain http. That is fine on `127.0.0.1`. On a network address the token crosses the network unencrypted, and anyone who can watch that traffic can read it. The service writes a warning to its log when it starts that way, and `augur web` prints the same warning. Set both TLS settings, reach the page through a VPN or a tunnel that encrypts the traffic, or keep to a network you trust.

## What the service checks

- The token travels in the Authorization header of each request and never in an address. The `#token=` part of a link stays in the browser and is not sent to the service.
- The service compares the token in constant time and checks it again on every request and every 20-second keepalive.
- More than 10 wrong tokens from one address within a minute shut that address out until the minute is up.
- A request whose Host header is not on the list above is refused, which stops a page on someone else's DNS name from reaching the service through your browser.
- A request from a page on another origin is refused, and commands are accepted only as JSON.
- The page can run only the commands the window app's panel uses. The job commands that agents use are not among them.
- A request body larger than 8 MB is refused.
- Every answer carries a content security policy and headers that keep the page out of frames, and API answers are never cached.

## What the page cannot do

Signing in to claude.ai for limit resets and to the TypeSafe console for the Jev balance needs the window app, as it does in the terminal app. Augur's own sign-in to Claude and Codex works from the page, so a computer with no browser can be signed in from a phone. See [Signing in to Claude and Codex](../README.md#signing-in-to-claude-and-codex).

## Building it in

The service serves the app from a `web` folder beside its own files. The service build copies the app there when the app has been built first:

```bash
pnpm --filter @augur/ui build
pnpm build:service
```

A service with no `web` folder still starts, logs a warning, and answers 404 at the web address. `AUGURD_WEB_DIR` points the service at a different folder that holds a built app.
