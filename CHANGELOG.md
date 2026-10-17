# Changelog

All notable changes to Augur are listed here. Each entry starts with `[Visible]` when a user would notice it or `[Internal]` when only the code or tooling changed, followed by the kind of change.

## [Unreleased]

### Added

- [Visible] [Platform] [Security] **The web app serves https with a certificate the service makes itself, with nothing to install or manage.** The new `web.tlsAuto` setting chooses when. At the default, `auto`, the service uses its certificate whenever `web.host` is a network address, `on` uses it on `127.0.0.1` too, and `off` never makes one. The service keeps the certificate for this computer's names and addresses in its data folder and makes a new one before it expires or when a name is missing. Each browser warns about it once, and `augur web` and the service log show its SHA-256 fingerprint to compare with the warning. `web.tlsCert` and `web.tlsKey` take precedence when both are set; see [docs/web.md](docs/web.md#self-signed-https-with-webtlsauto).

### Changed

- [Visible] [Platform] [Security] **A service that listens on a network address now serves the web app over https.** Old `http://` links and bookmarks stop working, so run `augur web` for the new links, and each browser warns once about the self-signed certificate. Set `web.tlsAuto` to `off` to keep plain http. The plain-http warning in `augur web` and the service log now appears only in that case.

## [1.11.0] - 2026-10-16

### Added

- [Visible] [Providers] [Security] **Programs that call Jev can point at `http://127.0.0.1:8020` and leave the TypeSafe key out of their own config.** The new Jev gateway, built with `node scripts/build-gateway.mjs`, holds the key and the `jev-preview` alias in `~/.augur/jev-gateway.json` and refuses to send `sensitive` or `regulated` requests anywhere but Laya. Usage goes to `~/.augur/jev-gateway-usage.jsonl` without the request text; see [docs/jev-gateway.md](docs/jev-gateway.md).
- [Visible] [Providers] [Security] **`augur grade <rubric> --task ... --candidate ...` scores an answer against a rubric in `~/.augur/rubrics`.** Grades start in shadow mode and only produce pass or fail verdicts after `augur label <grade id> --grade agree|high|low` has collected enough agreement, which for a low-stakes rubric means 30 labels at 85%. Text in the `sensitive` or `regulated` tier is graded on Laya only; [docs/grading.md](docs/grading.md) has the rubric format.
- [Visible] [Providers] **A pick weighs the task as routine, everyday, deep, or core, and a route can be capped.** Routine work such as renames and boilerplate leans hard toward light models, and core work such as an engine or security-critical code leans hardest toward strong ones, through the new `tilt.routine` and `tilt.core` settings. `--depth` on `augur pick` and `depth` on `augur_pick` take all four values, and without one the decision backend judges the task description. `caps.<route>.perDay` and `caps.<route>.perSession` limit how often a route is picked, and a capped route still runs when a caller names it. No route is capped unless you set a cap.
- [Visible] [Providers] **Training mode asks you before a pick goes to a strong model.** With `training.enabled` on, a pick on a strong route becomes a proposal, and no job runs on it until you answer with `augur pick-answer <pick id> --model <route>`. Once at least 10 of your answers for a kind of work exist and 90% of the last 20 agreed with the proposal, that kind of work stops asking, apart from core work and one pick in ten as a spot check. Your choices also lean later picks for that kind of work a little. Training mode is off by default.
- [Visible] [UI] [Platform] **The service can serve the Augur app to a browser on any device that can reach this computer.** The page shows the service's own usage engine, the way the terminal app does, and reads no provider itself. The browser connects to your computer directly, with no relay in between, so the computer has to be on and reachable over your network, a VPN, or a tunnel you set up. It is off until `augur config set web.enabled true` and a service restart, and it listens on `127.0.0.1:7420` until `web.host` and `web.port` say otherwise. `web.allowedHosts` adds host names, and `web.tlsCert` and `web.tlsKey` turn on https; see [docs/web.md](docs/web.md).
- [Visible] [Platform] [Security] **`augur web` prints the links that open the web app, and `augur web rotate` replaces its token.** Each link ends in `#token=`, and the page keeps the token in that browser and clears it from the address bar. The web token has its own file, apart from the owner and agent tokens, and anyone with it can do everything the panel does. A rotated token cuts off open pages within about 20 seconds.
- [Visible] [Providers] **Augur can sign in to Codex itself.** You open the sign-in link on any device, so a computer where the Codex CLI isn't signed in, or that has no browser, can still be metered. Augur saves only the refresh token in your operating system's key store and leaves the CLI's login alone while it has its own, so the two stop signing each other out. The Codex card in Settings has a Sign-in block for it.
- [Visible] [Providers] **`augur login codex`, `augur login status`, and `augur logout <provider>` do that sign-in from a terminal.** `augur login codex` prints a link and a short code and waits for you to approve it. Your ChatGPT account has to allow device-code sign-in in its security settings, and on a workspace account only the workspace admin can turn that on. `augur login status` lists every provider that has a sign-in, `augur logout` forgets only Augur's own session, and an agent's token can't sign in or out.
- [Visible] [Providers] [Platform] **You can add a sign-in for a provider on one computer with a `local-signin.mjs` file in the Augur folder.** The file exports `signInFlows`, which maps a provider id to a flow with `begin`, `complete`, and `renew` functions. Augur downloads never include it and updates never replace it, and the service logs at start which providers it added or why it couldn't load the file.
- [Visible] [Platform] [Security] **The macOS install script and `augur update` check a signature on the release's checksum list.** Each release carries `SHA256SUMS.txt.sig`, signed with the key the window app's updater trusts, and a list whose signature does not verify is refused.
- [Visible] [Providers] [Security] **Augur's Jev classifier can ask a Jev gateway instead of calling TypeSafe with your own key.** Set `decision.gateway` to the gateway's address, such as `http://127.0.0.1:8020`, and the gateway's key answers `augur pick --task`, with a token from `JEV_GATEWAY_TOKEN` when the gateway requires one. Sensitive and regulated task text still goes only to Laya.

### Changed

- [Visible] [Security] **School and course names for the student-text check now come from `private-terms.json` in the Augur folder.** The shipped list keeps only everyday words such as student, roster, and ferpa. Add your own terms as `{ "terms": ["..."] }`, or set `contentTerms` in the gateway settings. A hyphen in a term matches with or without it.
- [Visible] [Security] **The MCP server now has its own agent token.** With it an agent can run jobs, read their results, and add routes, but it cannot answer a pick, label a grade, change settings, or say that you named a model. The terminal app, the window app, and hooks still use your own token.
- [Visible] [Security] **On Windows, keys are stored for this computer only.** They no longer travel with a roaming profile. A key saved by an older version keeps its old setting until it is saved again.
- [Internal] [Platform] **The release workflow pins the Tauri build action to a specific commit.** That step receives the updater signing key, so it runs a fixed, known version.
- [Visible] [Providers] [Security] **`augur_route_add` accepts fewer route options and leaves routes for models already in the rules to you.** It refuses any option that names a program, arguments, a folder, an environment variable, or a header, `keySource` must be `store`, and a route for a model the rules already hold waits until you add it in the app.
- [Visible] [Platform] [Security] **Laya judges a browser request by the adapter it resolves to and refuses a body over 1 MB.** The adapters a browser may not use come from the registry's `browser_blocked_prefixes` list or `LAYA_BROWSER_BLOCKED_PREFIXES`, and a registry that cannot be read blocks every pilot request from a browser.
- [Internal] [Platform] **Workflow actions and tools are pinned to exact commits, and checkout no longer keeps its credentials.** Dependabot proposes updates to the pins each week.
- [Internal] [Providers] **Jev gateway usage summaries keep caller-supplied labels such as `__proto__` as plain keys.**

### Fixed

