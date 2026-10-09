---
name: qa-review
description: The QA reviewer's cockpit. Pull the Under Review queue for a feature from ClickUp (or a local statuses file without a tracker), sorted by priority with failures first and evidence attached or located, enforce the evidence sampling rules, and record Approve, Reject-with-reason, or Retest decisions back, and file a linked bug for every failure QA confirms is a real defect. Traces that stay on the executor's machine (production always, and by default elsewhere) are reviewed there and verified by hash. Also runs design review on freshly authored cases awaiting approval. Use when the user says "qa review", "review the run", "review the cases", or "/qa-review <feature>".
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

Use `clickup_filter_tasks` on the feature's list. **Under `tracker: none`** there is no board: read `testing/<feature>/statuses.json`, where the names are the canonical seven, and take each case's verdict and evidence from the run's `report.json`.

## 2. Design review

QA reviews the **scenario matrix first**, then individual cases. Present:

1. The scenario mix: which of happy / negative / boundary / permission / data-validation are covered, and the stated reason for anything marked `n_a`. A missing permission case on a role-aware feature is the hole to catch here. It is not a formatting problem, it is a coverage one.
2. **Every P0 and P1 case individually**: title, steps, expected outcomes. These are the ones whose assertions decide whether the feature reads Ready.
3. **P2 cases in bulk**, at matrix level: one judgment across the group. Reviewing 25 cases × 5 developers individually recreates the bottleneck at the design gate, which is the thing this system is built to avoid.
4. **The requirements, when the cases file declares them.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-cases.mjs" testing/<feature>/cases.yaml --profile <profile-path>` and read what it prints. Each `warning: criterion <requirement id>/<criterion id> is covered by no case` is an uncovered criterion, a design gap that is QA's to decide: ask for a case, or accept the gap on the record. A dangling `covers` (`names no declared criterion`, or a malformed entry) is a mistake in the file, an error, and the cases are not ready for approval until it is fixed. Also check that each `covers` names criteria the case's expected outcomes would actually catch: the lint proves the reference resolves, not that the case tests it. A file with no `requirements` has nothing to check here.

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

Compute the quotas from the actual queue and tell the user the numbers up front ("7 items must be watched: 2 failures, 4 P0 passes, and 1 of 3 P1 passes"). Track which have been watched as you go, and say plainly when the quota is unmet, because an unmet sampling quota means the confidence number is less trustworthy than it looks.

Present the queue sorted: failures first, then by priority. For each item give the case title, verdict, executor, environment and SHA, and the trace attachment on its task. For a failure, show the `failure_summary` from the report: it is the Playwright error verbatim, which is what makes it triageable.

**How to watch a case.** Where the run's environment sets `evidence_upload: reference` (the default off production) or `local`, no trace is on the task: follow "When the evidence stayed on the machine" below. Only when it sets `evidence_upload: tracker` is `trace.zip` attached to the ClickUp task; download it and open it with `npx playwright show-trace <file>`, which runs entirely on this machine. Prefer that to dropping the file on <https://trace.playwright.dev> for any trace that carries a credential, which is every trace: the viewer runs in the browser and Playwright's docs say it does not transmit data externally, but a file that holds a live session is better opened where you do not have to rely on that.

Tell reviewers what the trace gives them, because it is more than the old video was: a scrubable film-strip of every action, the DOM at each step, the console output, and the network log, all on one timeline. "Watching the evidence" means scrubbing to the failing action and reading the DOM there, not just watching a recording and forming an impression.

### When the evidence stayed on the machine

Every production run, any run whose environment sets `evidence_upload: reference` (the default off production) or `local`, and any run whose profile says `tracker: none`, keeps its traces on the machine that ran them. No trace was attached to the tracker. Under `reference` the case task still carries the verdict fields and the failure text, but not the trace; under `local` and on production it holds neither, only the trace's path and sha256. So:

