# Tokens and cost of jobs

`augur usage` and the Jobs page show what each job used and what it cost. Every figure says how it is known.

| Label | Meaning |
| --- | --- |
| reported | The harness or provider gave the number. |
| derived | Arithmetic on reported numbers: reported tokens times a rate you set. |
| imputed | An estimate, shown with how far off it usually is. |

An imputed figure is never mixed into a reported one, and a reported figure is never replaced by an estimate.

## Cost

Augur ships no prices, because a plan-billed model has no per-token price and published prices change. To get a derived cost for a model, list its rate in `dispatch/rates.json` inside the Augur folder (`%USERPROFILE%\.augur` by default), in dollars per million tokens:

```json
{ "openrouter/some-model": { "inputPerM": 1.25, "outputPerM": 10, "cachedReadPerM": 0.125 } }
```

Each entry is named by the model label the rules page uses. `cachedReadPerM` and `cachedWritePerM` are optional, but when a job reports cached tokens and the rate has no price for them, that job gets no cost. Guessing the price of cached tokens would misstate the total. A cost the harness reports itself is used as it is. The service reads the file each time it is asked, so an edit shows up without a restart.

## Estimated tokens

Some harnesses print no token counts. For those, Augur keeps the length of each prompt and answer in characters (never the text) and learns a characters-per-token ratio for each route from that route's own jobs that did report tokens. It estimates from that ratio only when

- at least 8 jobs on the route have reported both a count and a length, and
- the ratio's typical error over those jobs is 35% or less.

The error is measured on the route's own jobs, and it is shown next to every estimate, for example `300 (imputed, about 25% off)`. A route that does not meet the bar gets no estimate, and its figures read unknown. A cost built from estimated tokens is labelled imputed and carries the larger share's error. Cache use is unknown for those jobs, so their input is priced as fresh tokens.

Plan usage is not estimated. Each provider's quota moves in units it does not publish, so the plan meters stay as the providers report them.

## Where to read them

- `augur usage` prints totals per route and the 20 most recent jobs. `--limit` changes the count and `--json` gives the full data.
- The Jobs page shows tokens and cost in a job's details.
- The `accounting` call on the service returns the same data to any client.

## Budgets and fallback routes

A route can carry a budget in `dispatch/routes.json`, or on the Routes page:

```json
{ "routes": { "sol": { "model": "codex/sol", "adapter": "codex-exec", "budget": { "per": "week", "usd": 20, "jobs": 100 }, "fallback": ["luna"] } } }
```

The period is `day`, `week` or `month`, counted back from now (24 hours, 7 days, 30 days). Set `usd`, `jobs` or both. A job limit counts every job on the route in the period, as soon as it is submitted. A dollar limit adds up the costs above, so it counts only jobs with a known cost, and a route with a dollar limit and no cost data is checked on jobs alone and warns about it. Once a limit is reached, a new job on the route is refused with `budget_exhausted` and the limit it hit. `augur usage` shows each budget's use.

`fallback` lists routes to try, in order, when a job is refused for a reason that may pass: a budget, a pause, plan usage, or an adapter or key that is missing. Each fallback is checked against every rule as if it had been asked for, so it cannot get around a data tier, a pick or an ask-first model. A fallback usually needs the pick to have cleared its model too. The job records which route took it. A fallback's own fallbacks are not followed.

The same list can catch a job that fails after it starts. This is off by default: set `runner.failover` to `on` on the Service page or with `augur config`. A failed job then runs again with the same request on the first route in its route's fallback list that accepts it, when the harness could not be started, the provider reported a limit (a rate limit, a quota, a 429, too many requests and similar messages), or a read-only job ran out of time. A write or full job may already have changed files, so it is retried only for a limit, and only when it left no answer and no recorded change. A cancelled job, a write job that timed out and every other failure stay as they are. A retry goes through every rule again and skips the routes already tried, it can be retried in turn from its own route's list, and a chain stops at three jobs.

The failed job keeps its state and gains `retriedAs`, the id of the job that replaced it, and the new job carries `retryOf`. `augur wait`, `augur result`, `augur run --wait` and the MCP server's `augur_run` and `augur_job` follow the chain to its last job, and the command prints `retried on <route> as <id>` for each step. The service keeps the request in memory only until the job ends, so a job that was running when the service restarted is not retried. `augur run --no-failover`, or `failover: false` in a request, keeps a job on the route named, with no fallback at submit and no retry afterwards. A job in a named conversation never moves to another route either way.
