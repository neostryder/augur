# Augur, for agents working in this repository

Augur tracks AI usage across providers. It also runs as a local service, `augurd`, that picks and runs models for agents under rules the owner sets. The window app, the terminal app and the MCP server are all views of that one service.

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

## What every change keeps

- A key goes only to its own provider. It is never written to `routes.json`, a job record or a log, and it reaches the phone sync only inside the encrypted update.
- Task text stays out of the decision log and `labels.jsonl` unless the owner has turned on recording for training. Text about students never leaves the computer for a hosted classifier.
- The balance only tilts scores. Pauses, ask-first, data tiers and weights apply before it, and a model is never offered for data above the tier its rules allow.
- An edit that widens what data a model may see waits for the owner to accept it in the app, unless the owner has set the approval level to apply everything. That level is `agentApproval` in `config.json`, and no tool an agent can call reads or changes it.
- A run needs a pick for the same caller in the last hour, or a model named by its label.
- Installs that name no profile resolve to the shipped balance defaults, so a change to a default needs a matching change to `packages/dispatch-protocol/test/fixtures/classic-balance.json` and a changelog note.

## Docs move with the code

A change updates the docs it touches in the same pull request: the README, `docs/` and `CONTRIBUTING.md`. A new balance setting needs an entry in `BALANCE_FIELDS`, and a new adapter option needs one in `ADAPTER_INFO`. The tables in `docs/configuring.md` are generated from those, and `packages/dispatch-protocol/test/docs-parity.test.ts` fails when the tables and the code differ. The pull request names the docs it changed.

## Where to start

[docs/adapting.md](docs/adapting.md) has the steps for adding a provider that needs code and for adding a way to run a model. [docs/configuring.md](docs/configuring.md) covers the settings and files, and `CONTRIBUTING.md` has the build steps. A changelog entry goes under Added, Changed, Removed or Fixed, and opens with `[Visible]` or `[Internal]` followed by a category: Providers, UI, Alerts, Sync, Platform, Security or Docs.
