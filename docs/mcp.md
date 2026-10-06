# The Augur MCP server

`augur-mcp` lets an MCP client, such as Claude Code or Claude Desktop, ask Augur which model should take a piece of work and then run it there. It is a thin layer over the dispatch service. Every tool goes through the same service and the same rules as the `augur` command, so the server cannot run a model the rules do not allow. It can ask for changes to the rules, and the owner's approval setting decides which of them wait for an accept in Augur. At the default level, a change that widens what data a model may see or lets a model run always waits.

It needs the dispatch service, which runs whenever the Augur app is open; without the app, `augur service start` starts it, and `augur service enable` starts it at each login. Tools that run a job also need "Also run jobs" turned on in Augur's settings, and the service refuses jobs with `jobs_off` until it is. The server and the service run on Windows, macOS and Linux.

## Registering it

The installer puts the server in the `service` folder beside the app: `augur-mcp.cmd` on Windows, `augur-mcp` on macOS and Linux. A terminal install and the Arch packages also put `augur-mcp` on your PATH. Point the client at that file.

Claude Code:

```bash
claude mcp add augur -- "<install folder>\service\augur-mcp.cmd"
claude mcp add augur -- augur-mcp
```

The first line is for Windows and the second for a macOS or Linux install that has `augur-mcp` on its PATH. For the macOS app without a terminal install, give the full path, `/Applications/Augur.app/Contents/Resources/service/augur-mcp`.

Claude Desktop: turn on Claude Desktop chat under Claude in Augur's settings, which adds this entry to `claude_desktop_config.json` and removes it again when turned off. To add it by hand:

```json
{ "mcpServers": { "augur": { "command": "<install folder>\\service\\augur-mcp.cmd" } } }
```

The server talks over standard input and output. Nothing else is written to standard output, and its startup line goes to standard error. It reads the same `AUGURD_DATA`, `AUGURD_PIPE` and `AUGUR_HOME` settings as the command line, and it uses the folder it was started in as the default working folder for jobs.

## How a session works

Each server process makes one random session id, and sends it with every call. `augur_pick` records the pick under that id, and the service allows a run only when its model was picked, or was cleared by a pick, for the same session within the last hour. A client that skips the pick gets a refusal that says so.

The server never sends the `allow` list that skips the pick or plan-usage checks from the command line, and it never says a person named a model, so an agent cannot claim its owner did. Jobs from the server are recorded with the caller kind `mcp`.

The data tier is required on every run and is never assumed. An agent has to say how sensitive its task is, and the service refuses a model that is not cleared for that tier.

## Tools

| Tool | Arguments | What it returns |
| --- | --- | --- |
| `augur_models` | none | Every model in the rules: status, cost, the most sensitive data it may see, ask-first, pause, and the routes that reach it. |
| `augur_pick` | `activity` and `data_tier`, or `task`; optional `depth` (`deep` or `everyday`) | The permitted models ranked by score, with the routes for each, the pick, and one line saying why it won. `depth` overrides the activity's default, so a hard review can ask for a strong model. With `task`, the classifier the owner chose sets the activity and data tier. |
| `augur_run` | `route`, `prompt`, `activity`, `data_tier`; optional `tools`, `output`, `cwd`, `timeout_s`, `wait_s` | The model's answer. `tools` is `read`, `write` or `full` and defaults to `read`. `output` is `text_only`, `patch_only` or `write_files` and defaults to `text_only`. `wait_s` is how long to wait, 300 by default and 900 at most. |
| `augur_job` | `id` | A job's state and, once it has finished, its answer. |
| `augur_jobs` | optional `limit` | Recent jobs, newest first. |
| `augur_cancel` | `id` | Asks a running job to stop. |
| `augur_pressure` | none | How much room each model has under its provider's plan. |
| `augur_routes` | none | Each route, its model and adapter, and any reason it cannot run. |
| `augur_policy` | none | The full rules from `policy.json`: every model with its status, data tier, weights, pause, data handling, hold rules and notes, each provider's limits, the edits still queued, the ones waiting for the owner, and what became of recent ones. |
| `augur_policy_edit` | `edits`: a list of `model`, `field`, `value` and an optional `reason` (a limit edit names its `provider` instead of a model; a balance edit has `field` set to `balance` and a `path`) | Each edit with its value before the request, and whether it was queued, is waiting for the owner, or was rejected and why. |
| `augur_balance` | optional `days` | What the automatic balance is doing: where each kind of work goes now, Claude's pace against its week and 5-hour window, Copilot's spend, each provider's stance and a summary of recent picks. Read only. |
| `augur_pick_preview` | `activity`, `data_tier`; optional `edits`, `include_pending` | The ranking now and again with the given edits applied, so a change can be tried first. It records nothing and does not count as a pick for a run. |

