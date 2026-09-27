# Augur

Augur shows how much of your AI plans and credits you have used, in one place: a tray icon on Windows, a menu-bar icon on macOS, and a web app you can add to a phone's home screen. It reads the same numbers each provider's own usage page shows, refreshes each one on its own schedule, and warns you when a limit is running out faster than its window resets.

<table align="center">
  <tr>
    <td align="center" valign="top" width="50%">
      <img src="docs/images/dashboard.jpg" alt="The Augur panel with Claude, ChatGPT, Grok, MiniMax, OpenRouter, fal and Jev cards" width="300"><br>
      <sub>The panel shows your most-used limit at the top and a card for each provider below it.</sub>
    </td>
    <td align="center" valign="top" width="50%">
      <img src="docs/images/settings.jpg" alt="Augur settings: providers, appearance, alerts, custom providers, phone sync and updates" width="300"><br>
      <sub>In settings you choose what each card shows, how often it refreshes, and when Augur warns you.</sub>
    </td>
  </tr>
</table>

## What it tracks

| Provider | What you see | What it needs |
| --- | --- | --- |
| Claude | Current session, weekly limit, weekly limit per model | The Claude Code app signed in on this computer |
| ChatGPT and Codex | Weekly plan limit, limit resets available | The Codex CLI signed in on this computer |
| Grok | Weekly SuperGrok limit | The Grok CLI signed in on this computer |
| MiniMax | Coding plan: 5-hour and weekly text limits, video counts | An API key |
| OpenRouter | Credits left, spend by the key today, this week and this month | An API key |
| fal | Credit balance, spend this month, top endpoints | An admin API key |
| Jev (TypeSafe) | Credit balance, spend and requests over the last 7 days, response time | An API key, plus a one-time sign-in to the TypeSafe console for the balance |

Claude, ChatGPT and Grok only report plan limits to their own signed-in apps, so those three work in the desktop app. The phone app can show them too once you pair it with your desktop (see below).

