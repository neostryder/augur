# The Augur MCP server

`augur-mcp` lets an MCP client, such as Claude Code or Claude Desktop, ask Augur which model should take a piece of work and then run it there. It is a thin layer over the dispatch service. Every tool goes through the same service and the same rules as the `augur` command, so the server cannot run a model the rules do not allow. It can ask for changes to the rules, and the owner's approval setting decides which of those changes wait for the owner to accept them in Augur. At the default level, a change that widens what data a model may see, or that lets a model run, always waits. It can also add a new route, and any model it adds starts unreviewed, so the route cannot run that model until the owner confirms it.

It needs the dispatch service, which runs whenever the Augur app is open; without the app, `augur service start` starts it, and `augur service enable` starts it at each login. Tools that run a job also need "Also run jobs" turned on in Augur's settings, and the service refuses jobs with `jobs_off` until it is. The server and the service run on Windows, macOS and Linux.

## Registering it

The installer puts the server in the `service` folder beside the app: `augur-mcp.cmd` on Windows, `augur-mcp` on macOS and Linux. A terminal install and the Arch packages also put `augur-mcp` on your PATH. Point the client at that file.

Claude Code: the [Augur plugin](claude-code.md) starts this server itself, so skip this step if you use the plugin. To register the server by hand:

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

The server also signs in with its own token, `agent-token` in the service's data folder, and the service enforces what that token may do. It can run jobs, read their state and results, cancel them, pick, read the balance and add routes. It cannot record a person's message, answer a pick, label a grade or a brief, or call the app's engine, and any `named`, `allow` or `interactive` claim on a job it submits is dropped. Those belong to the owner's terminal, app and hooks, which use `token`.

The data tier is required on every run and is never assumed. An agent has to say how sensitive its task is, and the service refuses a model that is not cleared for that tier.

## Tools

| Tool | Arguments | What it returns |
| --- | --- | --- |
| `augur_models` | none | Every model in the rules: status, cost, the most sensitive data it may see, ask-first, pause, and the routes that reach it. |
| `augur_pick` | `activity` and `data_tier`, or `task`; optional `depth` (`routine`, `everyday`, `deep`, or `core`), `best_only`, `snippet` | The permitted models ranked by score, with each one's odds and routes, the pick, and a line on why it won. The pick is drawn at random by those odds, and the line gives the odds when the draw passes over the top score. `best_only` takes the top score every time. Set `snippet` when drafting one sentence or one bullet with no other prose, so the prose routes get no extra weight. `depth` sets how much the task weighs in place of the classifier's reading or the activity's default, so a hard review can ask for a strong model. When training mode is on, a result whose `proposal` has `pending` set to true is waiting for its owner: ask the person which route to use and have them record it with `augur pick-answer`, because no job can run on the pick until then. With `task`, the classifier the owner chose sets the activity and data tier. |
| `augur_run` | `route`, `prompt`, `activity`, `data_tier`; optional `tools`, `output`, `cwd`, `timeout_s`, `wait_s`, `packs`, `no_charter`, `conversation`, `attachments`, `urgent` | The model's answer. `tools` is `read`, `write` or `full` and defaults to `read`. `output` is `text_only`, `patch_only` or `write_files` and defaults to `text_only`. `wait_s` is how long to wait, 300 by default and 900 at most. `packs` adds [charter](configuring.md#standing-instructions-for-every-job) packs by name and `no_charter` sends the prompt without the charter. `conversation` opens or resumes a named conversation, described below. `attachments` is a list of files sent with the prompt on an API route, described below. `urgent` marks the job as wanted now, so a local gateway gives it normal priority in place of the low priority background work gets. |
| `augur_job` | `id` | A job's state and, once it has finished, its answer. When the job was retried on a fallback route, the result is the last job in the chain. |
| `augur_jobs` | optional `limit` | Recent jobs, newest first. |
| `augur_cancel` | `id` | Asks a running job to stop. |
| `augur_pressure` | none | How much room each model has under its provider's plan. |
| `augur_routes` | none | Each route, its model and adapter, and any reason it cannot run. |
| `augur_route_add` | `name`, `adapter`, `provider`; optional `options` (strings, numbers and booleans), `model` (`label`, `id` and an optional `name`), `balance_url` and `balance_path` | Whether the route was added, with its name and model label. The text names the host the route's `baseUrl` points to and says that the owner confirms the model in Model rules and sets the key with `augur key set <route>`. A refusal lists every problem and writes nothing. [Adding a route](#adding-a-route) has the rules. |
| `augur_policy` | none | The full rules from `policy.json`: every model with its status, data tier, weights, pause, data handling, hold rules and notes, each provider's limits, the edits still queued, the ones waiting for the owner, and what became of recent ones. |
| `augur_policy_edit` | `edits`: a list of `model`, `field`, `value` and an optional `reason` (a limit edit names its `provider` instead of a model; a balance edit has `field` set to `balance` and a `path`) | Each edit with its value before the request, and whether it was queued, is waiting for the owner, or was rejected and why. |
| `augur_balance` | optional `days` | What the automatic balance is doing. Each provider paced against a usage window has a row with its stance, its windows, its boost and its rough odds. Then come Copilot's spend, how each provider is treated, where each kind of work goes now, and a summary of recent picks. Read only. |
| `augur_resets` | optional `provider`, `limit` (200 by default, at most 1000) | Recent limit resets from the reset ledger, with how early each came, and a summary of the whole ledger, for one provider when `provider` is given. Read only. |
| `augur_pick_preview` | `activity`, `data_tier`; optional `edits`, `include_pending`, `best_only`, `snippet` | Each route's score and odds, now and again with the given edits applied, so a change can be tried first. Nothing is drawn, and the text says `preview: no draw made`. It records nothing and does not count as a pick for a run. `best_only` is accepted and has no effect. |

