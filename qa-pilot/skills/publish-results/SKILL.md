---
name: publish-results
description: Publish a completed test run to ClickUp — deterministically transform the Playwright JSON report into report.json, hard-fail validation on missing evidence or provenance, then update each case task's custom fields and status and post one feature-level run summary. A report that fails validation is never published, so QA never has to police formatting. Use when the user says "publish results", "push the run to ClickUp", "report the run", or "/publish-results <feature>".
argument-hint: "<feature> [--run <run_id>]"
---

# publish-results — put the run into the record

Everything here except the ClickUp calls themselves is deterministic. Your job is to run the scripts, respect their verdict, and copy values — not to interpret, summarize, or improve them. **Every value you write to ClickUp comes from the validated `report.json`.** If a field is not in the report, it does not get written.

Recommended model: any current model. This step is mechanical by design.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP, print errors, point at `/qa-pilot:qa-init`.

## 1. Locate the run

`testing/<feature>/runs/<run_id>/` — the newest, or the one named by `--run`. It holds `meta.json` and the Playwright JSON report from `/qa-pilot:run-tests`. If neither exists, stop: there is nothing to publish, and you must not reconstruct a run from memory or from an agentic session.

## 2. Build the report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-report.mjs" <playwright-report.json> <meta.json> -o report.json
```

If it warns about specs with no case-ID prefix, surface that: those results are absent from the report and will not be published. Do not try to match them to cases yourself.

## 3. Validate — and obey the answer

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-report.mjs" report.json \
  --profile <profile-path> \
  --map testing/<feature>/clickup-map.json \
  --base <dir relative artifact paths resolve against>
```

Evidence is checked on disk either way — `--base` only resolves *relative* paths and defaults to the report's own directory. Playwright writes absolute paths, so you usually need it only when the run artifacts were moved.

**Nonzero exit → STOP. Print the refusals verbatim and publish nothing.** Not the passing cases, not a partial update, not a comment saying it failed. A partial publish is worse than none: it puts unevidenced verdicts in the record with the same authority as evidenced ones.

Never edit `report.json` to get past a refusal. Each one names a real defect in the run:

| Refusal | What actually happened | Fix |
|---|---|---|
| missing video/trace | the run did not capture evidence | fix the Playwright config, re-run |
| `sha_source` / `commit_sha` missing | the deploy SHA was never read | fix `sha_source` in the profile, re-run |
| SHA changed mid-run | a deploy landed mid-run | re-run once the deploy settles |
| sandbox `api_mode` | this was a stabilization run | re-run against a deployed environment |
| case not in the approved map | an unapproved case executed | get QA approval first |
| RUN HALTED | over 10% blocked; the environment failed | fix the environment, re-run |

## 4. Compute the confidence score

Never do this arithmetic yourself. Fetch each case's current ClickUp status, write them to `statuses.json`, and ask the script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml --statuses <statuses.json>
```

Use its `confidence` object verbatim. **Any P0 without an accepted verdict reads "Not Ready", whatever the percentage says.** Quarantined and flaky cases stay in the denominator — that they lower the number is the point.

Read the timing honestly when you report it: this publish is about to move these cases to `Under Review`, and only `Approved` counts toward the numerator. So the score you post is the state *going into* review, and it is expected to be low — often zero on a feature's first run. It rises as QA works the queue in `/qa-pilot:qa-review`. Say that plainly rather than posting a number that looks like a failing grade with no explanation.

## 5. Write to ClickUp

Create the write flag the guard hook checks, and remove it when you are done:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

The flag expires after 30 minutes, so a session that dies mid-publish cannot leave ClickUp writes open. If a long publish starts getting denied part-way through, `touch` the flag again and resume from the case you stopped at — do not restart the whole publish.

**Per case** — task ID comes from `clickup-map.json`. Never search by name: a renamed task would create a duplicate and silently split the case's history.

- One `clickup_update_task` call per task, setting every field at once (see `references/clickup-fields.md` for the field-to-report mapping). Coalescing matters: the Business tier allows 100 requests per minute per token, and a 25-case feature plus attachments gets close.
- Status: `Under Review`, except `flaky` → `Quarantined`.
- Video: if the file is under 50 MB, attach it with `clickup_attach_task_file`; otherwise put its URL in the Video field. The API accepts up to 1 GB per file, but large attachments make tasks unusable — 50 MB is the practical line.

**Once per feature** — a single run-summary comment on the feature task (`clickup_create_task_comment`), not one comment per case. Include: run ID, environment, commit SHA, counts by verdict, blocked percentage, confidence score and readiness, and the executor. Start the comment with the run ID so a re-publish can find its own prior comment.

**Rate discipline**: sequential calls, never parallel. On a 429, wait 60 seconds and resume from where you stopped — do not restart the whole publish.

## 6. Idempotency

Re-publishing the same run must produce the same state, not a second copy of it. Fields are overwritten with the same values; the run-summary comment is found by its run-ID prefix (`clickup_get_task_comments`) and **updated**, not duplicated. A re-run of the *same cases* with a *new* run ID appends a new comment — that is run history, which is wanted.

## 7. Report back

Tell the user what landed: case count by verdict, the confidence score and whether the feature reads Ready, anything quarantined, and the ClickUp list link. Then point QA at `/qa-pilot:qa-review <feature>`.

If validation refused, report only that — the refusals, verbatim, and what to fix. Do not soften them, and do not offer to publish "just the passing cases".
