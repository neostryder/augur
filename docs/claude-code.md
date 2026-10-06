# Augur in Claude Code

Augur has one Claude Code plugin. It puts Claude's usage and pace in the status line, shows alerts as toasts, adds three skills, and gives Claude the Augur tools so it can pick a model and run work on it. An optional hook adds a note before each subagent.

## Installing it

The simplest route is the switch in Augur's settings: turn on Claude Code under Claude, or run `augur claude install code`. Augur copies the plugin to `~/.augur/claude-mod` and adds it to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, so every Claude Code session loads it. `augur claude remove code` takes it out again.

To install it through Claude Code's own plugin manager instead, add this repository as a marketplace:

```bash
claude plugin marketplace add neostryder/augur
claude plugin install augur@augur
```

Install it one way or the other, not both. The plugin starts `augur-mcp` for the Augur tools, and the hook runs `augur`, so both commands need to be on your PATH. A terminal install and the Arch packages put them there. On a desktop install without a terminal install, add the `service` folder beside the app to your PATH. If you registered the server yourself with `claude mcp add augur`, the plugin's copy makes the tools appear twice; remove yours with `claude mcp remove augur`.

Augur itself has to be running. The tools and the skills talk to its service, which runs whenever the app is open and otherwise starts with `augur service start`.

## The status line

The line reads `Claude 5h 27% | wk 48% | hot +8 | Grok wk 81% | 1 Augur alert`. After Claude's two windows comes its pace. `hot +8` means the busiest window is 8 points ahead of the share of it that has passed. The word is `hot` when any window is further ahead than the pace band and `behind` when every window is further behind, and `on pace` otherwise. The band is `claude.band` in the balance settings, 5 points unless you changed it, and the plugin reads your value from `policy.json`. A hot Claude is why the balance leans to Sonnet and other models; a Claude that is behind is why it leans to Opus.

The pace is left out when Augur has not refreshed Claude's numbers for 15 minutes, since a stale figure would give the wrong stance. The line then says how old the numbers are.

A plugin cannot set Claude Code's `statusLine` setting. The plugin shows this line through the mod interface, which is separate from that setting.

## Skills

Plugin skills carry the plugin's name, so they are run as `/augur:setup`, `/augur:pick` and `/augur:balance`.

| Skill | What it does |
| --- | --- |
| `/augur:setup` | Reads what is configured, asks a few questions and makes the changes through `augur_policy_edit`. It sends you to `augur key set` for any key and runs `augur test` on each route. It never accepts a key in the chat. |
| `/augur:pick [task]` | Asks Augur which model should do the task, says why, and offers to run it with `augur_run`. It asks how sensitive the task's data is before it picks. |
| `/augur:balance` | Summarises what the balance is doing: Claude's stance, where each kind of work goes, Copilot's spend and the latest picks. |

The setup skill's changes go through the same edit inbox as any agent's. Your approval setting on the Service page decides whether they apply at once or wait in Augur for you, and the skill cannot change that setting.

## The note before a subagent

Claude Code runs a PreToolUse hook before it starts a subagent. The plugin's hook adds a note to what Claude reads: which way the balance leans, and the model Augur would pick for the subagent's task, with the routes that reach it. Claude can then run the task on that route with `augur_run`, or keep the subagent as planned.

The hook is off until you turn it on. Open `/plugin`, choose Augur, and turn on Note Augur's pick before each subagent, or run `/plugin configure augur@augur`. It sends the service only the subagent's one-line description and the session id, never its prompt. It adds a note and nothing else: it never allows, denies or rewrites the call, so your permission settings keep working as before. If Augur is not running, the hook adds nothing and the subagent starts as usual.

## What it reads and writes

The status line and the alerts come from `usage.json` and `alerts.json` in `~/.augur`, which Augur refreshes about once a minute. Dismissing an alert appends a line to `alerts-acks.jsonl` in the same folder. The skills and the hook go through the dispatch service, so they follow the same rules and the same approval setting as the `augur` command and the [MCP server](mcp.md).
