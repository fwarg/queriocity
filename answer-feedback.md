# Answer feedback and research eval

Experimental. Two tools for measuring how well Queriocity's research answers questions, and for collecting data to improve it later:

- **Answer feedback**: users who opt in rate answers in the chat, and each answer's research trace is stored with the rating.
- **Research eval**: a script that runs the research pipeline over questions with known answers and scores the results.

Together they are meant to feed an offline improvement loop based on the WikiSkill method, which reviews traces and proposes research "skills" that an admin approves. That loop is not built yet.

## Answer feedback

### Turning it on

It is off for every user. Each user turns it on for themselves under **Settings → Answer feedback**. While it is off, nothing is recorded, no rating buttons are shown and the server refuses ratings.

### Rating an answer

Every saved answer gets 👍 and 👎 buttons in its action row, next to the pin.

- **👍**: the answer did its job. A comment box opens; filling it in is optional.
- **👎**: the answer did not. Pick one or more reasons and add a comment if you like:

  | Reason | Meaning |
  |---|---|
  | Wrong facts | The facts are incorrect |
  | Outdated | Correct once, but no longer |
  | Bad or missing sources | Citations don't support the claims, or are missing |
  | Incomplete | Part of the question went unanswered |
  | Off-topic | Answers a different question |
  | Too long | Right content, too much of it |

- Clicking the thumb that is already active withdraws the rating.
- The thumb is saved as soon as you click it. Reasons and the comment are saved when you press **Send**, and you can come back and change them later.

**Rating advice**

- Rate good answers as well as bad ones. The method learns from the contrast between them, so a 👍 is as useful as a 👎.
- On a 👎, pick a reason. "Wrong facts" and "Bad or missing sources" call for different fixes.
- Rate within 30 days (see [Retention](#retention)). Rating in a batch at the end of the day works fine.

### Implicit signals

These are recorded without a click:

- **Retry**: retrying an answer marks the replaced answer as a failure and keeps its trace.
- **Save as note**: saving an answer as a note counts as a sign it was useful.

### What is stored

- **Feedback** (`message_feedback`): rating, reasons, comment and the retry flag.
- **Trace** (`research_traces`, gzipped JSON):
  - the question, how many earlier messages the chat had, the focus mode and the model;
  - the searches run, the sources found (with 300-character snippets) and the pages read;
  - any warnings, and the final answer.
- A trace is a few kilobytes, so at family-sized usage this comes to tens of MB a year.

Locked chats, temporary chats and answers served from the cache are never traced.

### Retention

- An unrated trace is deleted after 30 days.
- A trace with any signal (a rating, reason, comment, retry or saved note) is kept until its chat is deleted.
- Deleting a turn deletes its feedback and trace. Deleting a chat or a user deletes everything for that chat or user.

### Checking what has been collected

```sql
SELECT rating, regenerated, count(*) FROM message_feedback GROUP BY 1, 2;
SELECT count(*), sum(length(trace)) / 1e6 AS mb FROM research_traces;
```

## Research eval

`scripts/research-eval.ts` runs the real research pipeline (pre-search, researcher and writer) without the UI. It runs over questions with known answers and scores each answer.

### Running it

Run it where the models and search are reachable, with the same environment as the server:

```sh
bun run scripts/research-eval.ts                      # all questions, one run, balanced mode
bun run scripts/research-eval.ts --runs 3             # three runs, to measure noise
bun run scripts/research-eval.ts --category lookup    # one category
bun run scripts/research-eval.ts --ids sqlite-year    # selected questions (comma-separated)
bun run scripts/research-eval.ts --mode thorough
```

| Flag | Default | Meaning |
|---|---|---|
| `--file` | `scripts/eval/research-questions.jsonl` | Questions file |
| `--mode` | `balanced` | `balanced` or `thorough` |
| `--runs` | `1` | Times to run each question |
| `--ids` | all | Comma-separated question ids |
| `--category` | all | Only questions in this category |
| `--out` | `eval-results/<timestamp>` | Output directory |
| `--db` | in-memory | Database to use (see below) |
| `--timeout` | `600` | Seconds per question |

**Database**

- By default the eval uses an empty in-memory database, so admin search settings are at their defaults.
- To measure with your own settings, pass a **copy** of the production database. The script migrates the database it opens:

  ```sh
  cp queriocity.db /tmp/eval.db
  bun run scripts/research-eval.ts --db /tmp/eval.db --runs 3
  ```

- Each question is a full research turn. On a local model a full run can take hours, so start small (`--category lookup --runs 2`).

### What it measures

- **judge**: the chat model's verdict, CORRECT or INCORRECT, against the reference answer. It handles paraphrase, but it is a model and can be wrong.
- **contains**: whether the reference answer or one of its aliases appears in the answer as whole words. It misses paraphrase, and it also passes "not 1967" when the answer is 1967.
- **citation validity**: the share of `[n]` citations that point at a source that exists.
- **effort**: search queries, pages read and elapsed time.
- **errors**: turns that failed, for example because a model was unreachable. These are counted separately, not as wrong answers.

### Output

- `report.json` in the output directory: every score, plus summaries overall, per category and per run.
- `traces/<run>-<id>.json`: one trace per question, in the same format the answer feedback stores.
- `eval-results/` is gitignored.

**Reading the results:** the per-run summaries show how much the score moves with nothing changed. Treat a later difference as real only if it is clearly larger than that spread.

### Questions file

The file has one JSON object per line. Blank lines and lines starting with `//` are skipped.

```json
{"id": "sqlite-year", "category": "control", "question": "In what year was the SQLite database engine first released?", "answer": "2000"}
{"id": "x", "question": "…", "answer": "Stockholm", "aliases": ["Sthlm"], "category": "multihop"}
```

- `id`, `question` and `answer` are required.
- `aliases` lists other accepted spellings, used by `contains`.
- `category` groups questions in the report. The seed set uses three:
  - `control`: questions a model likely answers without searching;
  - `lookup`: single facts that need a search;
  - `multihop`: questions that combine two facts.

**Writing good questions**

- Use answers that are short, checkable and unlikely to change.
- Good candidates are questions from real chats that got a 👍 or 👎 and have a clear answer.

## Suggested workflow

1. Back up the production database, then deploy. Migration 3 → 4 adds the two tables.
2. Turn on Answer feedback for yourself, and ask other users to turn it on in their own settings.
3. Run a baseline eval with `--runs 3` and keep the report. Its per-run spread is your noise level.
4. Collect ratings for a few weeks. Aim for 20–30 👎 with reasons and a similar number of 👍.
5. Add checkable questions from rated chats to the questions file.
6. Then start the offline improvement loop (local notes, `development.md` section 12).