Each result has a text form for the model and, where there is structure, a `structuredContent` object with the same facts. A refusal, a failed job and a service that is not running all come back as an error result with the reason in the text. A refusal carries the service's code, such as `not_picked`, in `structuredContent.rejected`.

A run that takes longer than `wait_s` returns its job id and leaves the job running. Read it later with `augur_job`.

## Changing the rules

The server never writes the rules. `augur_policy_edit` checks each edit against `policy.json`, then appends the valid ones to `policy-edits.jsonl` beside it. The running Augur service reads that file within a minute, or as soon as the panel or the terminal app comes to the front, and applies each edit with the same code the rules page uses, so every change is stamped, recorded under History and merged to the phone like one made by hand. The service records what it did with each edit in `policy-edit-results.json`, which `augur_policy` reads back. The service has to be running for an edit to land.

These edits apply at once: an activity weight (`activities.<activity>`, one of `last_resort`, `occasional`, `normal`, `often` or `preferred`, `null` to block the activity, or `"inherit"` to return to the provider's default), `pause`, `notes` and `useAfter`. These wait in Model rules for the owner to choose Accept or Dismiss: `dataTier`, `askFirst`, `output`, `sandbox`, `effort`, `cost`, `status`, `dataHandling.<part>` and `thresholds.<warnPct|denyPct|minBalance>`. Accepting runs the checks again against the rules as they are then. An edit that fails its checks, or names a model that is not in the rules, is rejected with the reason and never reaches the app.

A balance setting is edited with `field` set to `balance` and a `path` that gives one name per level, such as `["tilt", "deep", "strong"]` or `["tiers", "codex/gpt-6.1-sol"]`; a route label stays whole, dots and slashes included. The settings are the ones in the table on [configuring.md](configuring.md). The value must be the kind the setting takes, `"inherit"` puts a setting back to the profile's own value, and `null` removes one entry of a map such as a tier. A balance edit names no model, applies at once at the default level, and is recorded in the history with a path that starts `balance:`.

The owner's approval setting, in the app's Service page and the terminal app's Service screen, decides what waits. `Ask me for risky edits` is the default and holds the edits listed above as waiting for the owner. `Ask me for everything` holds every edit. `Apply everything` holds none, so an agent can then change what data a model may see; each change is still checked, stamped and recorded in the history. No tool here reads or changes the setting, and an edit that names it is rejected.

`augur_pick_preview` ranks with the edits applied to a copy of `policy.json`, using the current usage, so an agent can see what a change would do before it asks for it. With `include_pending` it also applies the edits that are queued or waiting for the owner. It cannot preview `"inherit"`, since `policy.json` no longer carries the provider's defaults.

## Changing the tools

The tool functions live in `packages/mcp/src/tools.ts` and take the service call as a dependency, so tests use a fake. The names, descriptions and input shapes are in `packages/mcp/src/server.ts`. Descriptions are read by models and by owners reviewing what a client can do, so they state what a tool does and what it will not do.
