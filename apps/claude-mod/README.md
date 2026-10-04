# Augur's Claude Code mod

This folder is the mod Augur installs into Claude Code when you turn on Claude Code under Claude in Augur's settings. It keeps your usage in the status line, for example `Claude 5h 27% | wk 48% | Grok wk 81% | 1 Augur alert`. Other providers join the line once one of their limits reaches 70% or their last read failed, and the line says how old the numbers are once Augur has not written them for 15 minutes.

When Augur raises an alert meant for Claude Code, the mod shows it once as a toast and then keeps the newest one in a row above the prompt. Press D to dismiss it or O to open Augur. Alerts that were already waiting when the mod first loaded do not get a toast, so installing it does not set off a burst of them.

## How it talks to Augur

Augur saves `usage.json` after each refresh and keeps `alerts.json` beside it. The mod only reads those two files. Dismissing an alert appends a line like `{"id":"a1b2c3","at":"2026-10-03T20:00:00.000Z","by":"claude"}` to `alerts-acks.jsonl` in the same folder, and on its next check Augur clears that alert in the panel and on a paired phone.

Augur's installer copies this folder to `~/.augur/claude-mod` and adds that path to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. It also writes `augur-app.json` into the copy, naming the usage file and the Augur program. If that file is missing, the mod reads `~/.augur/usage.json` and leaves out the Open Augur button.

## Changing it

The formatting lives in `hooks/view.ts` as plain functions, and `hooks/register.tsx` connects them to Claude Code. The tests in `tests/augur.test.ts` run against a fake file system and clock.

```bash
claude plugin validate apps/claude-mod
```

```bash
claude plugin test apps/claude-mod
```

For `tsc -p .`, put Claude Code's `claude-code.d.ts` and the `tsconfig.json` from the top of that file into `.claude-plugin/types/`. That folder is ignored by git because the declarations belong to whichever Claude Code version you have.
