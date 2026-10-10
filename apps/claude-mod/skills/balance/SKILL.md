---
name: balance
description: Shows what Augur's automatic balance is doing: each paced provider's stance and boost, where each kind of work goes, Copilot's spend and the latest picks.
---

# Show the balance

Call `augur_balance`, with `days` when the person names a period, and summarize it in a few lines:

- Each provider that needs attention, in the order the report gives them (hot, figures missing, behind): its stance, how far each window runs ahead of or behind pace, and whether a window is at its reserve. For Claude, also say which way the controller leans.
- The providers on pace in one line, with any boost they have for unused allowance and their rough odds, and the providers that are not paced.
- How each provider is treated: paced, draining, free or held as a backup, and any with no figures.
- Copilot's spend against the aim and the cap, when backups are in use.
- The last days' picks, with any that were labelled as missing their brief.

End with one sentence on what the balance would do for the next piece of work. If a setting looks wrong, offer to change it with `augur_policy_edit` rather than doing it unasked.
