# Changelog

All notable changes to Augur are listed here. Each entry starts with `[Visible]` when a user would notice it or `[Internal]` when only the code or tooling changed, followed by the kind of change.

## [Unreleased]

## [0.3.0] - 2026-09-27

### Added

- [Visible] [UI] **Phone-sized layout.** On a touch screen the web app uses larger text, bigger buttons and switches, and fields that no longer make iPhone zoom in when tapped.

### Changed

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
