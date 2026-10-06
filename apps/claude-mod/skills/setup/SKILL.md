---
name: setup
description: Walks through setting up Augur for this computer. It reads what is configured, asks a few questions, makes the balance and route changes through Augur's own tools, and checks each route works. A key is never typed in this chat.
disable-model-invocation: true
---

# Set up Augur

This gets a new Augur install into a working state, and it can be run again later to change one. Augur picks which model should do a piece of work and keeps usage in balance across providers, so the questions below are about that balance and about which routes have a key. No API key is ever typed in the chat. Keys go in with `augur key set` in the person's own terminal.

## Start with what is already there

Look before asking, so the questions only cover what is missing. `augur claude status` says whether the Claude Code part is installed. The `augur_routes` tool lists the routes and says why any of them cannot run, `augur_policy` shows each model's rules and the balance settings, and `augur config` shows the service settings, including how agent edits are approved. If Augur is not running, tell the person to start it with `augur service start` or by opening the app, and stop there.

## Ask what is left

Use AskUserQuestion, one question at a time, with a short consequence under each option. Skip any question the current state already answers.

- Which profile to start from. Neutral tilts only for Claude's pace: toward Sonnet when Claude runs ahead of its windows and toward Opus when it runs behind. Classic is the original rule set, with its own tiers and preferences for deep and everyday work. A fresh install is neutral.
- How much of Claude to keep back. `claude.reserve` is the percent of a window at which optional work moves off Claude, 90 by default. `claude.band` is how many points ahead or behind the pace still count as on pace, 5 by default.
- Which providers charge per use. Those go in `fallback.providers` and compete only when no subscription route can take the work. `fallback.aim` is the monthly spend to stay under.
- Whether to name routes for `prose.models` and for `seats.second.models`, the ones that give a second opinion.

Never widen how sensitive the data may be for a model. That limit is the owner's. A change that widens it waits for them to accept it in Augur.

## Make the changes

A balance change is an `augur_policy_edit` call with `field` set to `balance` and a `path` of one name per level, such as `["claude", "reserve"]`. The value `"inherit"` puts a setting back to what its profile gives. `docs/configuring.md` in the Augur repository lists every path, and `augur_pick_preview` shows what a change would do before it is queued.

Whether an edit applies at once or waits in Augur depends on the owner's approval setting. Say which happened. The setting itself cannot be reached from here, so do not try to change it.

A setup from another computer comes in with `augur profile import <file>`. Run it with `--dry-run` first and show the summary it prints.

## Routes and keys

When a route needs a key, give the person `augur key set <route>` to run in their own terminal, then wait. A key is not accepted in the chat, put on a command line or written to a file. Once the keys are in, run `augur test <route> --wait` for each route and report which ones worked and what the failures said.

## Finish

Close with what changed, what is waiting for approval and what still needs a key. Offer `augur profile export setup.json` so the same setup can move to another computer. The file holds no keys.