Each result has a text form for the model and, where there is structure, a `structuredContent` object with the same facts. A refusal, a failed job and a service that is not running all come back as an error result with the reason in the text. A refusal carries the service's code, such as `not_picked`, in `structuredContent.rejected`.

A run that takes longer than `wait_s` returns its job id and leaves the job running. Read it later with `augur_job`.

With the owner's `runner.failover` setting on, a run that fails on a provider limit, a harness that will not start or a read-only timeout can run again on a fallback route. `augur_run` and `augur_job` follow the retry to its last job, add a `retried on <route> as <id>` line for each step, and put the `chain` of job ids in `structuredContent`. [Budgets and fallback routes](accounting.md#budgets-and-fallback-routes) has the rules for when a job is retried.

A `conversation` name keeps one model session going across runs, so a follow-up can build on what the model was already told. The first run with a new name opens the conversation on its route, and later runs with that name resume it there. Only Grok and Codex routes keep a conversation, and any other route refuses the name. A name is 1 to 64 letters, digits, dots, underscores or hyphens. It stays bound to the route that opened it, so a run on another route is refused, and a conversation job is never moved to a fallback. One job runs in a conversation at a time. A resumed Codex conversation keeps the tool tier of its first turn and refuses a run that asks for another. The charter goes with the first turn only, and if that turn fails, the next run with the name starts over. `augur conversations` lists them and `augur conversations --forget <name>` drops one.

`attachments` sends files with the prompt, and only routes on the `openai-api` and `anthropic-api` adapters take them. A text file is added to the prompt and counts toward the route's `maxInput`, an image goes to a model that reads images, and one audio file goes to the transcription endpoint, for the `transcribe` activity only. A route in `embeddings` mode takes only the `embed` activity, saves the vectors to `vectors.json` in the job folder, and answers with how many inputs it embedded and how many numbers each vector has. Each file has to be inside `cwd` or a folder listed in `promptRoots`, be a text, image or audio file, fit the route's size cap (`maxImageMb`, 10 by default, and `maxAudioMb`, 25 by default), and suit the route. When a file fails any of these checks, the run is refused with `attachment_rejected` in `structuredContent.rejected` and a reason that names the file, such as "Attachment scan.png is 14 MB and route eru-vision takes image files up to 10 MB." A run takes at most 16 files. A prompt whose text, attachments included, runs past `maxInput` is refused with `prompt_too_large` and is never cut. A refusal for an attachment or for `maxInput` sends the job to the route's fallback when the route has one.

## Changing the rules

The server never writes the rules. `augur_policy_edit` checks each edit against `policy.json`, then appends the valid ones to `policy-edits.jsonl` beside it. The running Augur service reads that file within a minute, or as soon as the panel or the terminal app comes to the front, and applies each edit with the same code the rules page uses, so every change is stamped, recorded under History and merged to the phone like one made by hand. The service records what it did with each edit in `policy-edit-results.json`, which `augur_policy` reads back. The service has to be running for an edit to land.

