# The Augur MCP server

`augur-mcp` lets an MCP client, such as Claude Code or Claude Desktop, ask Augur which model should take a piece of work and then run it there. It is a thin layer over the dispatch service. Every tool goes through the same service and the same rules as the `augur` command, so the server cannot run a model the rules do not allow, and it has no way to switch a rule off.

It needs the dispatch service running. Turn on "Also run jobs" on the Service page, or run `augur service start`. Windows only, like the service.

## Registering it

The installer puts `augur-mcp.cmd` in the `service` folder beside the app. Point the client at that file.

Claude Code:

```bash
claude mcp add augur -- "<install folder>\service\augur-mcp.cmd"
```

Claude Desktop, in `claude_desktop_config.json`:

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
| `augur_pick` | `activity` and `data_tier`, or `task` | The permitted models ranked by score, with the routes for each and the pick. With `task`, the classifier the owner chose sets the activity and data tier. |
| `augur_run` | `route`, `prompt`, `activity`, `data_tier`; optional `tools`, `output`, `cwd`, `timeout_s`, `wait_s` | The model's answer. `tools` is `read`, `write` or `full` and defaults to `read`. `output` is `text_only`, `patch_only` or `write_files` and defaults to `text_only`. `wait_s` is how long to wait, 300 by default and 900 at most. |
| `augur_job` | `id` | A job's state and, once it has finished, its answer. |
| `augur_jobs` | optional `limit` | Recent jobs, newest first. |
| `augur_cancel` | `id` | Asks a running job to stop. |
| `augur_pressure` | none | How much room each model has under its provider's plan. |
| `augur_routes` | none | Each route, its model and adapter, and any reason it cannot run. |

Each result has a text form for the model and, where there is structure, a `structuredContent` object with the same facts. A refusal, a failed job and a service that is not running all come back as an error result with the reason in the text. A refusal carries the service's code, such as `not_picked`, in `structuredContent.rejected`.

A run that takes longer than `wait_s` returns its job id and leaves the job running. Read it later with `augur_job`.

## Changing the tools

The tool functions live in `packages/mcp/src/tools.ts` and take the service call as a dependency, so tests use a fake. The names, descriptions and input shapes are in `packages/mcp/src/server.ts`. Descriptions are read by models and by owners reviewing what a client can do, so they state what a tool does and what it will not do.
