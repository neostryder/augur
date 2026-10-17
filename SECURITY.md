# Security

## Reporting a problem

Please report security problems privately through GitHub's [private vulnerability reporting](https://github.com/neostryder/augur/security/advisories/new) rather than in a public issue. Include what you found, how to reproduce it, and which version you tested. You should hear back within a week.

## What Augur holds

- **API keys** you enter in the desktop app are stored in the operating system's keychain (Windows Credential Manager, the macOS Keychain, or the Secret Service on Linux). On Windows they are saved for this computer only, so they do not travel with a roaming profile; a key saved by an older version keeps its old setting until it is saved again. In the hosted web app they are encrypted with a key that the browser keeps and cannot export.
- **Sign-ins for Claude, Codex, and Grok** are never copied. Augur reads the login files those apps already keep on your computer and renews them the same way the apps do. When the service writes a renewed login back, the file is readable by your account only on macOS and Linux.
- **Augur's own sessions**, from `augur login` or the Sign-in block in settings, save only the refresh token, in the same key store as your API keys. Access tokens stay in memory. Codex is the only provider with a sign-in built in, and a provider that a `local-signin.mjs` file adds is stored the same way. The service runs that file as code under your account when it starts, so put only a file you wrote or have read there. While Augur has its own session, it doesn't read or renew the provider CLI's login. `augur logout` removes only Augur's session, and signing in or out takes the owner's token.
- **The TypeSafe console session** lives in the desktop app's own browser profile, and is used only to read your billing page.
- **Phone sync** is encrypted on your computer with a key that only your paired phone holds. Unless you turn off Send API keys to the phone, it also carries the API keys for providers the phone can read itself, so the phone can refresh them. The relay stores that ciphertext for up to 14 days and cannot read it. The phone's refresh button also leaves the time of the tap on the relay for an hour, so the desktop knows to read your providers again. Nothing else goes with it.
- **Sync updates** are tied to their pairing, so the relay cannot move one pairing's data to another, and the phone ignores an update older than the last one it applied. A desktop whose clock moves backwards therefore sends updates the phone ignores until the clock passes the time of the last one. A pairing link opened in the phone's browser names its relay and asks before it is used, a scanned code asks before it replaces a working pairing, and only a relay on https or on your home network is accepted. Unpairing deletes the sync keys and the desktop's push notification key, so a push subscription the phone still holds stops working.

## The hosted relay

The relay at augur.rpgm.tools forwards requests from the web app to a fixed list of usage and status endpoints. Its code stores and logs none of them, though Cloudflare, which runs it, keeps its own request logs. It passes your API key through to the provider in the request you make, the same as a direct call. If you would rather not use it, deploy your own copy from `apps/relay` and enter its address in settings.

## The dispatch service

The dispatch service, `augurd`, is a separate program from the desktop app and runs only once you set it up. It keeps a record of each job in a SQLite database in your user profile, and the job's output and results in a folder there for 30 days by default. A prompt is held only until its job starts. It is not stored unless you turn that on. Each job's process receives only the environment variables its adapter names, not the rest of the service's environment.

The service listens on a named pipe. Windows lets any local account open that pipe for reading but not for writing, and every request also has to carry a token kept in a file in your profile, so another account cannot send it commands. Job records, prompts and job output never go to the relay or the phone.

The service keeps two tokens in your profile. The owner's token is for the terminal app, the window app, and hooks. The MCP server uses a separate agent token that can run jobs, read their results, and add routes, and cannot record a person's word: it cannot say a person is at the terminal or named a model, waive the pick or usage checks, answer a pick, label a grade, or change the app's settings. Another program that runs as you can read both files, so the two tokens keep honest tools in their roles. They do not wall off a hostile program that already runs as your account. The web app has a third token of its own, described below.

On Windows a job starts only through the job host, jobhost.exe, which puts the job and every process it starts in one Job Object, so cancelling or timing out the job ends them all. Without the host the service will not start jobs. On Linux where systemd runs, a job runs in a systemd user scope, which does the same. Elsewhere the service ends the job's process group and every process it saw descend from the job, matched by process id and start time so a reused id is left alone. It looks for those processes about once a second, so a process that starts and detaches between two looks can outlive a cancel or a time limit. A prompt file has to be inside the job's working folder or a folder in promptRoots; the CLI reads its own prompt file and sends the text. An API route sends its key over https only, or over http to localhost.

Hermes, Copilot and short OpenCode prompts travel as command-line arguments, and Grok and long OpenCode prompts go through a file, so a prompt can be visible in the process list or on disk while its job runs. The service deletes those files when the job ends and blanks the prompt in its own record of the job.

The key for an API connector comes from the environment variable its route names, or from the Windows credential store when the route keeps it there. The API caller reads a stored key when the job starts, and the service only asks whether one exists. Neither kind is written to the job's files. Sandboxed harnesses work on a copy of the working folder and hand back a patch, so your folder stays as it is until you run `augur apply`.

When a caller says a person named a model, the service checks that model against the messages it was told a person sent. It keeps the model names from those messages and drops their text. A program running as you could fake that list, so an unconfirmed claim is refused by default. Set verifyNamed to record to accept and note it, or off to accept it silently.

A job that skips the pick or usage check says so in its record.

The MCP server, `augur-mcp`, is a client of the same service. It sends its own random session id with each call, never asks the service to skip the pick or usage check, and never says a person named a model, so an agent using it is held to the rules like any other caller. It holds no keys of its own.

Rules apply to jobs started through the service. A harness started directly from a shell is outside it.

## The web app served by the service

The service serves the web app only when `web.enabled` is on, and it listens on `127.0.0.1` unless `web.host` names another address. A browser that opens it connects to your computer directly, and nothing goes through the relay. Making that address reachable from other devices, and deciding who can reach it, is part of your own network setup.

Every request needs the web token, kept in a `web-token` file in the service's data folder that only your account can read, apart from the owner and agent tokens. The browser keeps it in the page's local storage. The web token has the owner's reach over everything the panel does: it can change settings and rules, save or delete provider keys, pair a phone and send it those keys, and sign Augur in to providers. The page reaches only the usage engine's commands, not the job commands agents use.

The token travels in the Authorization header and never in an address, and the service compares it in constant time. More than 10 wrong tokens from one address within a minute lock that address out until the minute is up. A request must name this computer or a host in `web.allowedHosts`, which blocks DNS rebinding, and cross-origin requests are refused. Request bodies are capped at 8 MB, every answer carries a content security policy and frame protection, and API answers are marked no-store. The token is read again on every request, so `augur web rotate` cuts off every open page at its next keepalive, within about 20 seconds.

Over plain http on a network address the token crosses the network unencrypted, and anyone who can watch that traffic can read it and act as you. The service logs a warning when it starts that way. Set `web.tlsCert` and `web.tlsKey`, reach the page through a VPN or a tunnel that encrypts it, or keep to a network you trust. Anyone with access to a browser profile that opened the page can read the saved token, so rotate it when a device that held it is lost.

## Supported versions

Only the latest release receives fixes. The desktop app updates itself unless you turn that off.
