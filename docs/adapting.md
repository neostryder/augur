# Adapting Augur

Most changes need no code. A provider with a JSON usage endpoint can be added as a custom provider, and a different stack of models is a set of routes and balance settings; [Configuring Augur](configuring.md) covers both. This page is for the changes that need code, and the checks each one has to pass.

## A provider that needs code

A provider that has to refresh a sign-in, read a command-line login or parse something other than JSON is a plugin: one file in `packages/core/src/providers` that exports a `ProviderPlugin`.

1. Give it an `id`, a `name`, `links` and the `fields` its settings screen needs. Set `needsLocalLogin` when it reads a login that exists only on this computer.
2. Write `fetch(host, settings)`, which returns the meters and money balances. Make every request and file read through `host`, because the host is different in the desktop app, the service and the phone app.
3. If the provider lists its models, add `listModels(host, settings)`. Set `modelListMode` to `catalog` when the list is a marketplace with hundreds of entries, and set `labelPrefix` when route labels should start with something other than the id (Grok uses `xai`).
4. Add it to `builtinProviders` in `packages/core/src/providers/index.ts`.
5. Add a fixture with made-up numbers and a test in `packages/core/test`, then run `pnpm --filter @augur/core test`.

## A way to run a model

An adapter runs a model for `augur run`. It checks a route's options, builds the command or request, and reads the answer and the usage back. The adapters are in `packages/augurd/src/adapters`, and `codex-exec.ts` is the shortest one to copy.

1. Implement `Adapter` from `@augur/dispatch-protocol`: `validate`, `plan` and `extract`, plus `version` and `isolation` where they apply.
2. Add it to `ALL_ADAPTERS` in `packages/augurd/src/adapters/index.ts`.
3. Add its entry to `ADAPTER_INFO` in `packages/dispatch-protocol/src/adapter-info.ts`. The Routes page builds the adapter's form from that entry, and a test checks that the adapter refuses to run without each option the entry marks as required.
4. Run the conformance tests in `packages/augurd/test`, then run `pnpm docs:update` to refresh the generated table in [Configuring Augur](configuring.md).

To keep an adapter on one computer, put it in `local-adapters.mjs` beside the installed service, or in `packages/augurd/src/adapters/private/index.ts` in a checkout. It runs only when the service's `config.json` lists its id.

## The checks

Run these from the repository root before opening a pull request:

```bash
pnpm -r typecheck
pnpm -r test
```

A new balance setting needs an entry in `BALANCE_FIELDS` in `packages/dispatch-protocol/src/config-reference.ts`, and then `pnpm docs:update` to rewrite the tables in [Configuring Augur](configuring.md). The test that compares the tables with the code fails until both are done. A change to a shipped balance default also fails the classic-defaults test, which keeps an install that names no profile resolving to the same rules.
