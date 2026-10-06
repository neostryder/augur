---
name: balance
description: Shows what Augur's automatic balance is doing: where each kind of work goes, Claude's pace, Copilot's spend and the latest picks.
---

# Show the balance

Call `augur_balance`, with `days` when the person names a period, and summarise it in a few lines:

- Claude's stance (hot, on pace or behind), which way the controller leans because of it, and whether a window is at its reserve.
- The providers that are paced, draining, free or held as backups, and any with no figures.
- Copilot's spend against the aim and the cap, when backups are in use.
- The last days' picks, with any that were labelled as missing their brief.

End with one sentence on what the balance would do for the next piece of work. If a setting looks wrong, offer to change it with `augur_policy_edit` rather than doing it unasked.
