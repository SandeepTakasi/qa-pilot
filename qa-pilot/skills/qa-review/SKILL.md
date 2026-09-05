---
name: qa-review
description: The QA reviewer's cockpit. Pull the Under Review queue for a feature from ClickUp, sorted by priority with failures first and evidence links attached, enforce the evidence sampling rules, and record Approve, Reject-with-reason, or Retest decisions back to ClickUp, and file a linked bug for every failure QA confirms is a real defect. Also runs design review on freshly authored cases awaiting approval. Use when the user says "qa review", "review the run", "review the cases", or "/qa-review <feature>".
argument-hint: "<feature>"
---

# qa-review: QA's queue, not QA's execution

QA owns every verdict in this system. This skill exists to make reviewing fast enough that one reviewer can keep up with five producers, by sorting the queue, attaching the evidence, and tracking the sampling quotas, so QA spends their attention on judgment instead of navigation.

You are the assistant here, not the reviewer. Never mark a case Approved on your own reading of the evidence. Present, then record what the human decides.

Recommended model: any current model.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP, point at `/qa-pilot:qa-init`.

## 1. Pick the queue

Ask which the user wants, or infer from what is actually waiting:

- **Design review**: cases in `case_review`, authored but not yet executable
- **Result review**: cases in `under_review` or `quarantined`, executed and awaiting a verdict decision

Those are lifecycle keys. Resolve each to this host's actual status name via the profile's `clickup.statuses` before you query or write, because the board uses the host's wording, not the canonical one.

Use `clickup_filter_tasks` on the feature's list.

## 2. Design review

QA reviews the **scenario matrix first**, then individual cases. Present:

1. The scenario mix: which of happy / negative / boundary / permission / data-validation are covered, and the stated reason for anything marked `n_a`. A missing permission case on a role-aware feature is the hole to catch here. It is not a formatting problem, it is a coverage one.
2. **Every P0 and P1 case individually**: title, steps, expected outcomes. These are the ones whose assertions decide whether the feature reads Ready.
3. **P2 cases in bulk**, at matrix level: one judgment across the group. Reviewing 25 cases × 5 developers individually recreates the bottleneck at the design gate, which is the thing this system is built to avoid.

For each decision, move the task to this host's name for `approved_for_execution`, or for `rejected` with a tagged reason. Nothing executes until it is approved.

## 3. Result review and the sampling rules

**First check what the run actually captured.** If its `evidence_capture` was `on-failure`, passing cases have no trace, so the pass quotas below cannot be met. Say that plainly rather than asking QA to sample what does not exist, and note that a false pass in that run cannot be caught by review. The failure quota still applies in full.

Not every pass needs to be watched, but the sampling must be honest and tracked:

| | Requirement |
|---|---|
| **All failures** | Watch the evidence. Every one. |
| **P0 passes** | Watch 100%. |
| **P1 passes** | Sample at least 30%. |
| **P2 passes** | Sample at least 10%. |
| **Any executor over the false-pass threshold** | Raise their rates until it comes down. |

Compute the quotas from the actual queue and tell the user the numbers up front ("7 items must be watched: 2 failures, 4 P0 passes, and 1 of 3 P1 passes"). Track which have been watched as you go, and say plainly when the quota is unmet, because an unmet sampling quota means the confidence number is less trustworthy than it looks.

Present the queue sorted: failures first, then by priority. For each item give the case title, verdict, executor, environment and SHA, and the trace attachment on its task. For a failure, show the `failure_summary` from the report: it is the Playwright error verbatim, which is what makes it triageable.

**How to watch a case.** Download its `trace.zip` from the ClickUp task and drop it on <https://trace.playwright.dev>. The viewer runs entirely in the browser (Playwright's docs state it "does not transmit any data externally"), so nothing is uploaded and no account is needed. `npx playwright show-trace <file>` opens the same thing locally.

Tell reviewers what the trace gives them, because it is more than the old video was: a scrubable film-strip of every action, the DOM at each step, the console output, and the network log, all on one timeline. "Watching the evidence" means scrubbing to the failing action and reading the DOM there, not just watching a recording and forming an impression.

## 4. Record decisions

Set the write flag before ClickUp writes and remove it after:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

The flag expires after 30 minutes; re-`touch` it if a long review session starts getting denied.