- [Visible] [Providers] [Security] **An API route no longer follows an http redirect.** A redirect would carry the route's key to another host, so the job fails with a message saying the endpoint redirected. Set the route's base URL to the address the redirect points to.
- [Visible] [Providers] [Security] **When a provider request that carries a key is redirected, Augur follows it only to an https or home-network address.** If the redirect goes to a different site, the headers and body stay behind. The home-network check now takes only a real private IPv4 address, so a host name that merely starts like one, such as `192.168.1.5.example.com`, no longer counts.
- [Visible] [Providers] [Security] **A job's working folder, prompt file, and attachments are checked at the place they really point to.** A symbolic link inside an allowed folder can no longer reach a file outside it, and a prompt file or attachment that sits in the service's data folder is refused.
- [Visible] [Platform] [Security] **Only your account can open the service's token file and socket.** On Windows the token file gets an access list that names only you, and on macOS and Linux the socket and its folder are created with no access for other accounts.
- [Visible] [UI] [Security] **The terminal app opens a web link without going through a shell.** A link with characters a shell would treat as commands is not opened.
- [Visible] [Platform] [Security] **`augur update` and the macOS install script install a release only when its version is a plain dotted number.** The version becomes part of file and folder names, so anything else is refused and nothing is installed.
- [Visible] [Providers] [Security] **Grading text that mentions students is always graded at the regulated tier.** A lower tier declared by the caller no longer overrides it.
- [Visible] [Providers] [Security] **A provider added by `augur profile import` starts from the cautious starter rules.** Its models see public data only and must be named before use, unless the file sets other values.
- [Visible] [Providers] [Security] **A balance edit whose path names `__proto__`, `constructor`, or `prototype` is refused.** The answer says the name is not a balance setting.
- [Visible] [Providers] [Security] **The Jev gateway keeps requiring tokens when `host` is edited after it starts, and its health check no longer runs the key command.** With tokens off it also answers only connections from this computer, whatever the Host header says.
- [Visible] [Sync] [Security] **The phone ignores a sync update older than the last one it applied, and each update is tied to its pairing.** A relay can no longer roll the phone back to an old reading or hand it another pairing's data. A desktop whose clock moves backwards sends updates the phone ignores until the clock passes the time of the last one.
- [Visible] [Sync] [Security] **A pairing link opened in the phone's browser asks before it sets the phone's relay.** A scanned code asks only when it would replace a working pairing, and a relay has to use https or sit on your home network.
- [Visible] [Sync] [Security] **Unpairing a phone also deletes the desktop's push notification key.** A push subscription the phone still holds stops working, and a new pairing makes a new key.
- [Visible] [Security] **Login files the service renews for Claude Code, Codex, and Grok are written readable by your account only.** On macOS and Linux the file gets owner-only permissions, in a folder only you can open when the service creates it.
- [Visible] [Platform] [Security] **Cancelling a job on macOS, or on Linux without systemd, also ends processes that left the job's process group.** The service follows the job's descendants about once a second, so a process that starts and detaches between two looks can still be missed.
- [Visible] [UI] [Security] **A balance shows its currency only when the provider sends a plain currency code.** Any other text in that field is left off.
- [Visible] [Providers] **The Claude card now says when the saved Claude Code login can no longer be renewed.** Once another Claude Code sign-in replaces the refresh token in `~/.claude/.credentials.json`, the card reads "The saved Claude login was refused, so Augur cannot renew it. Sign in to Claude Code again." in place of "Provider returned HTTP 400" beside numbers that had stopped updating.
- [Visible] [Security] **Fit scores for student-related task text come only from a decision backend on this network.** When no local backend is available, those scores stay neutral at 0.5.
- [Visible] [Security] **The control endpoint answers a request that is not a JSON object with an error.** The service keeps running and handles the next request normally.
- [Visible] [Security] **Rule sync skips a policy stamp that names a field the rule does not have.** The remaining stamps from the other device still merge.
- [Visible] [Security] **The phone and browser app opens provider links only when they use http or https.** Links with any other scheme do nothing.
- [Visible] [Security] **Desktop commands that read or write files, run the dispatch CLI, set the hotkey, or talk to the service now answer only the app's own popup window.** A provider page open in a sign-in window cannot call them.
- [Visible] [Providers] **Codex, Copilot, and API jobs no longer count their reasoning tokens twice.** Those harnesses already include reasoning in the output count, so their output totals, characters-per-token calibration, and derived costs drop to the true figure. Costs a provider reports itself stay the same.
- [Visible] [Providers] **The Jev gateway now notices when you break its settings while it runs.** If an edit leaves the settings file broken or sets a bad value, the gateway writes it to its log when it rereads the file, instead of saying nothing until the next restart.

## [1.10.1] - 2026-10-13

### Fixed

- [Visible] [UI] **Signing in to TypeSafe or Claude with Google no longer fails partway through.** The sign-in window stays open and in front until you finish, and Augur checks your account only after you come back from Google. Closing the window still refreshes your numbers right away.
- [Visible] [UI] **The phone app now opens on a Pair with your desktop screen when nothing is saved yet.** It used to open the eight-step setup, and on an iPhone the home-screen app showed that setup every time, because it keeps its storage apart from Safari and never saw a pairing made in Safari or with the Camera app. The new screen has a Scan pairing code button, which used to be only in Settings, and a Set up without a desktop button for a phone you use on its own. On an iPhone, Safari tells you to add Augur to the home screen and scan in there, and the web app now asks the browser to keep its saved data each time it opens, so a phone low on space is less likely to drop the pairing.
- [Visible] [Platform] **Adding the Augur web app to a home screen or installing it now gives it the Augur icon.** Some browsers and phones used to show a letter tile, because the page linked only the Apple touch icon and `/favicon.ico` and `/apple-touch-icon-precomposed.png` came back 404. The page now links PNG icons too and has the favicon and touch icon built in, which helps on phones that fetch home-screen icons apart from the page. Both files are at the site root as well, the manifest has an `id` and marks its icons for any purpose, and the icons stay cached for an hour.

## [1.10.0] - 2026-10-11

### Added

- [Visible] [Providers] **The opencode-sbx adapter takes an `effort` route option.** Set it in routes.json, for example `options: { effort: "high" }`, and OpenCode receives it as its reasoning variant. OpenCode's variants stop at `high`, so `xhigh` is sent as `high`. The option is for routes that run OpenCode inside a Docker Sandbox, such as DeepSeek, and a route without it runs as before.
- [Visible] [Providers] **Augur can watch a Cogitator gateway.** Cogitator serves models from your own machines, and Augur now reads it every 30 seconds to see which machines are up and which one is handling each role, along with the models each machine has loaded. It needs the gateway's address, which is `http://127.0.0.1:8470` unless you change it, and a Cogitator key with the manage scope saved as the Manage key. If the gateway goes quiet, Augur keeps showing the last reading and marks it stale, and a missing or wrong key gets a message that says what is wrong with it.
- [Visible] [UI] **A Cogitator card sits on the dashboard and the phone.** The card says how many of your machines are up and gives each role a chip, so `summarize Bilbo, degraded` means a backup machine is covering for one that cannot, `embed cold` means the model is installed but not loaded, and `transcribe down` means nothing can do the work right now. On the phone the card keeps it short and lists only the machines and any degraded roles.
- [Visible] [UI] **The Local page shows what each machine is doing.** Open on the Cogitator card leads there in the window app, where each machine has a memory bar and a line such as "40 of 64 GB free, 2 models loaded", and picking a machine lists its models, loaded ones first. Further down are the roles with the machine serving each one, then the recent jobs your gateway ran. The terminal app has the same page on a Local tab after Balance.
- [Visible] [Providers] **API routes can talk to a local gateway.** On an `openai-api` or `anthropic-api` route, set `requestClass` to `cogitator` and background jobs go out at low priority, while a job you start at the terminal or mark urgent goes at normal priority. The routes also take `headersJson` for extra request headers, `maxInput` to cap how much text a route accepts, and `maxImageMb` and `maxAudioMb` to cap file sizes, and an `openai-api` route has a `mode` option for embeddings or transcription.
- [Visible] [Providers] [Security] **An API route can use plain http inside your home network.** A `baseUrl` that starts with `http://` is accepted for this computer or another machine on your home network, and any other address still has to use https.
- [Visible] [Providers] **You can send files with a job.** Add `--attach <file>` to `augur run`, once per file, or pass `attachments` to `augur_run`, and an API route sends them along with the prompt, up to 16 files a job. Text goes into the prompt, images go to models that can see them, and one audio file goes to the transcription endpoint for a `transcribe` job. Augur refuses the job as `attachment_rejected` when a file sits outside the working folder or a prompt folder, is a type it does not send, is over the size cap, or does not suit the route, and a refused job, like one over `maxInput`, moves on to the route's fallback routes unless you pass `--no-failover`.
- [Visible] [Providers] **Augur has new activities for work local models handle well.** You can now pick and run `embed`, `transcribe` and `translate` jobs. An embeddings route saves its vectors to `vectors.json` in the job folder, and a transcription route gives back the text of the audio you sent.
- [Visible] [Providers] **You can mark a job as urgent.** Add `--urgent` to `augur run` or `urgent` to `augur_run`, and a route pointed at Cogitator asks for normal priority in place of the low priority background work gets.
- [Visible] [Providers] **Picks follow what your local machines can do right now.** A model listed under the cogitator provider is skipped while its machine is down, while no machine can serve its role, or while the gateway cannot be reached. A model that is installed but not loaded counts for 0.7 of its usual score, one on a machine short of memory counts for 0.8, and a model with both problems gets both cuts. Hosted models pick as before, and the reason under each pick says when one of these applied.
- [Visible] [UI] **A job shows which machine ran it.** When a gateway serves a job, the Jobs page, the terminal app's job view, and `augur jobs` show where it ran, for example "Served by: bilbo, link 2, a fallback".
- [Internal] [Providers] **Existing rules still pick the same way.** The new activities only add entries, and golden fixtures check that every existing `policy.json` picks as it did on 1.9.0.

