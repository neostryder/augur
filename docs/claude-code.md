# Augur in Claude Code

Augur's Claude Code plugin puts Claude's usage and pace in the status line and shows Augur's alerts as toasts. It adds three skills and gives Claude the Augur tools, so Claude can pick a model and run work on it. An optional hook adds a note before each subagent.

## Installing it

The easiest way is the switch in Augur's settings: turn on Claude Code under Claude, or run `augur claude install code`. Augur copies the plugin to `~/.augur/claude-mod` and adds it to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, so every Claude Code session loads it. `augur claude remove code` takes it out again.

To install it through Claude Code's own plugin manager instead, add this repository as a marketplace:

```bash
claude plugin marketplace add neostryder/augur
claude plugin install augur@augur
```

Use one way or the other, not both. The plugin starts `augur-mcp` for the Augur tools and the hook runs `augur`, so both commands need to be on your PATH. A terminal install and the Arch packages put them there. On a desktop install with no terminal install, add the `service` folder beside the app to your PATH. If you registered the server yourself with `claude mcp add augur`, the tools show up twice once the plugin is in, so remove your entry with `claude mcp remove augur`.

Augur itself has to be running, because the tools and the skills talk to its service. The service runs whenever the app is open, and `augur service start` starts it without the app.

## The status line

The line reads `Claude 5h 27% | wk 48% | hot +8 | Grok wk 81% | 1 Augur alert`. Claude's pace comes after its two windows: `hot +8` means the busiest window is 8 points ahead of the share of it that has passed. The pace reads `hot` when any window is further ahead than the pace band, `behind` when every window is further behind than the band, and `on pace` otherwise. The band is `claude.band` in the balance settings, 5 points unless you change it, and the plugin reads your value from `policy.json`. While Claude is hot the balance leans to Sonnet and other models, and while it is behind the balance leans to Opus.

When Augur has not refreshed Claude's numbers for 15 minutes, the pace is left out, since an old figure would give the wrong stance, and the line shows how old the numbers are instead.

The plugin draws this line through Claude Code's mod interface. A plugin cannot set Claude Code's `statusLine` setting, and the two are separate.

## Skills

Plugin skills take the plugin's name as a prefix, so you run them as `/augur:setup`, `/augur:pick` and `/augur:balance`.

| Skill | What it does |
| --- | --- |
| `/augur:setup` | Reads what is configured, asks a few questions and makes the changes through `augur_policy_edit`. It sends you to `augur key set` for any key and runs `augur test` on each route. It never accepts a key in the chat. |
| `/augur:pick [task]` | Asks Augur which model should do the task, says why, and offers to run it with `augur_run`. It asks how sensitive the task's data is before it picks. |
| `/augur:balance` | Summarises what the balance is doing: Claude's stance, where each kind of work goes, Copilot's spend and the latest picks. |

Changes made by the setup skill go through the same edit inbox as any agent's edits. Your approval setting on the Service page decides whether they apply at once or wait in Augur for you, and the skill cannot change that setting.

## The note before a subagent

Before Claude Code starts a subagent, it runs any PreToolUse hooks. The plugin's hook adds a note for Claude with the way the balance leans, the model Augur would pick for the subagent's task, and the routes that reach that model. Claude can then run the task on one of those routes with `augur_run`, or start the subagent as planned.

The hook is off until you turn it on. Open `/plugin`, choose Augur and turn on Note Augur's pick before each subagent. The hook sends the service the subagent's one-line description and the session id, and never its prompt. It only adds the note: it never allows, denies or rewrites the call, so your permission settings work as before. If Augur is not running, the hook adds nothing and the subagent starts as usual.

## What it reads and writes

The status line and the alerts come from `usage.json` and `alerts.json` in `~/.augur`. Augur reads each provider on its own schedule, every 15 minutes by default, and rewrites `usage.json` each time it does. Dismissing an alert appends a line to `alerts-acks.jsonl` in the same folder. The skills and the hook go through the dispatch service, so they follow the same rules and the same approval setting as the `augur` command and the [MCP server](mcp.md).
