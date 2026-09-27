# Contributing

Bug reports and pull requests are welcome. For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setting up

You need Node 24 or newer, pnpm, and stable Rust with the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
pnpm install
pnpm --filter @augur/desktop tauri dev
```

The web app alone runs with `pnpm --filter @augur/ui dev`, and the relay with `pnpm --filter @augur/relay dev` after copying `apps/relay/wrangler.example.toml` to `wrangler.toml`.

## Where things live

| Path | What it is |
| --- | --- |
| `packages/core` | Provider plugins, the collector, pace, alerts and history, shared by every app |
| `packages/host-tauri` | The bridge from the web page to the desktop app's Rust commands |
| `apps/ui` | The panel and settings, used by both the desktop app and the web app |
| `apps/desktop` | The Tauri shell: tray, popup window, keychain, updater |
| `apps/relay` | The Cloudflare Worker that serves the web app and relays its requests |

A new provider with a JSON usage endpoint usually needs no code: describe it as a custom provider (see the README). One that needs a sign-in refresh or a command-line login goes in `packages/core/src/providers`, with a fixture and a test in `packages/core/test`. Fixtures use made-up numbers.

## Before opening a pull request

```bash
pnpm --filter @augur/core test
pnpm --filter @augur/ui typecheck
pnpm --filter @augur/relay typecheck
cd apps/desktop/src-tauri && cargo fmt --check && cargo check
```

Add a line for your change under `[Unreleased]` in `CHANGELOG.md`, starting with `[Visible]` if a user would notice it or `[Internal]` if not, then the kind of change (Providers, UI, Alerts, Sync, Platform, Security or Docs).
