# Grading with rubrics

`augur grade` asks the service's decision backend to score a candidate answer against a rubric, dimension by dimension, and saves the result. A new rubric's grades are only recorded. They start counting as advice, and later as pass or fail verdicts, once people have labelled enough of them as right.

The service needs a decision backend for this, Jev or Laya, set on the Service page (see [Who classifies tasks](../README.md#who-classifies-tasks)). If it is set to None, `augur grade` fails with "No decision backend is configured, so there is nothing to grade with."

## Rubrics

Each rubric is a JSON file in `~/.augur/rubrics/`, and the file name must match the id: the `bug-report` rubric lives in `~/.augur/rubrics/bug-report.json`. `AUGUR_HOME` moves `~/.augur`. The file is read on every grade, so edits apply right away.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Up to 48 characters: lowercase letters, digits, `-`, and `_`, starting with a letter. |
| `version` | yes | Whole number, 1 or higher. Labels are counted per version, so raising it after a wording change sends the rubric back to shadow. |
| `stakes` | yes | `low` if a wrong grade costs a retry or a re-read, `medium` if it costs a wasted review or a wrong pick, `high` if it does real harm. |
| `intro` | no | Placed in front of every dimension's instructions. Use it to say what the task and the candidate are. |
| `passAt` | no | Overall score from 0 to 1 needed to pass. A rubric without it never returns pass or fail. |
| `maxSpread` | no | Largest disagreement allowed between the two question orders on any dimension before a gated grade goes to `review`. Greater than 0, at most 1, default 0.34. |
| `dimensions` | yes | 1 to 12 dimensions. |

Dimension fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Up to 32 characters: lowercase letters, digits, and `_`, starting with a letter. Unique within the rubric. |
| `instructions` | yes | A question about the candidate, for example "Does the report give steps that reproduce the bug?" |
| `levels` | yes | 2 to 10 sentences, worst first. Each describes what an answer at that level looks like. |
| `weight` | no | Weight in the overall score, greater than 0 and at most 100. Default 1. |

Unknown fields are ignored. A broken file is reported with all of its problems at once, and `augur grade --report` lists it after the rubrics as `Cannot use: <reason>`.

Example:

```json
{
  "id": "bug-report",
  "version": 1,
  "stakes": "low",
  "intro": "The task asks for a report of a software bug, and the candidate is the report.",
  "passAt": 0.6,
  "dimensions": [
    {
      "id": "steps",
      "instructions": "Does the report give steps that reproduce the bug?",
      "levels": ["No steps are given.", "Some steps are given, but a reader could not follow them to the bug.", "The steps reach the bug, with one or two gaps a reader can fill.", "The steps reach the bug exactly, starting from a clean state."],
      "weight": 2
    },
    {
      "id": "expected",
      "instructions": "Does the report say what was expected and what happened instead?",
      "levels": ["Neither is stated.", "Only one of the two is stated.", "Both are stated clearly."]
    },
    {
      "id": "environment",
      "instructions": "Does the report name the version and the platform where the bug appeared?",
      "levels": ["Neither is named.", "One of them is named.", "Both are named."]
    }
  ]
}
```

## How a grade is computed

The backend receives the task, the candidate, and, if given, a reference answer. Every dimension becomes two score questions with the same instructions: `intro`, then "Judge only the candidate answer against the task.", then the dimension's `instructions`. The first lists the levels worst to best and the second best to worst. Models tend to favor whichever option comes first, and asking both ways cancels that out.

Both answers are converted to a 0 to 1 scale, where 0 is the worst level. The dimension's score is their mean and its spread is the gap between them. On a three-level dimension, answers of "best" and "middle" give a score of 0.75 with a spread of 0.5, which says the model was unsure. If only one order is answered the spread is set to 1. If a dimension gets no answer in either order, the whole grade fails with "The backend did not answer every dimension."

`overall` is the weighted mean of the dimension scores and `uncertainty` is the largest spread. Both are rounded to three decimals.

The task may be up to 6,000 characters and the candidate up to 20,000. Longer input is rejected instead of truncated; split a long candidate and grade the parts.

## Data tiers

Pass `--tier` to say how sensitive the text is. Without it, text with student or grading wording in the task, candidate, or reference is treated as `regulated`, and everything else as `internal`.

`public` and `internal` text goes to whichever decision backend the service uses. `sensitive` and `regulated` text goes only to Laya, on the servers in `decision.servers` in the service's `config.json`, or `http://127.0.0.1:8010` if that list is empty. If none of them answers, the grade fails with a "no Laya server answered" error and nothing is sent to Jev.

## Shadow, advise, and gate

Every grade reports the mode its rubric is in:

- `shadow`: the grade is saved for comparison with people's labels. Nothing should act on it. New rubrics and new versions start here.
- `advise`: the grade can be shown next to the work, but a person makes the call.
- `gate`: the caller may act on `verdict`. Some verdicts are flagged for a person to spot check.

The mode depends on how many grades of the current version have a label and what share of them were labelled `agree`:

| Stakes | `advise` | `gate` | Spot checks in `gate` |
| --- | --- | --- | --- |
| `low` | 10 labelled, 70% agree | 30 labelled, 85% agree | 10% |
| `medium` | 30 labelled, 80% agree | 100 labelled, 92% agree | 25% |
| `high` | 100 labelled, 90% agree | not available | none |

Only the latest label on each grade counts, and only the 200 most recent labelled grades are considered. The mode is recomputed for each new grade from the labels that exist at that moment, which means a rubric can fall back from `gate` to `advise` if people start disagreeing with it.

`verdict` is only set in `gate` mode, and only for a rubric with `passAt`. If `uncertainty` is above `maxSpread` the verdict is `review`. Otherwise it is `pass` when `overall` is at least `passAt`, and `fail` when it is lower. The spot-check rate in the table is the share of pass and fail verdicts flagged for a person to check. Which grades get flagged depends only on the grade id, so asking again never changes the answer. In `shadow` and `advise` the verdict is `null`.

## Commands

```bash
augur grade <rubric> --task <text|@file> --candidate <text|@file> [--reference <text|@file>] [--tier <tier>]
```

Each text option takes the text itself or `@path`, which reads a file relative to the current folder. `--tier` accepts `public`, `internal`, `sensitive`, or `regulated`. Output for the example rubric above:

```text
Grade 3f9c2a1b7d4e: overall 0.81 on bug-report v1 (internal tier, jev). Mode shadow.
  steps                1.00
  expected             0.75  (orders differ by 0.50)
  environment          0.50
```

A dimension line gets the "orders differ" note when its spread is over 0.2. In `gate` mode the first line also shows the verdict, such as `Mode gate, verdict pass, flagged for a spot check.` With `--json` the command prints the full result: `id`, `rubric`, `version`, `tier`, `backend`, `dims` (each with `score` and `spread`), `overall`, `uncertainty`, `mode`, `verdict`, and `audit`, which is `true` for a grade flagged for a spot check.

```bash
augur grade --report [<rubric>]
```

Prints one line per rubric, or just the named one:

```text
bug-report v1 (low stakes): shadow; 12 graded, 4 labelled, 50% agree (1 too high, 1 too low); next: 10 labelled grades with 70% agreement for advise (now 4, 50%)
```

```bash
augur label <grade id> --grade agree|high|low [--note <text>]
```

Records a person's verdict on a grade. Use `high` when the grade was too generous and `low` when it was too harsh. Notes are cut to 200 characters. A second label on the same grade replaces the first. The command replies with the rubric's mode after the change, for example `Recorded: the grade was agree. Rubric bug-report is in shadow mode.`

## What is recorded

Grades and labels are appended to `decisions.jsonl`, in `%LOCALAPPDATA%\Augur\dispatch` on Windows and `~/.local/share/augur/dispatch` on macOS and Linux. A grade line has the grade id and time, the rubric id and version, the tier, the backend, `overall`, `uncertainty`, every dimension's score and spread, the mode, the verdict, the spot-check flag, and a 16-character SHA-256 prefix of the task and of the candidate.

The task and candidate text are saved only if Keep task text (`learn.recordTasks`, off by default) is on in the service settings, the tier is `public` or `internal`, and the text contains no student wording. The reference answer is never saved. A label line has the grade id, the label, the time, and the note.
