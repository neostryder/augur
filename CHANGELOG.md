# Changelog

All notable changes to Augur are listed here. Each entry starts with `[Visible]` when a user would notice it or `[Internal]` when only the code or tooling changed, followed by the kind of change.

## [Unreleased]

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
