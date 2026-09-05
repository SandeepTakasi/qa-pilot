---
name: publish-results
description: Publish a completed test run to ClickUp. Deterministically transform the Playwright JSON report into report.json, hard-fail validation on missing evidence or provenance, then update each case task's custom fields and status and post one feature-level run summary. A report that fails validation is never published, so QA never has to police formatting. Use when the user says "publish results", "push the run to ClickUp", "report the run", or "/publish-results <feature>".
argument-hint: "<feature> [--run <run_id>]"
---

# publish-results: put the run into the record

Everything here except the ClickUp calls themselves is deterministic. Your job is to run the scripts, respect their verdict, and copy values, not to interpret, summarize, or improve them. **Every value you write to ClickUp comes from the validated `report.json`.** If a field is not in the report, it does not get written.

Recommended model: any current model. This step is mechanical by design.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP, print errors, point at `/qa-pilot:qa-init`.

## 1. Locate the run

`testing/<feature>/runs/<run_id>/`, either the newest or the one named by `--run`. It holds `meta.json` and the Playwright JSON report from `/qa-pilot:run-tests`. If neither exists, stop: there is nothing to publish, and you must not reconstruct a run from memory or from an agentic session.

## 2. Build the report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-report.mjs" <playwright-report.json> <meta.json> \
  --specs testing/<feature>/runs/<run_id>/specs.json -o report.json
```

`specs.json` is the `{"<CASE-ID>": "<path to its spec file>"}` map `/qa-pilot:run-tests` wrote. It makes each verdict record `spec_sha`, the hash of the spec that produced it. Without it approval cannot carry forward, because there is no way to tell an unchanged spec from a rewritten one, and every passing case goes back for review.

If it warns about specs with no case-ID prefix, surface that: those results are absent from the report and will not be published. Do not try to match them to cases yourself.

## 3. Validate, and obey the answer

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-report.mjs" report.json \
  --profile <profile-path> \
  --map testing/<feature>/clickup-map.json \
  --statuses testing/<feature>/runs/<run_id>/statuses.json \
  --base <dir relative artifact paths resolve against>
```

Pass `--statuses`. It is the statuses file recorded at the start of the run, and it is what proves each published case was approved. The map only proves a task exists, which every generated case does from the moment it is created, so without `--statuses` a hand-run of unapproved specs publishes cleanly.

Evidence is checked on disk either way, since `--base` only resolves *relative* paths and defaults to the report's own directory. Playwright writes absolute paths, so you usually need it only when the run artifacts were moved.

**Nonzero exit → STOP. Print the refusals verbatim and publish nothing.** Not the passing cases, not a partial update, not a comment saying it failed. A partial publish is worse than none: it puts unevidenced verdicts in the record with the same authority as evidenced ones.

Never edit `report.json` to get past a refusal. Each one names a real defect in the run:

| Refusal | What actually happened | Fix |
|---|---|---|
| missing video/trace | the run did not capture evidence | fix the Playwright config, re-run |
| `sha_source` / `commit_sha` missing | the deploy SHA was never read | fix `sha_source` in the profile, re-run |
| SHA changed mid-run | a deploy landed mid-run | re-run once the deploy settles |
| sandbox `api_mode` | this was a stabilization run | re-run against a deployed environment |
| case not in the case map | the case was never synced to the tracker | run `/qa-pilot:generate-tests` |
| case was not in an approved state | an unapproved case executed | get QA approval first, then re-run |
| RUN HALTED | over 10% blocked; the environment failed | fix the environment, re-run |

## 4. Compute the confidence score

Never do this arithmetic yourself. Fetch each case's current ClickUp status, write them to `statuses.json`, and ask the script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml --statuses <statuses.json> \
  --verdicts report.json --profile <profile-path>
