# Augur, for agents working in this repository

Augur tracks AI usage across providers and, as a local service, picks and runs models for agents under rules its owner sets. The window app, the terminal app and the MCP server are views over one service, `augurd`.

## Where things live

| Path | What it is |
| --- | --- |
| `packages/core` | Provider plugins, the collector, pace, alerts, the rules (`policy.ts`) and history |
| `packages/dispatch-protocol` | What the service and its callers share: the pick (`pick.ts`), the balance (`balance.ts`), the report, adapter and route types |
| `packages/augurd` | The service: adapters that run models, the decision log, the supervisor |
| `packages/dispatch-cli` | The `augur` command |
| `packages/mcp` | The MCP server, `augur-mcp` |
| `packages/decision` | Task classification and the training rows for the local model |
| `apps/ui`, `apps/tui`, `apps/desktop` | The panel, the terminal app and the Tauri shell |
| `packaging/arch` | The Arch PKGBUILDs and their validation |

## Commands

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm docs:update   # rewrites the generated tables in docs/configuring.md
```

## What stays as it is

- A key goes only to its own provider. It is never written to `routes.json`, a job record, a log or the phone sync outside the encrypted update.
- Task text stays out of the decision log and out of `labels.jsonl` unless the owner has turned on recording for training. Text about students never leaves the computer for a hosted classifier.
- The balance only tilts scores. Pauses, ask-first, data tiers and weights apply first, and a model is never offered for data above the tier its rules allow.
- An edit that widens what data a model may see waits for the owner to accept it in the app, unless the owner has set the approval level to apply everything. The level is `agentApproval` in `config.json`, and no tool an agent can call reads or changes it.
- A run needs a pick for the same caller in the last hour, or a model named by its label.
- A shipped balance default changes only with a matching change to `packages/dispatch-protocol/test/fixtures/classic-balance.json` and a note in the changelog, since installs that name no profile resolve to it.

## Docs move with the code

Every change checks the docs it touches in the same change: the README, `docs/`, and `CONTRIBUTING.md`. A new balance setting has an entry in `BALANCE_FIELDS`, and a new adapter option has its entry in `ADAPTER_INFO`. The tables in `docs/configuring.md` are generated, and the test in `packages/dispatch-protocol/test/docs-parity.test.ts` fails when they differ from the code. The pull request says which docs changed.

## Where to start

[docs/adapting.md](docs/adapting.md) has the steps for adding a provider that needs code and a way to run a model. [docs/configuring.md](docs/configuring.md) covers the settings and files. `CONTRIBUTING.md` has the build steps. Changelog entries open with `[Visible]` or `[Internal]`, then a category (Providers, UI, Alerts, Sync, Platform, Security, Docs), under Added, Changed, Removed or Fixed.