These edits apply at once: an activity weight (`activities.<activity>`, one of `last_resort`, `occasional`, `normal`, `often` or `preferred`, `null` to block the activity, or `"inherit"` to return to the provider's default), `pause`, `notes` and `useAfter`. These wait in Model rules for the owner to choose Accept or Dismiss: `dataTier`, `askFirst`, `output`, `sandbox`, `effort`, `cost`, `status`, `dataHandling.<part>` and `thresholds.<warnPct|denyPct|minBalance>`. Accepting runs the checks again against the rules as they are then. An edit that fails its checks, or names a model that is not in the rules, is rejected with the reason and never reaches the app.

To edit a balance setting, set `field` to `balance` and give a `path` with one name per level, such as `["tilt", "deep", "strong"]` or `["tiers", "codex/gpt-6.1-sol"]`. A route label counts as one name, dots and slashes included. The settings are the ones in the table in [configuring.md](configuring.md), and the value must be of the type the setting takes. `"inherit"` puts a setting back to the profile's own value, and `null` removes one entry of a map, such as a tier. A balance edit names no model and applies at once at the default level. The history records it under a path that starts with `balance:`.

The owner's approval setting, on the window app's Service page and under Service on the terminal app's Dispatch page, decides what waits. `Ask me for risky edits` is the default and holds the edits listed above as waiting for the owner. `Ask me for everything` holds every edit. `Apply everything` holds none, which lets an agent change what data a model may see, though each change is still checked, stamped and recorded in the history. No tool here reads or changes the setting, and an edit that names it is rejected.

`augur_pick_preview` ranks with the edits applied to a copy of `policy.json`, using the current usage, and shows each route's odds, so an agent can see what a change would do before it asks for it. With `include_pending` it also applies the edits that are queued or waiting for the owner. It cannot preview `"inherit"`, since `policy.json` no longer carries the provider's defaults.

## Adding a route

`augur_route_add` writes one new route to `dispatch/routes.json` through the service. The whole request is checked first, and nothing is written if any part fails: the name has to be new and in the usual route-name form, the adapter has to be one the service has, and the provider id has to be valid. An existing route is never changed or removed.

A key is never accepted. An argument or option named like a key (`key`, `apiKey`, `api_key`, `token`, `secret` or `password`) is refused, and so is a value that looks like one, such as a string starting with `sk-`. The owner sets the key afterwards with `augur key set <route>`.

A route add takes only these options: `baseUrl`, `model`, `mode`, `maxTokens`, `timeoutS`, `effort`, `requestClass`, `maxImageMb`, `maxAudioMb`, `maxInput`, and `keySource` set to `store`. An option that names a program, an argument list, a folder, an environment variable or a header (`command`, `argsJson`, `workRoot`, `envAllow`, `apiKeyEnv`, `headersJson` and the like) is refused, since the owner sets those in Routes.

With a `model`, the model goes into the rules unreviewed, so nothing runs it until the owner confirms it in Model rules. A label with no slash is filed as `<provider>/<label>`, and a route for a model already in the rules is held for the owner, who adds it in the app. A `model` takes only a label, an id and a name, and rule fields in it are refused, since the owner sets those in Model rules. Without a `model`, the route points at `<provider>/<name>`, which has to be added to the rules and confirmed before the route can run.

`balance_url` and `balance_path` add a balance reading for a provider Augur does not know yet, read with the route's key sent as a bearer token. The two go together, the URL starts with `https://`, or with `http://` for a service on this computer, and both are refused for a provider that already exists. The reading stays off until the owner sets the key.

The owner's approval setting applies here too. At `Ask me for everything` the add is held: nothing is written, and the owner can add the route in the app. At the other two levels the route is written at once. A route's `baseUrl` decides where its key will be sent, so the result names that host, and `augur key set <route>` shows it again before it asks for the key.

## Changing the tools

The tool functions live in `packages/mcp/src/tools.ts` and take the service call as a dependency, so tests use a fake. The names, descriptions and input shapes are in `packages/mcp/src/server.ts`. Descriptions are read by models and by owners reviewing what a client can do, so they state what a tool does and what it will not do.