### Changed

- [Visible] [UI] **Augur has a new icon.** It shows a lituus, the curved staff an augur carried, inside a glowing mint ring with gold accents, with a small hawk and mist against a night sky. The new icon replaces the old one in the app and its installer, the Windows tiles, the Mac icon, the phone home-screen icon, and the browser tab, and the phone app has its own padded version for Android's round and squircle crops. The live percentage ring in the tray stays as it was.
- [Visible] [UI] **The terminal app's Settings and Setup tabs moved to 7 and 8.** The new Local tab sits after Balance, so the number keys now run from 1 to 8.

### Fixed

- [Visible] [Providers] **`augur provider add` and the Add provider form in the window app now save the new model under the same `<provider>/<label>` name its route uses, such as `cogitator/judge`.** Earlier versions saved the bare label instead, so the route failed every job with unknown_model ("cogitator/judge is not in policy.json") until the model was renamed by hand. The confirm message and the form's plan list show the full name, and a model that was already in the rules keeps its label.

## [1.9.0] - 2026-10-11

### Added

- [Visible] [Providers] **Codex, Grok and other providers with a usage window now have their own pace.** Each one is checked against its 5-hour and weekly windows the way Claude is, so a provider that runs hot leans to its light models and one that runs behind leans to its strong ones. When a window reaches its reserve, the provider's optional work goes to another subscription, and only Claude's reserve sends work to a backup route such as Copilot.
- [Visible] [Providers] **Pace settings sit in one block per provider.** `pace.<provider>` holds `band`, `reserve`, `hot`, `behind` and `boost`, and a provider with no block uses the built-in values. The older `claude.*` settings still work, and the first save of the rules moves them into `pace.claude` and marks the balance section as schema 2.
- [Visible] [Providers] **A provider with allowance left gets a boost.** Its routes score up to 1.5 times higher at a fresh window, less as its fullest window fills, and no higher over the last 10% of that window. A hot provider, one at its reserve, and a route the caller rated below `boostFitFloor` (0.6 by default) get no boost.
- [Visible] [Providers] **Picks are drawn from the odds.** Each route's odds are its score over the sum of the scores still in the draw, so a Preferred route at 2.5 wins against a Normal one at 1.0 about 71% of the time, and a named model always wins. `draw.enabled` turns the draw off, `draw.tail` sets how far under the top score a route drops out, and each pick records its odds, whether it was drawn, and the seed.
- [Visible] [Providers] **A pick can ask for the top score or mark a snippet.** `--best` on `augur pick` and `best_only` on `augur_pick` take the top score. `--snippet` and `snippet` mark a draft of one sentence or one bullet, which is not held to the Opus routes.
- [Visible] [Providers] **`augur pick-preview` shows every route's odds without drawing.** It takes the same arguments as `augur pick`, prints `preview: no draw made` and records nothing, and `augur_pick_preview` shows the odds as well.
- [Visible] [UI] **The balance report has a pace row for each paced provider.** The providers that need attention come first, each with its windows against pace, its boost and its rough odds. Providers on pace share one group, and those with no usage window are named under Not paced.
- [Visible] [Providers] **Jobs can start with standing instructions.** A charter folder (`runner.charterDir`, or `charter` in `~/.augur`) holds `core.md`, a file per harness under `engines` and packs under `packs`, and the service puts them in front of every job's prompt except on Hermes. `charter.json` adds packs by rule, and without it write and full jobs get the `code` pack. `--pack` and `--no-charter` on `augur run`, and `packs` and `no_charter` on `augur_run`, choose per job, and the Service page has a Charter folder setting. With no charter folder, prompts go out unchanged.
- [Visible] [Providers] **Codex and Copilot can leave out their own extra context.** Setting Harness context (`runner.ambient`) to `trim`, or a route's `ambient` option, turns off Codex's optional features and Copilot's custom instructions and built-in MCP servers, so a job spends fewer input tokens. The default is `keep`, which changes nothing.
- [Visible] [Providers] **A failed job can run again on a fallback route.** With Retry on failure (`runner.failover`) on, a job stopped by a spawn error, a provider limit or a read-only timeout is submitted again on its route's fallback list, up to three jobs in a chain. A write or full job is retried only for a limit that left no answer and no change. `augur wait`, `augur result`, `augur run --wait` and `augur_job` follow the chain, and `--no-failover` stops the retry as well as the fallback at submit. The setting is off by default.
- [Visible] [Providers] **Grok and Codex routes keep a named conversation.** `augur run --conversation <name>`, or `conversation` on `augur_run`, opens a session on the route, and later jobs with that name resume it. A conversation stays on its route, runs one job at a time and never moves to a fallback, and a resumed Codex conversation keeps its first turn's tool tier. `augur conversations` lists them and `--forget <name>` drops one.
- [Visible] [UI] **The window app and the terminal app have a setup interview.** A new install opens on it in place of the old settings screen, and Run setup again in Settings opens it later with the current settings filled in. Its steps cover the starting stack (Claude only, several subscriptions, API keys only, or a profile file), the providers and keys, how much of each subscription to hold back and which to use first, pay-per-use spending, and what each model is good at, while a summary lists every setting the answers touch. Nothing is saved until Apply, and a step left alone changes nothing. The last step tests each route that has a key and lists the models still waiting for confirmation.
- [Visible] [Platform] **A profile carries model rules.** `augur profile export` adds a `models` section with each model's id, name, activities, data tier, ask first, output, sandbox, effort, cost and data handling, and leaves out its status, pause, notes, thresholds and any field it inherits from its provider. `augur profile import` checks the whole file first and writes nothing if one entry is wrong. It then adds only the models this install lacks, unreviewed with their rules filled in, so none of them runs until you confirm it in Model rules. A model already here is left as it is and named in the summary, and a provider this install does not know is added for its rules alone. The file stays schema 1, and a profile with no `models` section imports as it did.
- [Visible] [Providers] [Security] **An agent can add a route with `augur_route_add`.** The tool adds one route and, when asked, its model and a balance reading for a provider that has none. The model arrives unreviewed, and the balance reading stays off until its key is set. A key is never accepted: an option whose name or value looks like a key is refused, as are a route name that already exists and an adapter the service does not have, and a refused add writes nothing. At the Ask me for everything approval level the add is held and nothing is written. The result names the host the route sends its requests to and says that you confirm the model in Model rules and set the key with `augur key set <route>`.
- [Visible] [Platform] **Laya gives its video memory back while a game runs and after 10 minutes with no request.** The server watches for the programs named in `LAYA_GAME_PROCS`, the two ARK Survival Ascended programs by default, and unloads the model `LAYA_GAME_UNLOAD_S` seconds (5 by default) after one starts. With no request and no job in flight for `LAYA_IDLE_UNLOAD_S` seconds (600 by default, and 0 turns it off), it unloads as well, and an idle server then holds about 0.2 GB of video memory in place of about 6 GB. While a game runs the server reports busy and clients use another one. After the game closes or after an idle unload, `/load` reports ready with the model out of memory, and the next request loads the model before it answers. An unload because other programs keep the card busy still reports not ready, and the model comes back by itself once the card is free. `/load` also reports `unload_reason` (`busy`, `game`, or `idle`), `idle_s` (seconds since the last request), and `requests` (how many requests the server has taken).

