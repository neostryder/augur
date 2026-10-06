# Contributing

Bug reports and pull requests are welcome. A security problem goes through [SECURITY.md](SECURITY.md), not a public issue.

## Setting up

Install Node 24 or newer and pnpm, plus stable Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. Then:

```bash
pnpm install
pnpm --filter @augur/desktop tauri dev
```

`pnpm --filter @augur/ui dev` runs the web app on its own. The relay needs `apps/relay/wrangler.example.toml` copied to `wrangler.toml` first, and then `pnpm --filter @augur/relay dev`.

## Where things live

| Path | What it is |
| --- | --- |
| `packages/core` | Provider plugins, the collector, pace, alerts and history, shared by every app |
| `packages/host-tauri` | The bridge from the web page to the desktop app's Rust commands |
| `apps/ui` | The panel and settings, used by both the desktop app and the web app |
| `apps/desktop` | The Tauri shell: tray, popup window, keychain, updater |
| `apps/relay` | The Cloudflare Worker that serves the web app and relays its requests |

The code that runs jobs for agents is in five packages. `packages/augurd` is the service, `packages/dispatch-protocol` holds what the service and its callers share, `packages/dispatch-cli` is the `augur` command, `packages/mcp` is the MCP server, and `packages/decision` classifies tasks. The local classifier model, Laya, and its trainer are in `packages/laya`. CI runs the workspace tests on Windows, Ubuntu and macOS, building the job host with Go first (`pnpm --filter @augur/augurd build:jobhost`). [AGENTS.md](AGENTS.md) and [docs/adapting.md](docs/adapting.md) describe how the packages fit together and what a change to each has to keep.

A provider with a JSON usage endpoint usually needs no code. Add it as a custom provider, as the README describes. A provider that has to refresh a sign-in or read a command-line login goes in `packages/core/src/providers`, with a fixture and a test in `packages/core/test`. Fixtures use made-up numbers.

## Before opening a pull request

Run these from the repository root:

```bash
pnpm -r typecheck
pnpm -r test
cd apps/desktop/src-tauri && cargo fmt --check && cargo check
```

If you changed Laya, also run `python -m unittest discover -s packages/laya/tests`.

Add a line under `[Unreleased]` in `CHANGELOG.md`. Start it with `[Visible]` when a user would notice the change and `[Internal]` when not, then the kind: Providers, UI, Alerts, Sync, Platform, Security or Docs.
