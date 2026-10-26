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
| `web.tlsKey` | none | Path of the PEM private key for `web.tlsCert`. With both set, the web app uses https with your certificate, whatever `web.tlsAuto` says. |
| `web.tlsAuto` | `auto` | When to serve https with a self-signed certificate the service makes and keeps: `auto` on a network address only, `on` on every address, `off` never. Ignored when `web.tlsCert` and `web.tlsKey` are both set. See [Self-signed https with web.tlsAuto](#self-signed-https-with-webtlsauto). |

The service checks the host name in every request. On the default `127.0.0.1` it answers only `localhost`, a loopback address, and the names in `web.allowedHosts`. On a network address it also answers any numeric IP address, this computer's own host name, that name with `.local` added, and the value of `web.host`. A request that names any other host is refused, so add the name of a tunnel or a reverse proxy to `web.allowedHosts` before you open the page through it.

## The web token

The token is in a file named `web-token` in the service's data folder (`%LOCALAPPDATA%\Augur\dispatch` on Windows, `~/.local/share/augur/dispatch` on macOS and Linux), readable by your account only. It is separate from the owner token the terminal app uses and the agent token the MCP server uses, so it can be changed without touching either.

The web token carries the owner's reach. Whoever holds it can do anything the window app's panel does: change settings and rules, save or remove provider keys, pair or unpair a phone, and sign Augur in to Codex. Treat it like a password.

`augur web rotate` makes a new token and prints new links. Every browser that saved the old token is asked for the new one, and a page left open stops getting updates within about 20 seconds.

## Plain http and https

The web app uses https whenever `web.tlsCert` and `web.tlsKey` are both set. Without them, `web.tlsAuto` decides. At its default, `auto`, the service serves https with a self-signed certificate it makes when `web.host` is a network address, and plain http on `127.0.0.1`, `::1`, and `localhost`, where the traffic never leaves this computer. `on` serves https on those addresses too, and `off` keeps plain http everywhere.

With `web.tlsAuto` set to `off` on a network address, the token crosses the network unencrypted, and anyone who can watch that traffic can read it. The service writes a warning to its log when it starts that way, and `augur web` prints the same warning.

The self-signed certificate needs no files or other tools, and each browser warns about it the first time it opens the page, as [Self-signed https with web.tlsAuto](#self-signed-https-with-webtlsauto) describes. A certificate from a real authority shows no warning. A [reverse proxy](#serving-it-over-https-with-a-reverse-proxy) that holds one is the recommended way to open the page to a network, and `web.tlsCert` and `web.tlsKey` can point at one without a proxy.

## Self-signed https with web.tlsAuto

With `web.tlsAuto` at its default, `auto`, the service makes its own certificate the first time it starts on a network address and serves the web app over https with it. Nothing else needs installing, and there are no certificate files to manage, so opening the app to your network takes only the address:

```bash
augur config set web.host 0.0.0.0
augur service stop
augur service start
augur web
```

The links `augur web` prints then start with `https://`. Set `web.tlsAuto` to `on` to use the certificate on `127.0.0.1` as well. Until the service has started once with https on, `augur web` says the certificate is made at the next start. The setting is ignored when `web.tlsCert` and `web.tlsKey` are both set.

A service that already listened on a network address over plain http switches to https when it is updated from an earlier version. Its old `http://` links and bookmarks stop working, so run `augur web` for the new ones. Set `web.tlsAuto` to `off` to keep plain http.

The certificate covers these names and addresses:

- `localhost`, `127.0.0.1`, and `::1`
- this computer's host name, and that name with `.local` added
- the `web.host` address, when it names a single address
- every IPv4 address this computer has on its networks, when `web.host` is `0.0.0.0` or `::`
- every name in `web.allowedHosts`

The certificate and its key are in a `web-cert` folder in the service's data folder, as `cert.pem` and `key.pem`, and only your account can read the key. It is an ECDSA P-256 certificate valid for two years. When the service starts, it makes a new one if the current one has less than 30 days left, if the key no longer matches it, or if a name it needs is missing. A new network address or a new `web.allowedHosts` entry is therefore covered after the next restart. Every new certificate brings the browser warning back.

No certificate authority signed this certificate, so each browser on each device warns about it the first time it opens the page. The service writes the certificate's SHA-256 fingerprint to its log when it starts, and `augur web` prints it. Before you continue past the warning, open the certificate details the browser offers and check that the SHA-256 fingerprint there matches. Once the page is open over https, the token is encrypted on its way across the network.

That encryption keeps the token from anyone who can only watch the traffic. It does not stop someone who can intercept the very first connection and present a certificate of their own, unless you compare the fingerprint before you continue. A certificate from a real authority, set in `web.tlsCert` and `web.tlsKey` or held by a [reverse proxy](#serving-it-over-https-with-a-reverse-proxy), shows no warning and needs no fingerprint check.

## Serving it over https with a reverse proxy

The recommended way to get https is to put a reverse proxy that holds the certificate in front of the service. The service keeps listening on `127.0.0.1:7420` over plain http, which is fine on loopback, and only the proxy faces the network. Augur does not install or manage the proxy, and it does not depend on one.

The proxy needs three things from its configuration:

- Its public name goes in `web.allowedHosts`. Otherwise the service refuses the request with 421.
- It passes the original `Host` header through. The service refuses a request whose `Origin` does not match its `Host`.
- It does not buffer the response of `/api/watch`, and its read timeout is longer than 20 seconds. That path streams updates and sends a keepalive line every 20 seconds.

Every request reaches the service from the proxy's address. The lockout after 10 wrong tokens in a minute therefore applies to everyone behind the proxy at once.

With Caddy, a public DNS name gets a certificate automatically. A name that only your local network resolves needs Caddy's DNS challenge or its internal CA, which Caddy's documentation covers.

```
augur.example.net {
    reverse_proxy 127.0.0.1:7420 {
        flush_interval -1
    }
}
```

With nginx, replace the two certificate paths with your own.

```
server {
    listen 443 ssl;
    server_name augur.example.net;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:7420;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Once the proxy is running, add its name and restart the service:

```bash
augur config set web.allowedHosts augur.example.net
augur service stop
augur service start
```

Then open `https://augur.example.net/#token=...` with the token from `augur web`. The links `augur web` prints use the service's own address, so replace the address part with the proxy's name.

These examples are starting points, because proxies differ. Tailscale's `tailscale serve` is another route that needs no certificate handling.

## Running jobs from another app

Another program on this computer can pick models and run jobs by posting JSON to `/api/dispatch` at the web app's address. This is the same dispatch service the `augur` command and the MCP server reach through the service's pipe. It needs the web app turned on and the web token.

```bash
curl http://127.0.0.1:7420/api/dispatch \
  -H "Authorization: Bearer <web token>" \
  -H "Content-Type: application/json" \
  -d '{"method": "pick", "params": {"activity": "summarize_extract", "dataTier": "internal", "session": "my-app"}}'
```

The body names a `method` and passes its `params`. Send it as `application/json`, since any other content type gets a 415. A call that runs comes back with status 200 and `{ "result": ... }`, and the result is `null` when there is nothing to return. Anything the service cannot run comes back with status 400 and `{ "error": "..." }`: a body that is not JSON, a missing method, a method outside the table below, or a call that fails. A missing or wrong token gets a 401, and after too many wrong tokens the address gets a 429 for the rest of the minute. Use POST, because every other HTTP method gets a 405. The body can be up to 8 MB, and a larger one gets a 413.

Only this computer gets in. A connection from anywhere but a loopback address gets a 403. So does a request with a `Forwarded`, `X-Forwarded-For`, or `X-Real-IP` header, because a reverse proxy on this computer connects from loopback on a remote client's behalf. Loopback works with the default `web.host` of `127.0.0.1`, and with `0.0.0.0` or `::`. If `web.host` names one network address, there is no loopback address left to call.

If the service serves https on loopback, use an `https://` address. That happens when `web.tlsAuto` is `on` or your own certificate is set. Give curl `--cacert` with the path of `cert.pem` in the `web-cert` folder and it trusts the service's own certificate.

| Method | Params | Result |
| --- | --- | --- |
| `pick` | `activity` and `dataTier`, or `task`; `session` | The ranked models, their odds and routes, and the pick, recorded for that session. |
| `submit` | A job request, described below | `{ id, warnings }` for a queued job, or `{ rejected: { code, reason } }` when the rules refuse it. |
| `status` | `id` | The job's record, or `null` when there is no such job. |
| `result` | `id` | `{ job, answer }`, with the answer `null` until the job has one. |
| `events` | `id`; optional `since` | The job's events in order, each with a `seq` number. Only events after `since` are returned. |
| `logs` | `id`; optional `stream` (`stdout` or `stderr`), `offset`, `limit` | `{ text, next, done }`, read from `offset`. |
| `list` | optional `state`, `root`, `limit` | Recent job records. |
| `cancel` | `id` | `{ ok, state }`, or `null` when there is no such job. |
| `routes` | none | Each route with its model, adapter, any reason it cannot run, and what it can take. |

`submit` takes the job request the `augur` command builds. It needs `route`, `activity`, `dataTier`, `tools` (`read`, `write` or `full`), `output` (`text_only`, `patch_only` or `write_files`), and `cwd`, which must be an existing absolute folder. The prompt goes in `prompt` as `{ "text": "..." }` or `{ "file": "..." }`. Give a `caller` as well, for example `{ "kind": "other", "label": "my-app", "session": "my-app" }`. The optional fields are `attach`, `timeoutS`, `packs`, `noCharter`, `conversation`, `urgent`, and `failover`. Attachments are file paths, never file contents. Each path has to sit inside `cwd` or a folder listed in `promptRoots`, just as on the command line, and the service reads the file itself.

Calls here run with an agent's reach, the same as the MCP server's, even though the web token can do more elsewhere. The service drops `named`, `allow`, and the caller's `interactive` flag, so a job runs only on a model picked for the same session within the last hour. Pass the same string as `session` to `pick` and as `caller.session` to `submit`. Methods outside the table are refused, so nothing sent here can change the rules or add a route. Jobs also need "Also run jobs" turned on in Augur's settings. Until it is, `submit` comes back refused with `jobs_off`.

## What the service checks

- The token travels in the Authorization header of each request and never in an address. The `#token=` part of a link stays in the browser and is not sent to the service.
- The service compares the token in constant time and checks it again on every request and every 20-second keepalive.
- More than 10 wrong tokens from one address within a minute shut that address out until the minute is up.
- A request whose Host header is not on the list above is refused, which stops a page on someone else's DNS name from reaching the service through your browser.
- A request from a page on another origin is refused, and commands are accepted only as JSON.
- The page can run only the commands the window app's panel uses. The job commands that agents use are served only at `/api/dispatch`, which answers loopback connections alone.
- A request body larger than 8 MB is refused.
- Every answer carries a content security policy and headers that keep the page out of frames, and API answers are never cached.

## What the page cannot do

Signing in to claude.ai for limit resets and to the TypeSafe console for the Jev balance needs the window app, as it does in the terminal app. Augur's own Claude and Codex sign-ins work from the page, so a computer with no browser can be signed in from a phone. See [Signing in to Claude and Codex](../README.md#signing-in-to-claude-and-codex).

## Building it in

The service serves the app from a `web` folder beside its own files. The service build copies the app there when the app has been built first:

```bash
pnpm --filter @augur/ui build
pnpm build:service
```

A service with no `web` folder still starts, logs a warning, and answers 404 at the web address. `AUGURD_WEB_DIR` points the service at a different folder that holds a built app.
