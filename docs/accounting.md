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

`fallback` lists routes to try, in order, when a job is refused for a reason that may pass: a budget, a pause, plan usage, or an adapter or key that is missing. Each fallback is checked against every rule as if it had been asked for, so it cannot get around a data tier, a pick or an ask-first model. A fallback usually needs the pick to have cleared its model too. The job records which route took it, and `augur run --no-failover` keeps a job on the route named. A fallback's own fallbacks are not followed.