- **Approve** → this host's name for `approved`. The case counts toward the confidence numerator only when its verdict was also a pass, and it stays executable: the next build regresses it automatically. If the spec is unchanged and passes again, the approval carries forward untouched, which is what turns this from a one-shot into a suite. Record the accepted spec hash in `testing/<feature>/approved.json` (`/qa-pilot:publish-results` writes it from the run's `report.json`) and commit it, because approval means approved-for-this-spec: an edited spec sends the case back here rather than inheriting a verdict it never earned.

  Approving a **confirmed real failure** is the right call: it records that a human looked and agreed the feature is broken, not that the feature works. It does not raise the score, since only an approved pass counts, so file the bug and say plainly that the feature is Not Ready.
- **Reject** → its name for `rejected`, **plus a reason tag**. Use a consistent vocabulary: `bad-assertion`, `env-issue`, `wrong-expected`, `insufficient-evidence`, `selector-fragile`, `test-data-collision`. There is deliberately no tag for a broken feature: rejection means the *test* was wrong, and a real break is an approved verdict plus a bug (step 5). These tags are the feedback loop: the weekly standards review reads their distribution and edits the skills and host profile accordingly. A rejection with no tag teaches nothing.
- **Retest** → its name for `retest`. For environment problems and expired sessions, not for real failures.

## 5. File the confirmed defects

A `fail` verdict has two possible readings, and they get opposite treatment:

| What QA concluded | Case status | Bug |
|---|---|---|
| the test was wrong | `rejected` plus a reason tag | none |
| the test was right, the feature is broken | `approved` (the verdict is accepted) | **file one** |

Never weaken a case to make it pass. A test edited until it goes green is worse than no test, because it now certifies the broken behavior.

Collect the case IDs QA confirmed as real defects, then build the bug reports:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bug-report.mjs" \
  --report testing/<feature>/runs/<run_id>/report.json \
  --cases testing/<feature>/cases.yaml \
  --confirmed <CASE-ID,CASE-ID> \
  --specs testing/<feature>/runs/<run_id>/specs.json \
  --bugs testing/<feature>/bugs.json \
  --profile <profile-path>
```

**Do not write the bug description yourself.** The script assembles it from the report and the cases file, and the failure text in it is Playwright's, verbatim. A summarized error is one a developer cannot trust, so they open the trace instead and the ticket has bought nothing. Post what the script returns, unedited.

It returns three lists:

- **`create[]`**: file each as a new task. Use `title` and `body` as given, apply `tags`, set the priority from `priority`, and link it to the case task with `clickup_add_task_link`. Native task links rather than a custom field: a bug has its own lifecycle owned by the developers, not by QA-Pilot. If `supersedes` is set, say so in a comment on the older bug rather than closing it, since only a human should decide the old one is dead.
- **`comment[]`**: this failure is already filed. Post the comment on the existing bug instead of creating a second one. A weekly regression run against an unfixed bug would otherwise file it every week.
- **`skipped[]`**: report each with its reason. A case is skipped when it passed, when it is missing from the run or the cases file, or when it has no recorded error, and each of those means the bug could not have been evidenced.

Where they land: `clickup.bug_list` in the profile, if it is set. If it is not, they land in the feature list beside the case tasks and the script warns; name a bug list to keep the case board readable.

**Write `ledger` back to `testing/<feature>/bugs.json` and commit it**, filling in each new task's `task_id` from the ClickUp response. That file is what makes deduplication work on the next run. Without it, every regression run refiles every open bug.

The bug body tells the reader the trace is a credential, because it is: it carries the session token that authenticated the run. See "What a trace contains" in `SETUP-CLICKUP.md`.

## 6. Close out

Report: how many were reviewed, the decisions taken, the bugs filed and the bugs that were already open, whether the sampling quotas were met, the updated confidence score, and whether the feature reads Ready or Not Ready.

**Any P0 that is not an approved pass means Not Ready regardless of score**, so say it explicitly rather than letting a percentage speak for itself. Approving a confirmed failure is the correct action and does not raise the score: it records that a human looked and agreed the feature is broken. A feature can therefore be fully reviewed, with every verdict accepted, and still read Not Ready, which is the pipeline working rather than failing.

Then flag anything that should feed the weekly standards edit: repeated rejection reasons, cases that flake across runs, selectors that keep breaking.