**The review happens on the executor's machine**, or from a location the host chooses outside the tracker, such as an encrypted share the team controls. Not from the tracker. Find each trace from the case's `Trace Path` field (or `cases[].trace` in the run's `report.json`), relative to `testing/<feature>/runs/<run_id>/`, open it with `npx playwright show-trace <path>` rather than the hosted viewer, and **verify it before opening it**:

```bash
shasum -a 256 testing/<feature>/runs/<run_id>/<trace path>
```

The digest must equal the case's `Trace SHA256` field (`cases[].trace_sha256` in the report). If it does not, the file is not the evidence that was published: do not review it, and record the case as `retest`. For a failure, read the `failure_summary` from `report.json` there too; under `local` and on production the tracker deliberately does not carry it.

**The sampling quotas cannot be met from the tracker alone.** If the reviewer has no access to the executor's machine or the host's chosen location, say so plainly, review nothing from the tracker as if it were evidence, and record the quotas as unmet in the close-out. Treat the trace as a credential wherever it is opened: it carries a live session from the environment it ran against.

## 4. Record decisions

**Under `tracker: none`**, a decision is an edit to `testing/<feature>/statuses.json`: set the case to the canonical name for the decision (`Approved`, `Rejected`, `Retest`, `Approved for Execution` at design review), and record a rejection's reason tag in `testing/<feature>/review-log.json` as `{"<CASE-ID>": {"decision": "rejected", "reason": "<tag>", "run_id": "..."}}`. No write flag is needed. Everything below about ClickUp names and flags then does not apply.

With ClickUp, set the write flag at the repo root, next to the profile, before ClickUp writes and remove it after:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

The flag expires after 30 minutes; re-`touch` it if a long review session starts getting denied.

- **Approve** → this host's name for `approved`. The case counts toward the confidence numerator only when its verdict was also a pass, and it stays executable: the next build regresses it automatically. If the spec is unchanged and passes again, the approval carries forward untouched, which is what turns this from a one-shot into a suite. Record the accepted spec hash in `testing/<feature>/approved.json` and commit it, because approval means approved-for-this-spec: an edited spec sends the case back here rather than inheriting a verdict it never earned. This step is where the ledger is seeded: publishing can keep an entry that exists but never creates the first one (see "Record the approvals" below).

  Approving a **confirmed real failure** is the right call: it records that a human looked and agreed the feature is broken, not that the feature works. It does not raise the score, since only an approved pass counts, so file the bug and say plainly that the feature is Not Ready.
- **Reject** → its name for `rejected`, **plus a reason tag**. Use a consistent vocabulary: `bad-assertion`, `env-issue`, `wrong-expected`, `insufficient-evidence`, `selector-fragile`, `test-data-collision`. There is deliberately no tag for a broken feature: rejection means the *test* was wrong, and a real break is an approved verdict plus a bug (step 5). These tags are the feedback loop: the weekly standards review reads their distribution and edits the skills and host profile accordingly. A rejection with no tag teaches nothing.
- **Retest** → its name for `retest`. For environment problems and expired sessions, not for real failures.

### Record the approvals

After **result review** Approve decisions only, never after design approval (a case approved for execution has no verdict or spec hash yet), seed the ledger. Group the approved case IDs by the run that produced the verdict each was approved on (the case's `Run ID` field, or the run being reviewed), and run this once per run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" --record-approvals \
  --verdicts testing/<feature>/runs/<run_id>/report.json \
  --approved testing/<feature>/approved.json \
  --ids <CASE-ID,CASE-ID>
```

It prints `{ "approved_ledger": { ... } }`. Write that object to `testing/<feature>/approved.json` before the next run's group, so each run builds on the last, and commit it. A missing `approved.json` starts a new ledger and says so. For a case whose verdict was a pass it records the run's spec hash; for an approved confirmed failure it removes any entry, because a failure is not a baseline. Under `tracker: none`, check that the file is tracked, as `/qa-pilot:publish-results` step 5 does:

```bash
git ls-files --error-unmatch testing/<feature>/approved.json
```

If the report is not on this machine, say so and record nothing for those cases: they stay approved in the tracker but neither carry forward nor run in CI until someone records them where the report is.

Without this step an approved case has no ledger entry, so its next passing run goes back to review, and CI, which reads only `approved.json`, selects nothing.

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
  --specs testing/<feature>/specs.json \
  --bugs testing/<feature>/bugs.json \
  --profile <profile-path>
```

**Do not write the bug description yourself.** The script assembles it from the report and the cases file, and the failure text in it is Playwright's, verbatim. A summarized error is one a developer cannot trust, so they open the trace instead and the ticket has bought nothing. Post what the script returns, unedited.

What it puts in the body depends on where the run's evidence went, and you never override it:

- **`evidence_upload: reference`** (the default off production): the body carries the failure text, as under `tracker`, but no trace is attached; it names the trace's run-relative path and its `trace_sha256`, to be opened on the machine that ran it.
- **Evidence stayed local** (every production run): the body and any repeat comment carry no failure text, URL or executor, only the case, the run, the build, and the trace's run-relative path with its `trace_sha256`, and `trace_attachment` is null. Do not paste the failure in, even though you just read it on the executor's machine: that is exactly the production data the tracker must not receive.
- **`tracker: none`**: each `create[]` entry has a `file` instead of a list, `testing/<feature>/runs/<run_id>/bugs/<CASE-ID>.md`. Write `body` to that file. It keeps the full failure text, because it never leaves the machine. There is no task to link and no comment to post.

It returns three lists:

- **`create[]`**: file each as a new task. Use `title` and `body` as given, apply `tags`, set the priority from `priority`, and link it to the case task with `clickup_add_task_link`. Native task links rather than a custom field: a bug has its own lifecycle owned by the developers, not by QA-Pilot. If `supersedes` is set, say so in a comment on the older bug rather than closing it, since only a human should decide the old one is dead.
- **`comment[]`**: this failure is already filed. Post the comment on the existing bug instead of creating a second one. A weekly regression run against an unfixed bug would otherwise file it every week.
- **`skipped[]`**: report each with its reason. A case is skipped when it passed, when it is missing from the run or the cases file, or when it has no recorded error, and each of those means the bug could not have been evidenced.

Where they land: `clickup.bug_list` in the profile, if it is set. If it is not, they land in the feature list beside the case tasks and the script warns; name a bug list to keep the case board readable.

**Write `ledger` back to `testing/<feature>/bugs.json` and commit it**, filling in each new task's `task_id` from the ClickUp response. That file is what makes deduplication work on the next run. Without it, every regression run refiles every open bug.

Under `tracker: none` there is no task and no deduplication: each run's bugs are its own files, and the script never turns a repeat into a comment. Write `ledger` back all the same, with `task_id` left `null`. It still records each failure's signature and the runs it was seen in, so a reader can tell a recurring defect from a new one, and it keeps the ledger valid if the host later moves to a tracker.

If `testing/` is gitignored, the ledger still works for whoever holds it and deduplication simply does not survive to another machine. Worth mentioning once, not worth blocking on:

```bash
git ls-files --error-unmatch testing/<feature>/bugs.json
```

The bug body tells the reader the trace is a credential, because it is: it carries the session token that authenticated the run. See "What a trace contains" in `SETUP-CLICKUP.md`.

## 6. Close out

Report: how many were reviewed, the decisions taken, the bugs filed and the bugs that were already open, whether the sampling quotas were met, the updated confidence score, and whether the feature reads Ready or Not Ready. For a run whose evidence stayed on the machine (`reference` or `local`), also say where the traces were reviewed (the executor's machine, or the host's chosen location) and that each was verified against its sha256; if the reviewer could not reach them, say the quotas cannot be met from the tracker alone and were not met.

When the cases file declares requirements, recompute with `node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" --cases testing/<feature>/cases.yaml --statuses <current statuses.json> --verdicts testing/<feature>/runs/<run_id>/report.json --profile <profile-path>`, where the current statuses file is written the way `/qa-pilot:publish-results` step 4 writes it, fetched now from the tracker (or copied from `testing/<feature>/statuses.json` under `tracker: none`) so it holds the decisions just taken; the file from publish time predates them; the script exits 1 when no case is currently executable and still prints the full output, so read it anyway. Read its `requirements` (it is absent when none are declared, or when the block has lint errors, in which case a warning says so: send the file back through `validate-cases.mjs`). Report the counts and name the criteria by id: `uncovered` (no case covers it), `failing` (a covering case failed or went flaky, which one pass does not hide), `proved` (a covering case passed and QA approved that pass) and `unproved` (covered, but not yet proved: awaiting review, blocked, or no verdict). Coverage sits beside the confidence score and changes neither it nor the readiness; say so, and do not call a feature covered while any criterion is not `proved`.

**Any P0 that is not an approved pass means Not Ready regardless of score**, so say it explicitly rather than letting a percentage speak for itself. Approving a confirmed failure is the correct action and does not raise the score: it records that a human looked and agreed the feature is broken. A feature can therefore be fully reviewed, with every verdict accepted, and still read Not Ready, which is the pipeline working rather than failing.

Then flag anything that should feed the weekly standards edit: repeated rejection reasons, cases that flake across runs, selectors that keep breaking.
