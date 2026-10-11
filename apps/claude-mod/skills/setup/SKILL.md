---
name: setup
description: Walks through setting up Augur for this computer. It reads what is configured, asks a few questions, makes the balance and route changes through Augur's own tools, and checks each route works. A key is never typed in this chat.
disable-model-invocation: true
---

# Set up Augur

This gets a new Augur install into a working state, and it can be run again later to change one. Augur picks which model should do a piece of work and keeps usage in balance across providers, so the questions below are about that balance and about which routes have a key. No API key is ever typed in the chat. Keys go in with `augur key set` in the person's own terminal.

The window app and the terminal app have the same setup built in as a short interview. It opens on a new install, and Run setup again in Settings brings it back later. This skill reaches the same setup from Claude Code: the questions are asked in the chat, the answers go in through `augur_policy_edit`, a new API goes in with `augur provider add` and any other new route with `augur_route_add`, and every key is left to `augur key set`. The interview in the apps writes the same edits, so a setup made in one place reads the same in the other. If the person would rather click through it, point them to Setup in either app and stop here.

## Start with what is already there

Look before asking, so the questions only cover what is missing. `augur claude status` says whether the Claude Code part is installed. The `augur_routes` tool lists the routes and says why any of them cannot run, `augur_policy` shows each model's rules and the balance settings, and `augur config` shows the service settings, including how agent edits are approved. If Augur is not running, tell the person to start it with `augur service start` or by opening the app, and stop there.

## Ask what is left

Use AskUserQuestion, one question at a time, with a short consequence under each option. Skip any question the current state already answers. The questions follow the interview's steps, so the answers land as the same settings.

- Which profile to start from. Neutral gives a tier only to Claude's own models, so its pace lean moves work toward Sonnet when Claude runs ahead of its windows and toward Opus when it runs behind. Classic is the original rule set, with its own tiers and preferences for deep and everyday work. A fresh install is neutral. Under both, a provider with allowance left to spend gets a boost, and the pick is drawn from each route's odds.
- How much of each subscription to keep back. Every provider with a usage window has its own pace block. `pace.<provider>.reserve` is the percent of a window at which optional work moves off that provider, 90 by default. `pace.<provider>.band` is how many points ahead or behind the pace still count as on pace, 5 for Claude and 10 for the others. Offer the interview's three choices: use it freely (reserve 100, band 20), keep some back (reserve 90 with the default band, which is what a new install has), or save it for the work only it does (reserve 60, band 5). `pace.<provider>.boost` is the most a provider's routes are lifted when it has allowance left, 1.5 by default, and 1 turns it off. Ask about Claude first, then any other subscription the person wants to hold back or spend down.
- Which subscription to use first. The order becomes `useAfter` on each model: the first subscription's models wait on nothing, and each later one's models wait on every model of the subscription just above it. A subscription with no usage window keeps its place but waits on nothing, and nothing waits on it.
- Which providers charge per use. Those go in `fallback.providers` and compete only when no subscription route can take the work. `fallback.aim` is the monthly spend to stay under.
- Whether each model is strong or light, which sets `tiers.<label>`. A model the person is not sure about is left alone.
- Whether to name routes for `prose.models` and for `seats.second.models`, the ones that give a second opinion.

Never widen how sensitive the data may be for a model. That limit is the owner's. A change that widens it waits for them to accept it in Augur.

## Make the changes

A balance change is an `augur_policy_edit` call with `field` set to `balance` and a `path` of one name per level, such as `["pace", "claude", "reserve"]`. The value `"inherit"` puts a setting back to what its profile gives. `docs/configuring.md` in the Augur repository lists every path, and `augur_pick_preview` shows what a change would do before it is queued.

Whether an edit applies at once or waits in Augur depends on the owner's approval setting. Say which happened. The setting itself cannot be reached from here, so do not try to change it.

A setup from another computer comes in with `augur profile import <file>`. Run it with `--dry-run` first and show the summary it prints. Models the file brings arrive unreviewed with their rules filled in, so tell the person which ones to confirm in Model rules.

## Routes and keys

A new API that speaks the OpenAI or Anthropic format is one command: `augur provider add openai gpt --model gpt-5`, or `openai-style` or `anthropic-style` with a `--base-url` for one that has no preset. The person can also do it themselves with Add provider on the Routes page, which runs the same checks, shows the plan as they type and takes the key in the form. Run it with `--dry-run` first and show the plan. Then run it with `--no-key`, which adds the route and the model without asking for a key. The model goes into the rules unreviewed, so it can't run until the person has looked at its rules and confirmed it in Augur. Offer to queue the activities and the data tier it should get, and leave the confirming to them.

Any other route, such as one for a command-line harness, goes in with `augur_route_add`: a route name, an adapter, a provider id, the adapter's options and, when the model is new, its label and id. Never put a key in the options, since the tool refuses one. The model arrives unreviewed like any other. If the approval setting holds every agent edit, nothing is written, so tell the person to add the route in the app.

When a route needs a key, give the person `augur key set <route>` to run in their own terminal, then wait. The command names the host the key will be sent to, so ask the person to check that address before typing the key. A key is not accepted in the chat, put on a command line or written to a file. Once the keys are in, run `augur test <route> --wait` for each route and report which ones worked and what the failures said.

## Finish

Close with what changed, what is waiting for approval and what still needs a key. Offer `augur profile export setup.json` so the same setup, model rules included, can move to another computer. The file holds no keys.
