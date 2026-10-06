---
name: pick
description: Asks Augur which model should do a task, under the owner's rules and the current usage, and offers to run it there.
argument-hint: "[what the task is]"
---

# Pick a model with Augur

Use the task the person gave in the arguments, or ask for one. Then:

1. Decide how sensitive the task's data is: public, internal, sensitive or regulated. Take the highest tier the task touches, and ask when it is unclear. A model is only used for data at or below the tier its rules allow.
2. Call `augur_pick` with the task, the activity if it is obvious, and that data tier.
3. Report the pick, the reason Augur gave and the routes that reach it. If no model is permitted, say that and give the reason Augur returned.
4. Offer to run the task with `augur_run` on one of those routes. The run is refused unless the pick was made in this session within the last hour, so pick again if it has been longer.

Augur's rules cannot be argued with from here. If the pick is not what the person wanted, `augur_pick_preview` shows what an edit to the rules would change, and `augur_policy_edit` queues it under the owner's approval setting.