You can add any other provider whose usage endpoint returns JSON, without writing code. See [Custom providers](#custom-providers).

## Install

**Windows:** download the installer from the latest release and run it. No administrator rights are needed. The installer is not code-signed yet, so Windows SmartScreen may warn the first time; choose More info, then Run anyway. The icon may land in the hidden-icons area at first. Drag it onto the taskbar to keep it in view.

**macOS:** download the `.dmg` from the latest release (one build runs on both Apple silicon and Intel) and drag Augur into Applications. The app is not signed with an Apple developer certificate yet, so macOS blocks it the first time you open it. Open System Settings, go to Privacy & Security, choose Open Anyway next to the message about Augur, and confirm. After that it opens normally.

**Linux:** download the AppImage (runs on most distributions, including Arch, as long as WebKitGTK 4.1 is installed), or the `.deb` or `.rpm`. The tray icon needs an AppIndicator host: KDE Plasma has one built in, and GNOME needs the AppIndicator extension. On Linux the panel opens from the icon's menu rather than a click.

The first launch shows a setup screen. Providers that are already signed in on the computer are turned on for you. For the others, paste an API key and turn them on. Keys are stored in the operating system's keychain (Windows Credential Manager, the macOS Keychain, or the Secret Service on Linux), and each one is sent only to its own provider.

To see your TypeSafe balance, open Jev in settings and choose Sign in. Augur keeps that console session in its own window and uses it only to read your billing page.

## Using it

Click the icon to open the panel. The ring on the icon shows your most-used limit, and its color turns amber at 75% and red at 90%. Hover over it for one line per provider without opening the panel.

<p align="center">
  <img src="docs/images/tray-tooltip.jpg" alt="The tray tooltip listing each provider's usage on one line" width="185"><br>
  <sub>Hovering over the tray icon shows every provider at a glance.</sub>
</p>

Each meter shows how much is used, when it resets, and a thin mark on the bar for where even pace would put you. Click a meter to see the last seven days, with dashed lines at each reset. Drag a card by its handle to change the order, and collapse cards you only check now and then. The panel switches to two columns when one column would not fit on the screen, or you can pick one or two columns in settings.

Augur checks for a new version every six hours and installs it while the panel is closed, then restarts. You can turn that off in settings and install from there instead.

Settings also cover the theme (system, light or dark), which meters each card shows, card colors, how often each provider refreshes, and alerts. Providers refresh every 15 minutes by default and Jev once a week, a provider whose last read failed tries again after 5 minutes, and the refresh button reads every provider at once.

## Alerts

Augur can notify you when:

- a limit passes a percentage you choose, such as 80% and 95%.
- a limit is burning too fast, meaning the usage left divided by the time left in its window drops below a ratio you set. Session and weekly limits each get their own ratio. At 1.0 you run out right at the reset, and 0.8 warns earlier.
- a credit balance drops below an amount you set.

Each alert fires once per window and waits for the next reset before it can fire again.

## Phone app

The web app works in any modern mobile browser. Open [augur.rpgm.tools](https://augur.rpgm.tools) on the phone and add it to your home screen (on iPhone, Share and then Add to Home Screen; on Android, the install prompt). On a phone it can track the providers that use API keys directly: the keys are encrypted on the phone and requests go through a relay that forwards them without storing anything.

To see Claude, ChatGPT or Grok on your phone, choose Pair a phone in the desktop app's settings and scan the QR code with the phone. The desktop encrypts each update with a key only it and your phone hold, and the relay stores only that ciphertext.

## Custom providers

A custom provider is a short JSON definition in settings: the requests to make, how to send the key, and paths into each response for meters and balances. Paths look like `$.data.used`, can pick an array item by a field (`$.models[name=text].remaining`), and a value starting with `=` is arithmetic over paths:

```json
{
  "id": "example",
  "name": "Example",
  "auth": { "type": "bearer" },
  "requests": { "main": { "url": "https://api.example.com/v1/usage" } },
  "meters": [
    { "id": "monthly", "label": "Monthly quota", "usedPct": "=100 * main:$.used / main:$.limit", "resetsAt": "main:$.reset_at", "windowSeconds": 2592000, "windowKind": "monthly" }
  ],
  "money": [ { "id": "balance", "label": "Credits left", "amount": "main:$.balance" } ]
}
```

`auth.type` is `bearer`, `header` (with `name`), `query` (with `name`) or `none`. The full format is documented in [`packages/core/src/types.ts`](packages/core/src/types.ts). Providers that need a sign-in refresh or a command-line login are written as plugins in `packages/core/src/providers`.

## Building from source

To build it you need Node 24 or newer and pnpm, plus stable Rust with the Tauri prerequisites for your platform.

```bash
pnpm install
pnpm --filter @augur/core test
pnpm --filter @augur/desktop tauri dev
```

`pnpm --filter @augur/desktop tauri build` builds the installer for the current platform.

The web app is `apps/ui`, and the relay is a Cloudflare Worker in `apps/relay` that also serves the web app's files. To run your own copy, copy `apps/relay/wrangler.example.toml` to `apps/relay/wrangler.toml`, set your domain and a KV namespace id of your own, then build the web app and deploy:

```bash
pnpm --filter @augur/ui build
pnpm --filter @augur/relay deploy
```

The desktop and web apps use `https://augur.rpgm.tools` until you enter another relay address in settings.

### Keys from Bitwarden Secrets Manager

The desktop app can read API keys from a [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/) project instead of its own keychain. Install the `bws` command-line tool, sign it in, and add a `secretSources` block to `config.json` in the app's data folder (`%APPDATA%\com.neostryder.augur` on Windows, `~/Library/Application Support/com.neostryder.augur` on macOS, `~/.config/com.neostryder.augur` on Linux). Each entry maps a provider's key field to the name of a secret in the project:

```json
"secretSources": {
  "bws": {
    "projectId": "00000000-0000-0000-0000-000000000000",
    "map": { "openrouter.apiKey": "OPENROUTER_API_KEY", "fal.adminKey": "FAL_ADMIN_KEY" }
  }
}
```

A key saved in settings takes priority over the same key in the project.

## Privacy

Augur has no accounts and no database of its own. The desktop app talks to each provider directly. The relay the phone app uses passes each request, including the API key in it, to a fixed list of usage and status endpoints; its code stores and logs none of it, though Cloudflare, which runs it, keeps its own request logs. Sync data on the relay is encrypted on your computer with a key only your paired phone has, so the relay holds ciphertext it cannot read, and it expires after 14 days. See [SECURITY.md](SECURITY.md) for what is stored where and how to report a problem.

## License

MIT
