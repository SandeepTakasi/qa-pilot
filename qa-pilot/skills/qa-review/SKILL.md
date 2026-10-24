---
name: qa-review
description: The QA reviewer's cockpit. Pull the review queue for a feature, enforce the evidence sampling rules, record Approve, Reject-with-reason or Retest decisions, and file a linked bug for each failure QA confirms is a real defect. Also runs design review on freshly authored cases. Use when the user says "qa review", "review the run", "review the cases", or "/qa-review <feature>".
argument-hint: "<feature>"
---

# qa-review: QA's queue, not QA's execution

QA owns every verdict. This skill speeds review by sorting the queue, locating the evidence and tracking the sampling quotas, so QA spends attention on judgment.

You are the assistant, not the reviewer. Never mark a case Approved on your own reading of the evidence. Present, then record what the human decides.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit: STOP, point at `/qa-pilot:qa-init`. When the profile's `tracker` is `clickup`, read `references/clickup.md` now; it holds the ClickUp-only steps.

Then `git pull`: the run records, the approval ledger and the bug ledger come through git. Note the time now as the session's `started_at` (step 6 records it).

## 1. Pick the queue

Ask which the user wants, or infer from what is waiting:

- **Design review**: cases in `case_review`, authored but not executable
- **Result review**: cases in `under_review` or `quarantined`, awaiting a verdict decision

These are lifecycle keys; resolve them to the host's status names through the profile. **Under `tracker: none`** there is no board: read `testing/<feature>/statuses.json` (canonical names).

Each published run has a committed record, `testing/<feature>/verdicts/<run_id>.json`: every case's verdict, the spec hash it ran under, its trace path and sha256, and the failure text where the tracker receives it. Read verdicts from it on any machine; the run's own `report.json` exists only where the run happened.

## 2. Design review

Review the **scenario matrix first**, then cases. Present:

1. The scenario mix: which of happy / negative / boundary / permission / data-validation are covered, and the stated reason for each `n_a`. A missing permission case on a role-aware feature is a coverage hole to catch here.
2. **Every P0 and P1 case individually**: title, steps, expected outcomes. Their assertions decide whether the feature reads Ready.
3. **P2 cases in bulk**, at matrix level: one judgment across the group.
4. **The requirements, when the cases file declares them.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-cases.mjs" testing/<feature>/cases.yaml --profile <profile-path>`. Each `warning: criterion <requirement id>/<criterion id> is covered by no case` is a design gap that is QA's to decide: ask for a case, or accept the gap on the record. A dangling or malformed `covers` is an error, and the cases are not ready for approval until fixed. Also check that each `covers` names criteria the case's expected outcomes would actually catch: the lint proves the reference resolves, not that the case tests it. No `requirements`, nothing to check.

Move each decided task to `approved_for_execution`, or to `rejected` with a tagged reason. Nothing executes until approved.

## 3. Result review and the sampling rules

**First check what the run captured.** If its `evidence_capture` was `on-failure`, passing cases have no trace and the pass quotas cannot be met. Say so, note that a false pass in that run cannot be caught by review, and apply the failure quota in full.

| | Requirement |
|---|---|
| **All failures** | Watch the evidence. Every one. |
| **P0 passes** | Watch 100%. |
| **P1 passes** | Sample at least 30%. |
| **P2 passes** | Sample at least 10%. |

Compute the quotas from the actual queue and state them up front ("7 items must be watched: 2 failures, 4 P0 passes, and 1 of 3 P1 passes"). Track what has been watched, and say plainly when a quota is unmet: the confidence number is then less trustworthy than it looks.

Present the queue sorted failures first, then by priority. For each item give the case title, verdict, executor, environment and SHA, and the trace attachment under `tracker`, or its Trace Path and Trace SHA256 otherwise. For a failure, show `failure_summary` from the run record: the Playwright error verbatim.

**Watching a case.** Under `evidence_upload: tracker`, `trace.zip` is attached to the task (see `references/clickup.md`); otherwise follow the next section. Open a trace with `npx playwright show-trace <file>`; prefer it to the hosted viewer for any trace that carries a credential, which is every trace. It gives a film-strip of every action, the DOM at each step, the console and the network log: watching means scrubbing to the failing action and reading the DOM there.