### Changed

- [Visible] [Providers] **A default install picks differently from 1.8.0.** The boost, the draw and the pacing of providers other than Claude apply to every install, including one that names no profile, so the same task can now go to a different model than it did on 1.8.0. Setting `pace.<provider>.boost` to 1 turns off that provider's boost, and setting `draw.enabled` to false makes every pick take the top score.
- [Visible] [Providers] **Each provider that serves Opus has its own prose switch.** Prose drafting leaves a provider's Opus route while that provider runs hot and another Opus route can take the work, where before only Claude had the switch.
- [Visible] [Providers] **Figures from a provider read less often count for longer.** A provider's figures are ignored once they are two hours old, or one and a half refresh intervals old when the provider is read less often than that, and they are flagged as old after 20 minutes or one and a quarter intervals. Jev's balance, read once a week, is now weighed in picks until the next read, where before it read "not weighed" two hours after each read. A provider with no known refresh interval keeps the 20-minute and two-hour limits.
- [Visible] [Security] **`augur key set <route>` shows where the key will go.** When the route has a `baseUrl`, the prompt and the message after the key is saved name the host the key is sent to, so the address can be checked before the key goes in.

## [1.8.0] - 2026-10-10

### Added

- [Visible] [UI] [Providers] **The Routes page adds a provider in one form.** Add provider, beside Add route, lists OpenAI, OpenRouter, Anthropic, TypeSafe and any other OpenAI-style or Anthropic-style API, and the plan under the form shows what will be added as you type. It makes the same changes as `augur provider add`, with the same checks: the route, the model waiting in the rules for your confirmation, the key in the key store, and the built-in balance reading for OpenRouter and Jev. The key can be left empty and saved later, and the terminal app has the same form on its Routes screen.
- [Visible] [Providers] **Prose drafting moves to Copilot while Claude runs hot.** Once Claude gets well ahead of its pace, Augur sends prose writing to Opus 5.5 on Copilot instead, and sends it back when Claude is on pace again. Only prose drafting moves, and a Claude route you ask for by name still runs. If Copilot has reached its $250 cap, prose goes to the next route that can write it, such as ChatGPT on the web, and the pick says why. It never falls back to Sonnet, and it stays on Claude when nothing else can take it. The balance report shows where prose is going, and the switch can be turned off in the balance settings.

### Changed

- [Visible] [UI] **A window at 99% or more reads "Spent".** The pace text in the window and terminal apps used to call a full window "Ahead of pace". The balance report and pick reasons also say "spent" at that point, where they said "N points ahead of pace".

## [1.7.0] - 2026-10-05

### Added

- [Visible] [Providers] **Each pick that lands on Copilot is listed with the month's spend.** The pick log in the balance report names the time, the kind of work, the model and what Copilot's month stood at when the pick was made, and marks the ones past the $150 aim.
- [Visible] [Providers] **A web route comes with a fixed folder.** The steps for a ChatGPT or Gemini route name `~/.augur/web/<kind of work>-<date and time>/`, with `brief.md` for the task and `result.md` for what the route returns, so the session that asks and the one that reads the answer look in the same place.
- [Visible] [Providers] **Every pick has one row of labels for the local model.** `augur label <pick or job id> --brief met|partly|missed` records how a job's report met its brief, beside the pick in the decision log. The service writes `~/.augur/balance/labels.jsonl` hourly, one line per pick with the model picked, the models its jobs used, whether any differed, how each job ended and the brief result, and no task text.
- [Visible] [Platform] **Each release carries ready Arch recipes.** `PKGBUILD-augur-bin` and `PKGBUILD-augur-terminal` are attached to the release with their checksums filled in after both were built and installed in a clean Arch container, so `makepkg -si -p PKGBUILD-augur-terminal` is the whole install and no checkout is needed.
- [Visible] [Platform] **On Arch, the window app leaves updates to pacman.** The app and `augur update` now say that pacman installed Augur and how to update it, where the app offered an install button that would have tried to install a `.deb`. The package marks itself with a file the app checks for.
- [Visible] [Providers] **A new install starts on a neutral balance.** The `neutral` profile has one tilt: it moves work between Opus and Sonnet as Claude runs ahead of or behind its pace. Before, every install got the shipped rules for one particular stack, with Opus and Sol for deep work, Luna and Sonnet for the rest and Copilot as a backup. Existing installs keep those classic rules unchanged, and `profile` in the balance settings switches between the two.
- [Visible] [Providers] **Balance rules can name a model by its provider and model id.** `codex/gpt-6.1-sol` works anywhere `codex/sol` does, so rules written on someone else's install fit yours even when the labels differ. A `*` in a name matches any text, as in `claude/*opus*`, and a rule written against your own label still takes precedence.
- [Visible] [Providers] **`augur key set <route>` saves an API key from your own terminal.** It asks for the key with the typing hidden, reads the environment variable you name with `--env`, or reads standard input, and saves the key in the same store the Routes page uses, so a key never has to pass through a chat. A key typed on the command line is refused. `augur key status <route>` says whether a key is saved without printing it.
- [Visible] [Providers] **The Jev provider has a Base URL setting.** Left empty, the provider uses TypeSafe. Any service that answers the same `/v1/systemone` request can go there instead, reached over https, or over http when it runs on this computer. The web app can only reach TypeSafe.
- [Visible] [Security] **You choose how many of an agent's rule edits wait for you.** A setting on the Service page and the terminal app's Service screen has three levels: ask for everything, ask for risky edits, or apply everything. Ask for risky edits is the default and matches what Augur did before. An agent cannot read or change the setting.
- [Visible] [Providers] **An agent can adjust the balance.** `augur_policy_edit` accepts a balance setting as `field: "balance"` with a `path` and checks the path and the value against the documented settings. At the default approval level the change applies within a minute. Each change is recorded in the history, and `augur_pick_preview` can try it first.
- [Visible] [Platform] **`augur profile` moves a setup between computers.** `augur profile export` writes the balance settings and routes to a file that holds no keys. `augur profile import` checks the file, applies the balance settings under the same approval setting as an agent's edits, and adds the routes whose names are new.
- [Visible] [Platform] **A Claude Code plugin with setup, pick and balance skills.** The mod Augur installs into Claude Code now carries three skills. `/augur:setup` asks a few questions and makes the balance and route changes through `augur_policy_edit`, `/augur:pick` asks Augur which model should take a task, and `/augur:balance` shows what the balance is doing. The plugin also starts `augur-mcp` for the Augur tools. A marketplace file in the repository lets `claude plugin marketplace add neostryder/augur` and `claude plugin install augur@augur` install it without the app.
- [Visible] [Platform] **An optional note before each Claude Code subagent.** When the plugin option Note Augur's pick before each subagent is on, a hook adds a note naming the model Augur would pick for the subagent and which way the balance leans. The hook changes nothing else, and it sends the service the subagent's one-line description, never its prompt. The option is off by default, and the command behind it is `augur claude hook subagent`.
- [Visible] [Platform] **The Claude Code status line shows Claude's pace.** After the two windows the line adds `hot +8`, `behind -12` or `on pace`, measured against the band in your rules the same way the balance does it. The pace is left out when Augur's numbers are stale.
- [Visible] [Providers] **`augur provider add` adds an API of a standard shape.** Give it a preset (`openai`, `openrouter`, `anthropic`, `typesafe`) or a shape (`openai-style`, `anthropic-style`, `jev-style`), a route name, a model and a key. It adds the route and puts the model in the rules to wait for your confirmation. If you give the address of the API's balance and the path to the amount, it also adds a balance reading. `--dry-run` shows the plan first, and the key never goes on the command line.
- [Visible] [Providers] **A provider can be added for its rules alone.** A provider with no usage reading appears on the Rules page and in `policy.json`, so the model behind a route to an API that publishes no balance can have its rules set like any other.
- [Visible] [Docs] **A guide to the settings and files.** `docs/configuring.md` covers where the rules, routes and balance settings live and how to add a provider and a route. Its tables of every balance setting and adapter option are drawn from the code, and a test fails when a table and the code differ.
- [Visible] [Docs] **A guide to adapting Augur.** `docs/adapting.md` and `AGENTS.md` give the steps for adding a provider plugin, an adapter or a local adapter, the rules every change keeps, and the checks to run. `pnpm docs:update` rewrites the generated tables.
- [Internal] [Docs] **Docs move with the code.** The pull request template asks which docs changed, and a test pins the shipped balance defaults to a fixture so an install that names no profile keeps resolving to the same rules.

