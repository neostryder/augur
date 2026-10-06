# Configuring Augur

The app covers most of this: Rules says what each model may do, Routes connects a model to the program that runs it, and Settings holds providers and keys. This page is for what sits behind those screens, which matters when you adapt Augur by hand or have an AI agent do it. The tables are generated from the code, and a test fails when they stop matching it.

## Where the settings live

| What | File | Edited with |
| --- | --- | --- |
| Rules for every model, and the balance overrides | `policy` inside `config.json` in the app's settings folder. Augur writes it out to `policy.json` in `~/.augur` each time a rule changes. | The Rules page, the `augur_policy_edit` tool for models, and by hand for the balance |
| Providers, where their keys come from, custom providers, alerts | `config.json` in the app's settings folder | Settings, or by hand |
| Routes | `dispatch/routes.json` in `~/.augur` | The Routes page, or by hand |
| Service settings | Listed by `augur config` | The Service page |

The settings folder is `%APPDATA%\com.neostryder.augur` on Windows, `~/Library/Application Support/com.neostryder.augur` on macOS and `~/.config/com.neostryder.augur` on Linux. `AUGUR_APP_DIR` moves it and `AUGUR_HOME` moves `~/.augur`. The app and the service both write `config.json`, so close the app and run `augur service stop` before you edit it. A hand edit to `policy.json` is overwritten the next time a rule is saved.

## Models and route labels

Every model has a route label in the form `<provider>/<model>`, such as `codex/sol` or `claude/claude-sonnet-5-5`. The rules, the balance and `routes.json` all go by label. Each label also holds the model id the provider expects, so a label can be shorter or friendlier than the id.

A model also has a standard name: its provider id and its model id joined by a slash, such as `codex/gpt-6.1-sol`. The balance accepts either one wherever it names a model (tiers, preferences, the prose models, the backup lists and the seats), and a `*` in a name matches any text, so `claude/*opus*` covers every Opus a Claude provider lists. A rule written against a label wins over one written against the standard name, and that one wins over a pattern. A label is only your own name for the model, so the same rules work on an install whose labels differ from yours.

Augur reads each provider's model list once a day and keeps the newest model of each family. You can also add a model by hand on the Rules page. A new model is never picked until you confirm it there and say which activities it may do and how sensitive the data it sees can be.

## Adding a provider

A provider that reports usage from a JSON endpoint is a short definition in Settings. The README's [custom providers](../README.md#custom-providers) section has the format: the requests to make, which header or parameter carries the key, and the paths that meters and balances are read from. A provider that needs its sign-in refreshed, or reads usage from a command-line login, is a plugin in `packages/core/src/providers` with a fixture and a test in `packages/core/test`.

Reading usage and running a model are separate. A provider added for usage still needs a route before an agent can run work on it.

## Adding a route

A route joins a model to the program or API that runs it. The Routes page has an Add route form, and Test route sends one word through to show a bad path or a missing key. The routes are stored in `dispatch/routes.json`:

```json
{
  "routes": {
    "deepseek": {
      "model": "openrouter/deepseek-v4.1-flash",
      "adapter": "openai-api",
      "options": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "model": "deepseek/deepseek-v4.1-flash",
        "keySource": "env",
        "apiKeyEnv": "OPENROUTER_API_KEY"
      }
    }
  }
}
```

An agent passes the key of a route, here `deepseek`, to `augur run`. It starts with a lowercase letter and holds only lowercase letters, digits, `-` and `_`. `model` is the route label the rules use, so that model must be on the Rules page and confirmed before the route runs anything. `adapter` is one of those below and `options` are its settings. A route can also have `notes`, `delegation`, a `budget` (`per` is `day`, `week` or `month`, with a limit in `usd`, `jobs` or both) and a `fallback` list of other route names to try when it cannot run.

An API route never holds its key. It names an environment variable, or it reads the operating system's key store, which the Routes page fills. `augur key set <route>` fills the same store from a hidden prompt, from an environment variable you set in your own terminal (`--env <NAME>`) or from standard input (`--stdin`), and `augur key status <route>` says whether a key is there without printing it. The command refuses a key typed after the route name, so a key never lands in shell history or in a chat.

<!-- adapter-reference:start -->

#### `codex-exec`: Codex CLI

Runs codex exec. A read-only job is stated in the prompt, and Codex is not held to it.

| Option | Value | What it does |
| --- | --- | --- |
| `model` | text | Passed to codex as its model. Leave empty for the model codex chooses. |
| `effort` | text | Passed to the harness as its effort setting. Leave empty for its default. |
| `command` | text | Full path to the harness, for when it is not on the search path. |
| `sandbox` | read-only, workspace-write, danger-full-access | The sandbox codex runs in. On Windows the stricter ones can fail to start, which is why the default is danger-full-access. |
| `prefixArgsJson` | json | A JSON array of arguments placed before exec, for wrappers. |

#### `copilot-exec`: GitHub Copilot CLI

Runs the Copilot CLI in prompt mode with all tools allowed, so a read-only job is stated in the prompt and not enforced.

