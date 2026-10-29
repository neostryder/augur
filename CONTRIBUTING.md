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

The code that runs jobs for agents is in five packages. `packages/augurd` is the service, `packages/dispatch-protocol` holds what the service and its callers share, `packages/dispatch-cli` is the `augur` command, `packages/mcp` is the MCP server, and `packages/decision` classifies tasks. The prose request queue is `packages/augurd/src/prose-queue.ts`, with its `augur prose` commands in `packages/dispatch-cli` and its `augur_prose_add`, `augur_prose_list`, and `augur_prose_status` tools in `packages/mcp`. Model series are matched in `packages/core/src/aliases.ts` and refreshed, checked and settled in `packages/augurd/src/alias-files.ts`, with the provider listings in `alias-listings.ts` and the pin check in `alias-pins.ts` beside it. The local classifier model, Laya, and its trainer are in `packages/laya`. CI runs the workspace tests on Windows, Ubuntu and macOS, and on Windows it builds the job host with Go first (`pnpm --filter @augur/augurd build:jobhost`). [AGENTS.md](AGENTS.md) and [docs/adapting.md](docs/adapting.md) explain how the packages fit together and the rules a change to each one must keep.

The premium gate and the surplus window are worked out in `packages/dispatch-protocol` (`gateEvaluate`, `surplusEvaluate` and `paceGap` in `pick.ts`, the `gate` settings in `balance.ts`), so their tests there are pure. The service side is in `packages/augurd`: `supervisor.ts` keeps `gate-state.json` and runs the backlog release, `balance-files.ts` writes the gate ledger, and `premium-backlog.ts` holds the backlog store with its lock in `file-lock.ts`. Those tests use the harness in `packages/augurd/test/harness.ts`, a temporary data folder with written `policy.json`, `usage.json` and `routes.json` and a fake harness script in place of a provider, so a window opens from a usage reading the test writes.

A provider with a JSON usage endpoint usually needs no code. Add it as a custom provider, as the README describes. A provider that has to refresh a sign-in or read a command-line login goes in `packages/core/src/providers`, with a fixture and a test in `packages/core/test`. Fixtures use made-up numbers.

## Before opening a pull request

Run these from the repository root:

```bash
pnpm -r typecheck
pnpm -r test
cd apps/desktop/src-tauri && cargo fmt --check && cargo check
```

The prose queue's tests are in `packages/augurd/test/prose-queue.test.ts`, and `pnpm --filter @augur/augurd test -- prose-queue` runs only those.

The alias tests in `packages/augurd/test/alias-*.test.ts` and `packages/core/test/aliases.test.ts` use fake listings and a fake smoke job in temporary folders, so they never reach the network, run a model, or touch the real `~/.augur`. New alias tests keep to that.

The Cogitator catalog lives in `packages/core/src/cogitator-catalog.ts`, and `readCogitatorKnowledge` isolates the management metadata shape. Its tests in `packages/core/test/cogitator-catalog.test.ts` use fake fleet replies; the pick tests are in `packages/dispatch-protocol/test/fleet-pick.test.ts`, and owner acceptance tests are in `packages/augurd/test/route-add.test.ts`. Catalog changes keep explicit activity blocks, review status, data clearance, and the compact phone reading intact. The CLI and MCP tests cover descriptions and offers without reaching a gateway.

If you changed Laya, also run `python -m unittest discover -s packages/laya/tests`.

Add a line under `[Unreleased]` in `CHANGELOG.md`. Start it with `[Visible]` when a user would notice the change and `[Internal]` when not, then the kind: Providers, UI, Alerts, Sync, Platform, Security or Docs.