### Fixed

- [Visible] [Providers] **The balance report counts Claude's week once.** Fable's own weekly window was listed as a second week and always read as far behind pace. The report and the pick now use only the windows that cover the whole subscription, and "1 points" reads "1 point".

## [1.5.0] - 2026-10-04

### Added

- [Visible] [Providers] **A pick weighs how hard the task is.** Coding and hard reasoning lean toward Opus, Sol and Grok, and the rest lean toward Sonnet, Luna, DeepSeek and MiniMax, with Opus kept ahead for prose. Fable and Astra are skipped unless named, and a route gets a small lift on what it is known for: MiniMax on long context, Luna on review, ChatGPT on research. `--depth deep|everyday` overrides the default, each pick ends with a line giving the reason, and a `balance` section in `policy.json` changes or switches off the rules.
- [Visible] [Providers] **Picks keep Claude on pace.** If the week or the 5-hour window is running more than 5 points ahead of the time that has passed, Sonnet is favored over Opus, and if both are running more than 5 points behind, Opus is favored. Once a window hits 90%, optional work goes to other routes when any can take it. If Claude's figures are missing or old, the pick says it could not check.
- [Visible] [Providers] **Backup routes wait their turn.** A pick skips Copilot models, and DeepSeek on coding tasks, while any other route can do the work. Copilot's Anthropic models only come in when Claude is at 90%. Once Copilot's month passes $150 the pick says so, and at $250 it stops offering Copilot.
- [Visible] [Providers] **Picks can suggest more than one model.** Most picks also suggest MiniMax for a second look. Research and image tasks suggest a free ChatGPT or Gemini route with the steps to follow, and tagging and typed decisions go to Jev first. Each pick also names the local Laya model as a shadow, so its answer can be compared with the pick's.
- [Visible] [Providers] **`augur balance` shows what the router is doing.** It prints where each kind of work goes now, Claude's pace, Copilot's spend and the last few days of picks, and the `augur_balance` tool returns the same. The service also saves a copy each day in `~/.augur/balance`.
- [Visible] [UI] **A Balance page in the window app and the terminal app.** It shows the same report as `augur balance`, and nothing on it can be changed. Each provider on the Rules page also carries a chip with its stance: kept on pace, used up first, backup or free. The terminal app's Settings page moves from key 5 to key 6.

### Fixed

- [Visible] [Platform] **The service log records how the service stopped.** It used to log every start and no exit, so a service that had died looked the same as one that never ran. Each exit now writes a line with its exit code, and an uncaught error or a stop signal writes its reason first. A kill the service cannot catch, such as an end-task from outside, still leaves no line. The terminal app also starts the service again when it is lost while the app is open.

## [1.4.0] - 2026-10-04

### Added

- [Visible] [UI] [Platform] **A full-screen terminal app.** Run `augur` in a terminal to open it. It has Usage, Alerts, Rules, Dispatch and Settings pages that show the same things as the window app in the same words, and it needs no tray or taskbar. It runs on Linux, macOS and Windows, and it draws the phone pairing code in the terminal.
- [Visible] [Platform] **Status, refresh and alerts from the command line.** `augur status` prints Claude's session and week, anything running hot and the alert count, and `augur status --waybar` prints the same as JSON for a status bar. `augur refresh` reads every provider now, `augur alerts` lists alerts and dismisses them, and `augur claude install|remove code|desktop` adds or removes Augur's part of Claude Code and Claude Desktop.
- [Visible] [Platform] **Running jobs for agents on macOS and Linux.** Dispatch, routes and the MCP server work on all three systems. Cancelling a job or reaching its time limit ends everything it started, through a systemd user scope on Linux where systemd runs and the job's process group otherwise. A route's key is kept in the macOS Keychain or the Linux Secret Service, with a file only you can read as the fallback.
- [Visible] [Platform] **Start the service at login.** `augur service enable` starts the service at each login through a systemd user unit on Linux or a launch agent on macOS, and `augur service disable` turns that off.
- [Visible] [Platform] **Packages for Arch Linux.** `augur-terminal` installs the terminal app and the service on their own and needs only Node.js 24 or newer. `augur-bin` installs the window app from the release's `.deb` and puts the command on the PATH as `augur-cli`.
- [Visible] [Platform] **A macOS install script and `augur update`.** The script installs the terminal build, which carries its own Node, after checking it against the release's checksums. `augur update` installs a newer version the same way and keeps the previous one.
- [Visible] [Alerts] [Platform] **Notifications on Linux and macOS from the service.** Alerts sent to your computer's notifications use `notify-send` on Linux and the system notification center on macOS.
- [Visible] [Platform] **Claude Desktop chat works on macOS.** The switch under Claude in Settings is available on macOS, and on Linux where Claude Desktop's settings folder exists.

### Changed

- [Visible] [Platform] [UI] **One service does the work for every view.** Refreshes, alerts, phone sync and rule edits run in the Augur service on every platform, and the window app and the terminal app both show what it reports. Either one starts the service when it opens, and an idle service from 1.3 is replaced on upgrade. Usage only is enforced by the service, which refuses jobs until Also run jobs is on.
- [Internal] [Security] **The window app no longer reaches the network, the keychain or login files itself.** Its commands for HTTP requests, the keychain, secrets and history files are gone, and the file commands allow only the routes file.
- [Internal] [Platform] **CI runs the tests on Windows, Linux and macOS** and builds the terminal package on Linux and macOS. A release builds both Arch packages and checks them against the release's files.
- [Visible] [Docs] **The README and the MCP page cover the terminal app and the macOS and Linux installs.**

### Fixed

- [Visible] [Platform] **Updating on Windows no longer stops on augur-node.exe.** An open Claude session restarts Augur's MCP server right after the installer stops it, which locked the file and made the update ask to retry. The installer now moves the old file aside instead of overwriting it.

## [1.3.0] - 2026-10-03

### Added

- [Visible] [UI] **Pin the panel to keep it on screen.** The pin button in the new strip at the top of the panel keeps it open and on top when you click elsewhere. While it is pinned, drag the strip to move the panel. Augur remembers the pin and the spot after a restart, and opens the panel at the tray instead if that monitor is gone. Esc or a click on the tray icon hides a pinned panel without unpinning it, and a pinned panel keeps its top edge in place when its height changes.
- [Visible] [Alerts] **Alerts stay under a bell until you dismiss them.** The bell in the panel's top strip shows how many alerts are waiting and opens a list of them. Each alert stays until you dismiss it or it stops applying, such as when its usage window resets or the models it named have been reviewed. Dismissing an alert clears it everywhere Augur shows it.
- [Visible] [Alerts] **Choose where each kind of alert goes.** Settings has a grid of alert kinds against your computer's notifications, the bell, Claude Code and your phone. Updates and failed refreshes now go to the bell only by default, so they no longer raise a notification.
- [Visible] [Sync] [Alerts] **A paired phone shows the same alerts and can get push notifications.** The phone app shows your computer's alerts under its own bell, and dismissing one there clears it on the computer too. Turn on Push notifications in the phone's Settings to get alerts while Augur is closed, on Android or on an iPhone with Augur added to the Home Screen. The computer encrypts each push for the phone, so the relay never sees an alert.
- [Visible] [Alerts] **A Claude Code mod shows your usage and Augur alerts in your sessions.** Turn on Claude Code under Claude in Settings. New sessions show Claude's session and weekly use in the status line, along with any other provider past 70%, and a new alert pops up as a toast. The newest alert sits in a row above the prompt with a Dismiss button, which clears it in Augur and on your phone too, and an Open Augur button. The mod reads the usage file, so turning it on also saves your usage to .augur/usage.json if no file was set.
- [Visible] [Platform] **Connect Claude Desktop to Augur from Settings.** On Windows, the Claude Desktop chat switch adds Augur's MCP server to Claude Desktop's config, so its chats can pick and run models through Augur. Turning it off removes only that entry. Restart Claude Desktop after either change.

