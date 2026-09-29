# Changelog

All notable changes to Augur are listed here. Each entry starts with `[Visible]` when a user would notice it or `[Internal]` when only the code or tooling changed, followed by the kind of change.

## [Unreleased]

### Added

- [Visible] [UI] **A Model rules page sets what agents may use each model for.** Each provider and model lists its allowed activities, how often to pick it for each one, the most sensitive data it may see, whether it runs only when named, and an optional pause. Augur saves the rules to policy.json beside the usage file whenever one changes. A new model stays blocked until its rules are confirmed, and the dashboard shows how many are waiting. Every change is listed in History and can be undone.
- [Visible] [Providers] **Model rules lists each provider's current models.** Once a day Claude, Codex, Grok and MiniMax add their newest models for review, and OpenRouter and fal keep theirs as a searchable list to add from. Only the newest version of each model is listed. A newer version starts with the older one's rules, and confirming it hides the older one.
- [Internal] [Platform] **A local dispatch service and CLI run jobs under the model rules.** `augurd` accepts a job, checks it against policy.json and the usage meters, and runs the harness in its own supervised process. A job outlives its caller, can be cancelled with its whole process tree, and is picked up again after the service restarts. The `augur` command starts, watches, cancels and reads jobs. The first adapter runs `codex exec`. The app does not use the service yet.

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
