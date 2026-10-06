# Adapting Augur

Most changes need no code: a provider with a JSON usage endpoint is a custom provider, a stack of different models is a set of routes and balance settings, and [Configuring Augur](configuring.md) covers both. This page covers the changes that do need code, and the checks each one has to pass.

## A provider that needs code

A custom provider reads usage from a JSON endpoint. A provider that has to refresh a sign-in, read a command-line login or parse something other than JSON is a plugin: one file in `packages/core/src/providers` that exports a `ProviderPlugin`.

1. Give it an `id`, a `name`, `links` and the `fields` its settings screen needs. Set `needsLocalLogin` when it reads a login that exists only on this computer.
2. Write `fetch(host, settings)`, which returns the meters and money balances. Go through `host` for every request and file read, since the host differs between the desktop app, the service and the phone app.
3. Add `listModels(host, settings)` if the provider lists its models. Set `modelListMode` to `catalog` when the list is a marketplace with hundreds of entries, and `labelPrefix` when the first part of a route label should differ from the id (Grok uses `xai`).
4. Add it to `builtinProviders` in `packages/core/src/providers/index.ts`.
5. Add a fixture with made-up numbers and a test in `packages/core/test`. Run `pnpm --filter @augur/core test`.

## A way to run a model

An adapter runs a model for `augur run`: it checks a route's options, builds the command or request, and reads the answer and usage back. The adapters are in `packages/augurd/src/adapters`, and `codex-exec.ts` is the shortest to copy.

1. Implement `Adapter` from `@augur/dispatch-protocol`: `validate`, `plan` and `extract`, plus `version` and `isolation` where they apply.
2. Add it to `ALL_ADAPTERS` in `packages/augurd/src/adapters/index.ts`.
3. Add its entry to `ADAPTER_INFO` in `packages/dispatch-protocol/src/adapter-info.ts`. The Routes page draws its form from that entry, and a test checks that each required option is one the adapter refuses to run without.
4. Run the conformance tests in `packages/augurd/test`, then update the generated table in [Configuring Augur](configuring.md) with `pnpm docs:update`.

An adapter that should stay on one computer goes in `local-adapters.mjs` beside the installed service, or in `packages/augurd/src/adapters/private/index.ts` in a checkout. It runs only when the service's `config.json` lists its id.

## The checks

Run these from the repository root before opening a pull request:

```bash
pnpm -r typecheck
pnpm -r test
```

A new balance setting needs an entry in `BALANCE_FIELDS` in `packages/dispatch-protocol/src/config-reference.ts`, and `pnpm docs:update` rewrites the tables in [Configuring Augur](configuring.md). The test that compares them fails until both are done. Changing a shipped balance default also fails the classic-defaults test, which keeps an existing install resolving to the same rules.