## [1.2.3] - 2026-10-01

### Fixed

- [Visible] [UI] **A provider's defaults list each choice once.** Most sensitive data showed Public twice, and Output, Cost and the Yes/No fields repeated their default the same way. The default now shows as the selected choice. A model's own rules still offer "Default (...)", because a model inherits from its provider.
- [Visible] [Providers] **Refresh now rereads your Claude limit resets.** The claude.ai reading is kept for six hours, and Refresh used to hand back that kept copy, so a reset you had just spent still showed as available. Refresh, F5 and a settings change now read the page again; the scheduled refresh still uses the kept copy. The TypeSafe balance behaves the same way.

## [1.2.2] - 2026-10-01

### Fixed

- [Visible] [Platform] [Security] **Rule edits asked for through the MCP server now reach the app.** The app was refused when it read the edit inbox and wrote its results, so a queued edit was never applied or held for you. The two files are now on the list of files the app may use.
- [Visible] [Platform] **A Windows update no longer stops on augur-node.exe.** The installer ends the MCP servers that open Claude sessions run from that file, once the service is stopped with no job running, so the update completes without closing them by hand.

## [1.2.1] - 2026-10-01

### Added

- [Visible] [Platform] [Security] **The MCP server can read the rules and ask for changes to them.** `augur_policy` returns every model's fields, `augur_policy_edit` queues weight, pause, note and hold-rule edits that the running app applies within a minute, and `augur_pick_preview` ranks the models with edits applied first. Edits to data tier, ask first, output, sandbox, cost, status, data handling and limits wait in Model rules until you accept them.
- [Visible] [UI] **The panel opens on the usage view when Augur starts.** Turn off Open the panel at launch in settings to keep Augur in the tray until you open it.

### Fixed

- [Internal] [Platform] **A release can be published for a tag that adds a workflow file.** GitHub's automatic workflow token cannot create a release for the first tag that adds a workflow file, so the installer jobs failed with a 403 on v1.2.0. For such a tag, create the release first with `gh release create <tag> --verify-tag --prerelease`, re-run the failed jobs so they attach the installers, then mark the release as latest.

## [1.2.0] - 2026-09-30

### Added

- [Visible] [UI] **The phone app refreshes when you pull down from the top.** A pull reads every provider again, pulls the desktop's latest numbers, checks for newer app files and reloads.
- [Internal] [Platform] **Each release deploys the web app and relay.** A workflow builds the web app from the tag and runs the relay's deploy with a Cloudflare token and the relay config kept as repository secrets, so a phone that opens the app gets the release's files.
- [Visible] [UI] **Settings show when a claude.ai or TypeSafe session is signed in.** The Sign in button reads Sign in again and a Signed in label appears once the provider has read your account.

### Changed

- [Visible] [UI] **The panel always opens on the main usage view.** Opening Augur from the tray icon, the taskbar or the keyboard shortcut closes any settings page or detail left open, instead of returning to it.

## [1.1.2] - 2026-09-30

### Added

- [Visible] [Alerts] **A notification says when a plan is spent and a limit reset is in hand.** It fires once per window for providers that report resets, such as Codex, and for Claude once its count is entered or read.

### Changed

- [Visible] [Providers] **A spent provider with a limit reset in hand keeps the models waiting on it held.** Copilot's GPT-6 Sol stays out of picks while Codex is spent but has a reset left, and the pick says to use the reset. Once the resets are gone, the waiting model runs.

### Fixed

- [Visible] [Alerts] **Alerts stop repeating every few minutes.** Providers report a window's reset time a little differently on each refresh, and each new time counted as a new window. Alerts whose windows end within five seconds of each other now count as one, a pace alert repeats at most once a day while it holds, and keys older than 30 days are dropped.

## [1.1.1] - 2026-09-30

### Added

- [Visible] [Providers] **Augur reads your Claude limit resets from claude.ai.** Turn on Read resets from claude.ai in Claude's settings and sign in once. The dashboard then shows how many resets are left and when the first ends, and the pace math counts them. The page is read about every six hours, and the entered count is used when the reading is off or fails.

## [1.1.0] - 2026-09-30

### Added

- [Visible] [Providers] **A model can wait until other models are spent.** On the Model rules page, Use only after lists the models that must be spent, paused or down before this one is picked. Their providers are used up in full instead of paced, so Codex runs to its limit before Copilot's GPT-6 Sol is chosen. A major or critical outage on a provider's status page counts as down, and a minor incident does not.
- [Visible] [Providers] **Limit resets in hand count as more room.** A provider that reports resets, such as Codex, is no longer slowed for running ahead of pace while one is left, and a pick notes when a spent provider still has a reset waiting. Claude's API does not report its resets, so its provider settings have a Limit resets in hand field.

### Fixed

- [Visible] [Providers] **The Codex status badge follows the Codex components on OpenAI's status page.** An incident in ChatGPT Space Pages or another OpenAI product no longer shows Codex as degraded.

## [1.0.0] - 2026-09-29

### Added

- [Internal] [Platform] **The service loads adapters from a folder beside it that no release includes.** One runs only when `config.json` lists its id, and neither the settings pages nor `augur config` offer it.
- [Visible] [UI] **A route can have a budget.** On the Routes page or in `routes.json`, set dollars, jobs or both for a day, week or month. Once a limit is reached, new jobs on that route are refused with the limit named, and `augur usage` shows how much is used. Dollars count only jobs whose cost is known.
- [Visible] [UI] **A route can list fallback routes.** When a job is refused because of a budget, a pause, plan usage or a missing key or adapter, Augur tries each fallback in order and checks it against every rule. The job records which route took it, and `augur run --no-failover` keeps a job where it was sent.
- [Visible] [Security] **An API route can keep its key in the Windows credential store.** You save the key on the Routes page instead of naming an environment variable. It is never written to `routes.json` or a job record, and the route cannot run until a key is saved.
- [Visible] [UI] **A new provider starts with cautious rules that its models inherit.** Public data only, text output only and named before use, with no activity allowed and every model unreviewed. A model can be used only after you confirm it and allow what it needs, and setup says so. Providers already in your rules keep what they have.
- [Visible] [Security] **Each release lists a SHA-256 checksum for every installer and attaches a bill of materials for its JavaScript and Rust dependencies.** The README shows how to compare a download against its checksum, which matters while the installers are unsigned.
- [Visible] [Docs] **The README now covers model rules, running jobs for agents and the choice of Jev or Laya, with the steps to install Laya on your own computer.** The MCP server and the token and cost figures each have their own page under `docs/`, and SECURITY.md describes what the MCP server can and cannot do.
- [Visible] [UI] **Jobs show tokens and cost, and each figure says whether it was reported, derived or imputed.** A cost comes from a rate you list in `dispatch/rates.json` and the tokens the harness reported, and a job whose cached tokens have no listed price gets no cost. Where a harness reports no tokens, Augur estimates them from the prompt and answer length, but only for a route with at least 8 reporting jobs and a measured error of 35% or less, and the estimate shows that error. `augur usage` prints the same figures per route. `docs/accounting.md` explains each.
- [Visible] [Platform] **An MCP server lets Claude Code, Claude Desktop and other MCP clients list models, pick one and run a job through Augur.** `augur-mcp.cmd` ships in the installer's `service` folder and offers eight tools: models, pick, run, job, jobs, cancel, pressure and routes. Each call goes through the dispatch service under the same rules as the `augur` command, so a run needs a pick from the same session and a stated data tier, and the server has no way to skip a check. `docs/mcp.md` covers registering it and each tool.
- [Visible] [UI] **Test route on the Routes page checks that a route works.** It sends a fixed one-word prompt through the route and says whether the model answered. `augur test <route>` does the same from a terminal. The test picks an activity the rules allow for that model, and skips the pick check, since nobody chose the model for a task.
- [Visible] [UI] **Dial back on the rules page pauses the high-cost models and favours the cheaper ones until a reset.** Pick when it ends from the resets ahead or enter a time, preview every model it would change, then apply. Models at high or very high cost stop, and the weights of free, very cheap and cheap ones rise one step. Each goes back to its own rules when the time passes.
- [Visible] [UI] **First-run setup asks who classifies tasks when jobs are on.** Choose none, Laya or Jev, with a line on where task text goes for each. The choice restarts the service so it applies at once.
- [Visible] [UI] **The bulk bar on Model rules can set data tier, ask first, output, sandbox, cost and effort, and shows what would change first.** Preview lists each model that changes and how many already have the value, and Apply writes exactly that list. Choosing Provider default clears the field so the models follow their provider again.
- [Visible] [Sync] **Model rules edited on the phone or the desktop reach the other one.** A paired pair compare rules about once a minute, and a local edit is sent a few seconds after you make it. Each field keeps the newer edit, and a device with a slow clock still orders its edits after ones it has already seen, so a wrong clock cannot bring back an older value. The rules travel encrypted on their own relay channel, under a name only the two devices can work out.
- [Visible] [UI] **A Service page sets what Augur does for agents.** Usage only keeps Augur as it was, and Also run jobs starts the dispatch service whenever the app opens. The page lists the service's settings, saves each change as you make it, and says where task text goes for the classifier you pick. First-run setup offers the same choice.
- [Internal] [Platform] **`augur config` shows and changes the service's settings.** Each setting has a type and a range, and a value the service would ignore is refused. The two settings that lower the service's checks, and the exec adapter, can be changed from the command line and never from the app.
- [Visible] [UI] **A Routes page adds, edits and removes the routes agents use.** A route joins a model label to an adapter, and the form asks for that adapter's options and marks the required ones. With the service running, each route shows whether it can start a job. Entries the service would skip are named, and saving leaves them in the file.
- [Visible] [UI] **A Jobs page lists the work agents started through Augur.** It shows whether the dispatch service is running, with Start and Stop buttons, and each job's state, result, output and errors. A job that is still going can be cancelled there. The page is in the Windows app.
- [Visible] [Platform] **The Windows installer carries the dispatch service and the `augur` command.** They go in a `service` folder beside the app. An upgrade or uninstall stops the service first, and waits if a job is running so the job is not cut off. `augur service stop --if-idle` makes the same check by hand.
- [Visible] [UI] **A model can be paused with different weights instead of stopped.** On the Model rules page, the pause card asks what happens while it lasts: skip the model, or use replacement weights for any activity. Setting the weights of a cheaper model higher during a pause favours it until the pause ends, and the model list marks such a pause as changed weights rather than paused.