| Option | Value | What it does |
| --- | --- | --- |
| `model` (required) | text | The Copilot model id, for example claude-opus-5.5. |
| `command` | text | Full path to the harness, for when it is not on the search path. |
| `effort` | text | Passed to the harness as its effort setting. Leave empty for its default. |
| `envAllow` | text | Names of environment variables the harness may read, separated by commas. Nothing else from the service is passed on. |

#### `grok-exec`: Grok CLI

Runs the Grok CLI, which has a real read mode, so a read job is held to reading.

| Option | Value | What it does |
| --- | --- | --- |
| `model` (required) | text | The Grok model id. |
| `effort` | text | Passed to the harness as its effort setting. Leave empty for its default. |
| `maxTurns` | number | Most turns a job may take. Defaults to 60 for a read job and 400 otherwise. |
| `command` | text | Full path to the harness, for when it is not on the search path. |
| `envAllow` | text | Names of environment variables the harness may read, separated by commas. Nothing else from the service is passed on. |

#### `hermes-exec`: Hermes Agent

Runs the Hermes command line with a prompt and reads its usage file.

| Option | Value | What it does |
| --- | --- | --- |
| `model` (required) | text | The model id Hermes passes to its provider. |
| `command` | text | Full path to the harness, for when it is not on the search path. |
| `envAllow` | text | Names of environment variables the harness may read, separated by commas. Nothing else from the service is passed on. |

#### `mcode-sbx`: mcode in a Docker sandbox

Runs mcode inside a Docker sandbox on a copy of the job folder, and returns changes as a patch.

| Option | Value | What it does |
| --- | --- | --- |
| `sandbox` (required) | text | The Docker sandbox the harness runs inside. |
| `workRoot` (required) | text | The folder on this computer that the sandbox mounts as its workspace. Each job gets a copy of its folder there. |
| `model` (required) | text | The model id mcode uses. |
| `effort` | text | Passed to the harness as its effort setting. Leave empty for its default. |
| `maxSteps` | number | Most steps a job may take. Defaults to 60 for a read job and 400 otherwise. |
| `sbx` | text | Full path to the sbx command, for when it is not on the search path. |
| `sbxPrefixJson` | json | A JSON array of arguments placed before every sbx call, for wrappers. |
| `envAllow` | text | Names of environment variables the harness may read, separated by commas. Nothing else from the service is passed on. |

#### `opencode-sbx`: OpenCode in a Docker sandbox

Runs OpenCode inside a Docker sandbox on a copy of the job folder, and returns changes as a patch.

| Option | Value | What it does |
| --- | --- | --- |
| `sandbox` (required) | text | The Docker sandbox the harness runs inside. |
| `workRoot` (required) | text | The folder on this computer that the sandbox mounts as its workspace. Each job gets a copy of its folder there. |
| `model` (required) | text | The provider/model id OpenCode uses. |
| `sbx` | text | Full path to the sbx command, for when it is not on the search path. |
| `sbxPrefixJson` | json | A JSON array of arguments placed before every sbx call, for wrappers. |
| `envAllow` | text | Names of environment variables the harness may read, separated by commas. Nothing else from the service is passed on. |

#### `openai-api`: OpenAI-style API

Sends one prompt to a chat completions endpoint and returns the text. No tools and no files.

| Option | Value | What it does |
| --- | --- | --- |
| `baseUrl` (required) | text | The API address up to and including /v1. It must start with https://, or http:// for localhost. |
| `model` (required) | text | The model id the endpoint expects. |
| `keySource` | env, store | Pick env to read the key from an environment variable you name, or store to keep it in this computer's key store. A stored key is saved on the Routes page or with `augur key set <route>`. |
| `apiKeyEnv` (required) | text | The name of the environment variable that holds the API key, when Key kept in is set to env. The key itself is never stored in a route. |
| `maxTokens` | number | Most tokens the answer may use. Defaults to 4096. |
| `timeoutS` | number | Defaults to 900. |

#### `anthropic-api`: Anthropic-style API

Sends one prompt to a messages endpoint and returns the text. No tools and no files.

| Option | Value | What it does |
| --- | --- | --- |
| `baseUrl` (required) | text | The API address. It must start with https://, or http:// for localhost. |
| `model` (required) | text | The model id the endpoint expects. |
| `keySource` | env, store | Pick env to read the key from an environment variable you name, or store to keep it in this computer's key store. A stored key is saved on the Routes page or with `augur key set <route>`. |
| `apiKeyEnv` (required) | text | The name of the environment variable that holds the API key, when Key kept in is set to env. The key itself is never stored in a route. |
| `maxTokens` | number | Most tokens the answer may use. Defaults to 4096. |
| `timeoutS` | number | Defaults to 900. |

#### `exec`: Any command

Runs any command the route names, with no checks on what it does. It is off unless the service settings list it.

| Option | Value | What it does |
| --- | --- | --- |
| `command` (required) | text | The program to run. |
| `argsJson` | json | A JSON array of arguments. |
| `stdin` | prompt, none | Whether the command reads the prompt on standard input. |

<!-- adapter-reference:end -->

## Tuning the balance