```

Pass `--verdicts`. A case counts toward the numerator only when QA accepted its verdict **and** that verdict was a pass. Without it the score reads `Unknown`, which is the honest answer: approval on its own says a human looked, not that the feature works. This matters because `/qa-pilot:qa-review` correctly tells QA that a confirmed real failure is a bug rather than a broken test, so the right action on a failing P0 is to approve the verdict, and scoring on status alone would then read the feature as Ready precisely when QA had confirmed it was broken.

Use its `confidence` object verbatim. **Any P0 without an accepted verdict reads "Not Ready", whatever the percentage says.** Quarantined and flaky cases stay in the denominator, and that they lower the number is the point.

Read the timing honestly when you report it: this publish is about to move these cases into `under_review`, and only `approved` counts toward the numerator. So the score you post is the state *going into* review, and it is expected to be low, often zero on a feature's first run. It rises as QA works the queue in `/qa-pilot:qa-review`. Say that plainly rather than posting a number that looks like a failing grade with no explanation.

## 5. Work out the status transitions

Ask the script rather than deciding per case:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" --transitions \
  --cases testing/<feature>/cases.yaml --statuses <statuses.json> \
  --verdicts report.json --approved testing/<feature>/approved.json \
  --profile <profile-path>
```

It returns each case's target lifecycle key with a reason, plus the updated approval ledger. Apply the transitions over MCP using this host's status names, and write `approved_ledger` back to `testing/<feature>/approved.json` and commit it.

**A case whose spec has not changed and which passed again keeps its approval.** Only cases that failed, went flaky, or ran from an edited spec go back to `under_review`. Sending the whole feature back on every run means one person re-reviewing several hundred cases weekly, which ends in either abandoned regression runs or rubber-stamping, and both are worse than no review.

`approved.json` is the record of which spec QA accepted, as `{"<CASE-ID>": "<spec_sha>"}`. Commit it: it is what makes "approved" mean approved-for-this-spec rather than approved-once-forever.

## 6. Write to ClickUp

Create the write flag the guard hook checks, and remove it when you are done:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

The flag expires after 30 minutes, so a session that dies mid-publish cannot leave ClickUp writes open. If a long publish starts getting denied part-way through, `touch` the flag again and resume from the case you stopped at. Do not restart the whole publish.

**Per case**: the task ID comes from `clickup-map.json`. Never search by name: a renamed task would create a duplicate and silently split the case's history.

- One `clickup_update_task` call per task, setting every field at once (see `references/clickup-fields.md` for the field-to-report mapping). Coalescing matters: the Business tier allows 100 requests per minute per token, and a 25-case feature plus attachments gets close.
- Status: whatever step 5 returned for that case, resolved to this host's name via the profile's `clickup.statuses`. Never assume the canonical wording, and never decide the target status yourself: a case that passed on an unchanged approved spec stays `approved`, and moving it back to `under_review` is what turns a regression suite into a weekly re-review of everything.
- **Attach the trace, and only the trace**, with `clickup_attach_task_file`: one artifact per case per run. Do not upload the `.webm` or the console log: the trace already contains the video byte-for-byte plus the console output, so uploading them again stores the same bytes twice and splits one investigation across three files. Name the attachment `<CASE-ID>-<run_id>.zip` so a task's attachment list reads as run history.
- If a trace exceeds 1 GB (the API's per-file cap), something is wrong with the run, not with the upload, so report it rather than working around it.

**Once per feature**: a single run-summary comment on the feature task (`clickup_create_task_comment`), not one comment per case. Include: run ID, environment, commit SHA, counts by verdict, blocked percentage, confidence score and readiness, and the executor. Start the comment with the run ID so a re-publish can find its own prior comment. Add the one-line reviewer instruction: traces open at <https://trace.playwright.dev> by drag-and-drop, entirely in the browser.

**Rate discipline**: sequential calls, never parallel. On a 429, wait 60 seconds and resume from where you stopped. Do not restart the whole publish. Note that the 100/min budget is **per token**: if several developers publish on one shared token they will exhaust it together. Per-user OAuth tokens give each executor their own budget and make the `executor` field truthful for free.

## 7. Idempotency

Re-publishing the same run must produce the same state, not a second copy of it. Fields are overwritten with the same values; the run-summary comment is found by its run-ID prefix (`clickup_get_task_comments`) and **updated**, not duplicated. A re-run of the *same cases* with a *new* run ID appends a new comment, and that is run history, which is wanted.

## 8. Report back

Tell the user what landed: case count by verdict, the confidence score and whether the feature reads Ready, anything quarantined, and the ClickUp list link. Then point QA at `/qa-pilot:qa-review <feature>`.

If validation refused, report only that: the refusals, verbatim, and what to fix. Do not soften them, and do not offer to publish "just the passing cases".