### Changed

- [Visible] [UI] **A model can set one part of its data handling and inherit the rest.** Host country, keeping prompts, training on prompts and pinned host are separate fields, so choosing a host country for one model no longer copies the other three from its provider. The three-way choices gain a Default entry that follows the provider. In policy.json, a model's `inherited` list can name a single part, such as `dataHandling.retainsPrompts`.
- [Visible] [UI] **The review button counts models, and the usage data file has its own row in Settings.** The button reads "6 models to review" and each provider on the rules page reads "6 need review". The Open data file link left the bottom of the usage page for the This computer section.
- [Visible] [UI] **Rule history shows what changed inside a grouped value.** A pause reads as its end time and any weights it changes, and data handling lists only the words that differ, where both used to say "changed".
- [Internal] [Security] **The desktop app reads the GitHub CLI's token itself when it fetches Copilot usage.** The token no longer reaches page code, and the page can no longer run `gh auth token`.
- [Visible] [Sync] **Pairing a phone sends your API keys only if you turn that on.** The setting used to be on by default. The warning under the pairing code now says the link can read everything the phone syncs, keys included.
- [Visible] [UI] **A provider card can be moved with the keyboard.** Focus its handle and press Alt with the Up or Down arrow. The card's link and collapse buttons are now 24 px.
- [Internal] [Security] **The dispatch service starts stricter.** It checks picks and named-model claims by default, reads a prompt file only from inside the job's folder or a listed root, sends an API key only over https or to localhost, and will not start a job on Windows without the job host. A rule that limits a model to text is refused for an adapter that cannot hold a read-only tier. `augur run` needs --activity and --data, and defaults to read tools and text output.
- [Internal] [Security] **Text about students is checked on this computer before anything is classified, and never drops below regulated.** Only a backend on this network sees it, and with none the task is regulated without asking.
- [Internal] [Platform] **Laya defaults to this computer.** Other machines come from settings, the server binds to loopback unless told otherwise, and a new adapter goes live only when it beats the current one by a margin on at least 50 held-out rows. Failed and cancelled jobs no longer count as poor fits.
- [Internal] [Platform] **CI runs every package on Windows with the job host built, plus the Laya tests.**
- [Visible] [UI] **Cost has six steps: free, very cheap, cheap, moderate, high and very high.** The old expensive step now reads as high, and the models that used it keep their place until you change them. When usage runs short, the higher steps drop out first.
- [Visible] [UI] **The update and models-to-review buttons sit to the left of the theme button.** They are the header's alerts, so they now come first and stay apart from the controls.

### Fixed

- [Internal] [Platform] **The service notices a file that changed within the same timestamp tick.** It re-reads policy.json, usage.json and routes.json when their size changes as well as their modification time, so two quick writes no longer leave it on the older one.
- [Visible] [UI] **A pause until a reset is not offered on a stale reading.** If the provider's last reading failed or is more than 30 minutes old, the reset list stays empty and says why, and a reset that has already passed is never listed. A pause could otherwise end at the wrong time, or not last at all.
- [Internal] [Platform] **`augur service stop` waits until the service is gone.** It used to return while the service was still answering.
- [Visible] [UI] **A failed write of policy.json shows on the Model rules page.** It used to say Saved while agents kept the older file. The banner has a Try again button.
- [Internal] [Platform] **Adopting an existing policy.json keeps each model inheriting from its provider.** A later change to a provider default reaches those models.
- [Internal] [Security] **The prompt is removed from the stored job plan before the harness starts,** so a failed launch leaves none on disk. Copies made for patch-only jobs leave out `.env` files and key files.
- [Visible] [UI] **Bulk actions on the Model rules page say what they did.** Setting a data tier, an activity weight, or confirming or hiding models now shows a line in the selection bar naming the change and how many models it reached, and the data tier menu keeps the value you chose. Before, the menu snapped back to its label with no sign that the change had been saved.

## [0.7.0] - 2026-09-29

### Added

- [Visible] [Providers] **GitHub Copilot shows its credits used this month.** Augur reads the count through the GitHub CLI's sign-in (`gh auth login`) and compares it with a monthly spending cap you enter in settings, since GitHub does not report a cap. The card shows the credits used and when the month resets. Turn it on in settings; it is off until then.
- [Visible] [UI] **A Model rules page sets what agents may use each model for.** Each provider and model lists its allowed activities, how often to pick it for each one, the most sensitive data it may see, whether it runs only when named, and an optional pause. Augur saves the rules to policy.json beside the usage file whenever one changes. A new model stays blocked until its rules are confirmed, and the dashboard shows how many are waiting. Every change is listed in History and can be undone. If a policy.json is already in place when the page first runs, Augur adopts its rules, pauses and confirmations instead of importing the starting set.
- [Visible] [Providers] **Model rules lists each provider's current models.** Once a day Claude, Codex, Grok and MiniMax add their newest models for review, and OpenRouter and fal keep theirs as a searchable list to add from. Only the newest version of each model is listed. A newer version starts with the older one's rules, and confirming it hides the older one.
- [Internal] [Platform] **A local dispatch service and CLI run jobs under the model rules.** `augurd` accepts a job, checks it against policy.json and the usage meters, and runs the harness in its own supervised process. A job outlives its caller, can be cancelled with its whole process tree, and is picked up again after the service restarts. The `augur` command starts, watches, cancels and reads jobs, and `augur apply` applies the patch a sandboxed job returns. Adapters cover Codex, Hermes, Copilot, Grok, MiniMax Code and OpenCode (the last two inside Docker Sandboxes, on a copy of the working folder), plus OpenAI-style and Anthropic-style APIs. The app does not use the service yet.
- [Internal] [Platform] **The dispatch service enforces the model rules with live usage.** A job is refused when its provider's session or weekly meter is over its limit, when a pay-as-you-go balance is under its minimum, or when the model is burning its window far faster than the window allows. `augur pick` ranks the models a task may use from the rules and current usage, and the service can require that a job's model was picked for its caller within the last hour. A caller can skip the pick check or the usage check for one job, and each skip is recorded with the job.
- [Internal] [Platform] **The dispatch service checks a claim that a person named a model.** A caller that says so is confirmed against a message the service was told a person sent (`augur note-prompt` keeps only which models it named, never the text), or against a terminal a person is typing at. The setting `verifyNamed` records an unconfirmed claim by default, and can refuse the job instead or turn the check off.
- [Internal] [Platform] **The dispatch service can classify a task and score model fit with Laya.** Laya is an open System One model that runs on this computer, with a second machine as failover. A server that reports more than 80% GPU or video memory use steps aside, and the next server on the list answers. Jev with your own key, or no classifier at all, can be chosen instead, and a second backend can be run beside the first only to compare answers.
- [Internal] [Platform] **A Laya package serves the model with LoRA adapters, trains new adapters from labelled decisions, and copies adapters between machines.** Rows carry a provenance so an adapter can be built without any Jev-labelled rows, and training can use the published loss or plain cross-entropy.
- [Internal] [Platform] **The dispatch service can keep a record of each pick and how the job that followed it ended, and a nightly run turns that record into new Laya adapters.** Task text is written only when learning is switched on and the task's data tier is public or internal. A new adapter goes live only when it beats the current one on rows held out from training, and it is then copied to the second machine.