### When the evidence stayed on the machine

Every production run, any run under `evidence_upload: reference` or `local`, and any `tracker: none` run keeps its traces on the machine that ran them (under `reference` the task still carries verdict fields and failure text; under `local` and on production only the trace's path and sha256). **The review happens on the executor's machine**, or a location the host chooses outside the tracker. Find each trace from the case's `Trace Path` (or `cases[].trace` in the run record), relative to `testing/<feature>/runs/<run_id>/`, and **verify it before opening it**:

```bash
shasum -a 256 testing/<feature>/runs/<run_id>/<trace path>
```

The digest must equal the case's `Trace SHA256` (`cases[].trace_sha256`). If not, the file is not the published evidence: do not review it, and record the case as `retest`. For a failure under `local` and on production, read `failure_summary` from that run's `report.json` there: neither the tracker nor the run record carries it.

**The quotas cannot be met from the tracker alone.** If the reviewer cannot reach the executor's machine or the host's location, say so, treat nothing in the tracker as evidence, and record the quotas as unmet in the close-out. Treat the trace as a credential wherever it is opened.

## 4. Record decisions

**Under `tracker: none`**, a decision is an edit to `testing/<feature>/statuses.json`: set the canonical name (`Approved`, `Rejected`, `Retest`, `Approved for Execution` at design review), and record a rejection in `testing/<feature>/review-log.json` as `{"<CASE-ID>": {"decision": "rejected", "reason": "<tag>", "run_id": "..."}}`. No write flag is needed. With ClickUp, set the write flag and move tasks as `references/clickup.md` says.

- **Approve** → `approved`. It counts toward the confidence numerator only when its verdict was also a pass, and stays executable: an unchanged spec that passes again keeps its approval. Record the accepted spec hash (next section): an edited spec returns the case here instead of inheriting a verdict it never earned.

  Approving a **confirmed real failure** is correct: it records that a human agreed the feature is broken, not that it works, and does not raise the score. File the bug and say the feature is Not Ready.
- **Reject** → `rejected` **plus a reason tag**: `bad-assertion`, `env-issue`, `wrong-expected`, `insufficient-evidence`, `selector-fragile`, `test-data-collision`. There is no tag for a broken feature: rejection means the *test* was wrong, and a real break is an approved verdict plus a bug (step 5). The weekly standards review reads these tags; an untagged rejection teaches nothing.
- **Retest** → `retest`, for environment problems and expired sessions, not real failures.

### Record the approvals

After **result review** Approve decisions only (never after design approval: no verdict or spec hash exists yet), group the approved case IDs by the run that produced each verdict (the case's `Run ID`, or the run being reviewed), and run once per run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" --record-approvals \
  --verdicts testing/<feature>/verdicts/<run_id>.json \
  --approved testing/<feature>/approved.json \
  --ids <CASE-ID,CASE-ID>
```

It prints `{ "approved_ledger": { ... } }`. Write that object to `testing/<feature>/approved.json` before the next run's group, and commit it. A passing case records the run's spec hash; an approved confirmed failure removes any entry. Publishing keeps entries but never creates the first one, so without this step an approved case goes back to review on its next pass and CI, which reads only `approved.json`, selects nothing. Under `tracker: none`, check the file is tracked, as `/qa-pilot:publish-results` step 4 does:

```bash
git ls-files --error-unmatch testing/<feature>/approved.json
```

If `verdicts/<run_id>.json` is missing after the pull, the run was not pushed after publishing: ask the executor to push it, and record nothing until it arrives. A nonzero exit naming merge-conflict markers means `approved.json` is mid-merge: resolve it first, never replace it.

## 5. File the confirmed defects

A `fail` verdict has two readings:

| What QA concluded | Case status | Bug |
|---|---|---|
| the test was wrong | `rejected` plus a reason tag | none |
| the test was right, the feature is broken | `approved` (verdict accepted) | **file one** |

Never weaken a case to make it pass: a test edited until green certifies the broken behavior.

Collect the case IDs QA confirmed as real defects, then run the script below. Where the tracker gets failure text (`tracker` and `reference`), pass the run record, as shown. Where evidence stayed local (production, `local`, `tracker: none`) the record carries no failure text, so run it on the executor's machine with `--report testing/<feature>/runs/<run_id>/report.json` instead; given the record, it skips every failure for lack of an error to report.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bug-report.mjs" \
  --report testing/<feature>/verdicts/<run_id>.json \
  --cases testing/<feature>/cases.yaml \
  --confirmed <CASE-ID,CASE-ID> \
  --specs testing/<feature>/specs.json \
  --bugs testing/<feature>/bugs.json \
  --profile <profile-path>
```

**Do not write the bug description yourself.** The script assembles it with Playwright's failure text verbatim; post what it returns, unedited, and never override what the body holds:

- **Evidence stayed local** (every production run): no failure text; do not paste it in, even though you read it on the executor's machine: it is production data the tracker must not receive.
- **`tracker: none`**: each `create[]` entry has a `file` (`testing/<feature>/runs/<run_id>/bugs/<CASE-ID>.md`) instead of a list. Write `body` to it. No task to link, no comment to post.

It returns:

- **`create[]`**: new bugs to file.
- **`comment[]`**: the failure is already filed; comment on the existing bug rather than creating a second one.
- **`skipped[]`**: report each with its reason (passed, missing from the run or cases file, or no recorded error).

Filing `create[]` and `comment[]` on ClickUp is in `references/clickup.md`.

**Write `ledger` back to `testing/<feature>/bugs.json` and commit it**; it is what makes deduplication work on the next run. Under `tracker: none` there is no task or deduplication, but write `ledger` back all the same with `task_id` left `null`: it records each failure's signature and the runs it appeared in. If `testing/` is gitignored, deduplication does not survive to another machine; mention it once, do not block on it:

```bash
git ls-files --error-unmatch testing/<feature>/bugs.json
```

## 6. Close out

Report: how many were reviewed, the decisions taken, bugs filed and already open, whether the sampling quotas were met, the updated confidence score, and Ready or Not Ready. For a run whose evidence stayed on the machine, also say where the traces were reviewed and that each was verified against its sha256; if the reviewer could not reach them, say the quotas cannot be met from the tracker alone and were not met.

When the cases file declares requirements, recompute:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" --cases testing/<feature>/cases.yaml --statuses <current statuses.json> --verdicts testing/<feature>/verdicts/<run_id>.json --profile <profile-path>
```

Write the current statuses file as `/qa-pilot:publish-results` step 4 does, fetched now so it holds the decisions just taken. The script exits 1 when no case is executable and still prints everything. Read its `requirements` (absent when none are declared or the block has lint errors; a warning says so, so rerun `validate-cases.mjs`). Report the counts and name criteria by id: `uncovered`, `failing` (a covering case failed or went flaky), `proved` (a covering case passed and QA approved that pass), `unproved` (covered, not yet proved). Coverage changes neither score nor readiness; do not call a feature covered while any criterion is not `proved`.

**Any P0 that is not an approved pass means Not Ready regardless of score**; say so explicitly. A fully reviewed feature can still read Not Ready.

Then flag anything for the weekly standards edit: repeated rejection reasons, cases that flake across runs, selectors that keep breaking.

**Record the session** as `testing/<feature>/reviews/<started_at as YYYYMMDDTHHMMSSZ>.json`:

```json
{ "started_at": "<ISO time from step 0>", "finished_at": "<ISO time now>", "reviewer": "<who>",
  "decisions": [ { "id": "<CASE-ID>", "decision": "approved | rejected | retest", "kind": "design | result" } ] }
```

Then commit and push it with `approved.json` and `bugs.json`. `node "${CLAUDE_PLUGIN_ROOT}/scripts/pilot-report.mjs" testing/<feature>` turns these files into review minutes per decision, flaky and blocked rates, bugs filed, and the approved specs that have dropped out of CI.