The balance leans each pick toward the models that suit the work, holds Claude near its pace and keeps backup routes in reserve. The README's [section on it](../README.md#how-a-pick-balances-models) says what it does. Its settings are the `balance` object of the rules. Each has a shipped default, a value of the wrong type is ignored, and `null` removes a shipped entry from a map.

The `profile` setting picks the rules the other settings sit on. `classic` is the original rule set, with tiers, preferences and seats for a particular stack, and it is what an install that names no profile uses, so an update never changes what such an install picks. `neutral` is what a new install starts on: weights, pauses and data tiers apply as always, and the only tilt is Claude's pace (Sonnet when Claude runs ahead, Opus when it runs behind). It holds no preferences, no excluded names and no seats, so each is yours to add.

Put the object in `config.json` under `policy`, with the app closed and the service stopped. Augur copies it into `policy.json` the next time it saves a rule or a setting, and the service reads that file for every pick. This example holds Copilot spend to $90 with a $150 stop, never picks anything with `astra` in its name, and adds a preference:

```json
{
  "policy": {
    "balance": {
      "fallback": { "aim": 90, "cap": 150 },
      "exclude": ["astra"],
      "prefer": { "minimax/m3": { "research": 1.3 } }
    }
  }
}
```

`augur balance` shows what the settings are doing, and `augur_pick_preview` ranks a task against them before an agent runs it.

<!-- balance-reference:start -->

| Setting | Value | What it does |
| --- | --- | --- |
| `profile` | classic or neutral | The starting rules the other settings sit on. Neutral tilts only for Claude pace; classic is the original rule set and is what an install with no profile uses. |
| `enabled` | true or false | Switches the whole balance off. A pick then ranks on weights and usage alone. |
| `depth.<activity>` | deep or everyday | How hard an activity is when the caller does not say. Deep work leans to strong models and everyday work to light ones. |
| `tiers.<route>` | strong or light | The tier of a route. A route with no tier is never tilted. Set a shipped entry to null to remove it. |
| `exclude` | list of words | Route labels, or ids containing any of these words, that are never picked unless a caller names one. |
| `tilt.deep.strong` | number above 0 | The score multiplier for a strong route on deep work. |
| `tilt.deep.light` | number above 0 | The score multiplier for a light route on deep work. |
| `tilt.everyday.strong` | number above 0 | The score multiplier for a strong route on everyday work. |
| `tilt.everyday.light` | number above 0 | The score multiplier for a light route on everyday work. |
| `prose.models` | list of routes | The routes that write the best prose. They get prose.tilt on draft_prose at any depth. |
| `prose.tilt` | number above 0 | The multiplier a prose route gets on draft_prose in place of the depth tilt. |
| `claude.provider` | provider id | The provider the Claude controller steers. It reads that provider's session and weekly windows. |
| `claude.band` | points | How many points of usage ahead of or behind the share of the window that has passed still count as on pace. |
| `claude.reserve` | percent | A window at or above this moves optional work off Claude while another route can take it. |
| `claude.hot.strong` | number above 0 | The multiplier for a strong route when Claude runs ahead of pace. |
| `claude.hot.light` | number above 0 | The multiplier for a light route when Claude runs ahead of pace. |
| `claude.behind.strong` | number above 0 | The multiplier for a strong route when Claude runs behind pace. |
| `claude.behind.light` | number above 0 | The multiplier for a light route when Claude runs behind pace. |
| `fallback.providers` | list of provider ids | Providers whose routes are backups. They compete only when no subscription route can take the work. |
| `fallback.routes.<route>` | list of activities | A single route that is a backup for these activities only. |
| `fallback.anthropic` | list of routes | Claude models reached through a backup provider. They are allowed once Claude is at its reserve, since a Claude stop halts everything. |
| `fallback.aim` | dollars | The monthly spend on backup routes the router tries to stay under. A pick mentions the spend once it passes this. |
| `fallback.cap` | dollars | The monthly spend at which backup routes are dropped, except the Claude models in fallback.anthropic while Claude is at its reserve. |
| `fallback.margin` | dollars | Added to the last known spend, because the provider's figures lag. |
| `prefer.<route>.<activity>` | number above 0 | What a route is known to be good at: a multiplier on one activity. Set a route or an entry to null to remove it. |
| `seats.second.models` | list of routes | The routes that give a second opinion, in order. The first one that is allowed for the task is named. |
| `seats.second.skip` | list of activities | Activities too small to need a second opinion. |
| `seats.web.<activity>` | list of routes | The free web routes a pick recommends for an activity, in order. The calling session drives the browser. Set an activity to null to remove it. |
| `seats.shadow` | route | The local model that answers beside a pick made by a reasoning model, so the two answers can be compared. |
| `seats.jev.route` | route | The classifier route that is first for the activities listed next. |
| `seats.jev.activities` | list of activities | The activities the classifier route is first for. |
| `seats.jev.tilt` | number above 0 | The multiplier the classifier route gets on those activities. |

<!-- balance-reference:end -->

A route that no setting names is never tilted, so a stack with different routes still works. The shipped defaults tilt the routes of the maintainer's own stack. To use others, add your routes to `tiers` and `prefer`, and set the shipped entries to `null`.