## [0.6.1] - 2026-09-27

### Fixed

- [Visible] [Providers] **Jev shows your TypeSafe balance again.** TypeSafe renamed Credit Balance to Available credits. Augur now finds the balance by the words around it, so a renamed label no longer hides it.

## [0.6.0] - 2026-09-27

### Added

- [Visible] [UI] **The dashboard shows when an update is ready.** Augur now checks every 5 minutes instead of every 6 hours. A pulsing Update button appears next to refresh; hover over it for the list of changes, or click it to install and restart.

## [0.5.1] - 2026-09-27

### Changed

- [Visible] [Providers] **The Codex card is now called Codex instead of ChatGPT / Codex.** It shows the Codex CLI's weekly limit, which ChatGPT on the web does not count against.

## [0.5.0] - 2026-09-27

### Added

- [Visible] [Providers] **Providers can refresh every 15 seconds.** 15 minutes is still the default.

### Fixed

- [Visible] [Sync] **Refresh on the phone now gets new numbers from the desktop.** Tapping it asks the desktop to read Claude, ChatGPT, Grok and Jev again, and the phone shows that it is waiting until they arrive. Before, it only showed the desktop's last copy, which could be 10 minutes old.
- [Visible] [Sync] **A refresh on the desktop now sends the new numbers to the phone right away, instead of waiting for the next 10-minute upload.**
- [Visible] [Sync] **Phone sync no longer stops after a few days.** A week of history had grown past the relay's size limit, so history now keeps one reading per 5 minutes and uploads are compressed.
- [Visible] [Providers] **Jev shows your credit balance on the first refresh after you sign in to the TypeSafe console.** When it cannot read the balance, the card now says why.
- [Visible] [Providers] **You no longer need to refresh after signing in to TypeSafe.** While the sign-in window is open, Augur keeps looking and shows your balance a few seconds after you finish.

## [0.4.1] - 2026-09-27

### Fixed

- [Visible] [UI] **Dragging a provider card now moves it.** On Windows, a card you picked up by its grip would not drop, on the dashboard or in settings, so the order never changed.

## [0.4.0] - 2026-09-27

### Added

- [Visible] [Platform] **Ctrl+Super+U shows your usage from any app.** The shortcut opens the Augur panel without reaching for the tray icon, and pressing it again closes it; Super is the Windows key, or Command on a Mac. Settings lets you pick another shortcut or turn it off.
- [Visible] [Sync] **The phone app stays current.** Switching back to Augur on your phone loads the newest version if one came out while it was in the background.
- [Visible] [Sync] **You can pair from inside the phone app.** Open Augur, go to settings and tap Scan pairing code to point the camera at your desktop. On an iPhone this is the way to pair the Augur icon on your home screen.
- [Visible] [Sync] **Your phone gets the desktop's API keys when you pair it, so it refreshes MiniMax, OpenRouter and fal on its own.** If one of those fails on the phone, it shows the desktop's numbers instead. You can turn key sharing off in the desktop's settings.

### Changed

- [Visible] [UI] **Augur on the home screen.** The home-screen app is now named Augur, and on iPhone the top of the panel no longer sits under the status bar.

### Fixed

- [Visible] [Sync] **Pairing now works when you scan the code with an iPhone camera.** Before, the phone opened the link but never paired.

## [0.3.0] - 2026-09-27

### Added

- [Visible] [UI] **Phone-sized layout.** On a touch screen the web app uses larger text, bigger buttons and switches, and fields that no longer make iPhone zoom in when tapped.

### Changed

- [Visible] [UI] **A settings icon you can tell apart.** The settings button now shows sliders, so it no longer looks like the sun on the theme button next to it.
- [Visible] [Sync] **Pairing sets up the phone.** Scanning the pairing code opens the phone straight to your numbers, with the desktop's providers, order, colors, hidden meters, theme and alert levels. Providers without a key on the phone show the desktop's readings instead of an error.

## [0.2.0] - 2026-09-27

### Changed

- [Visible] [Providers] **Each provider refreshes on its own schedule.** The app-wide refresh setting is gone. Providers refresh every 15 minutes unless you pick another interval for one, from every 5 minutes to once a week, and Jev still defaults to weekly. A provider whose last read failed tries again after 5 minutes instead of waiting out its full interval.

## [0.1.0] - 2026-09-26

### Added

- [Visible] [Providers] **Plan limits and balances for seven providers.** Claude (session, weekly and per-model limits), ChatGPT and Codex (weekly limit and resets available), Grok (weekly SuperGrok limit and extra usage credits), MiniMax (coding plan windows), OpenRouter (credits left and spend today, this week and this month), fal (credit balance, monthly spend and top endpoints) and Jev from TypeSafe (credit balance, 7-day spend, requests and tokens).
- [Visible] [Providers] **Custom providers from JSON.** Any usage endpoint that returns JSON can be tracked by describing its requests and the paths to each number, with no code.
- [Visible] [Platform] **Tray app for Windows, macOS and Linux.** The panel opens from the tray or menu bar, sizes itself to its content, and switches to two columns when one would not fit on the screen.
- [Visible] [UI] **Pace and history on every meter.** Each meter shows where even pace would put you, a forecast of when the limit runs out, and a 7-day chart with each reset marked.
- [Visible] [UI] **Personal layout.** Cards can be reordered, collapsed, recolored and trimmed to the meters you want, with light, dark and system themes.
- [Visible] [Alerts] **Notifications before a limit bites.** Alerts fire when a limit passes a percentage you choose, when usage is burning faster than a ratio you set for session and weekly windows, and when a balance drops below an amount.
- [Visible] [Alerts] **Stale figures are marked.** A provider that fails to refresh keeps its last numbers with a Stale badge and the time they are from, and one notification says so.
- [Visible] [Sync] **Phone app with end-to-end encrypted sync.** The web app at augur.rpgm.tools installs to a phone's home screen, tracks key-based providers directly, and shows the desktop's Claude, ChatGPT and Grok numbers after pairing by QR code.
- [Visible] [Providers] **Refresh interval per provider.** Each provider can be read less often than the rest, from every 15 minutes to once a week. Jev defaults to weekly because its balance sits behind a Cloudflare check, and the refresh button still reads everything at once.
- [Visible] [Platform] **Automatic updates.** The desktop app checks for a signed release every six hours and installs it while the panel is closed; this can be turned off in settings.
- [Visible] [Platform] **Data file for scripts.** After each refresh the desktop app can write the latest numbers and a one-line summary to a JSON file in your home folder.
- [Internal] [Security] **Relay limited to the endpoints it serves.** The relay forwards only the usage and status endpoints the web app reads, accepts only Augur's own health check for TypeSafe, rate-limits each address, and limits how often one sync channel can be replaced.
- [Internal] [Security] **Narrow desktop permissions.** The page can reach only Claude Code's own keychain item, the three login files, and the one export file named in settings, under a strict content security policy.
