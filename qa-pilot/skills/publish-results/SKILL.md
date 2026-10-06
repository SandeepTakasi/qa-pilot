---
name: publish-results
description: Publish a completed test run to ClickUp, or to local files without a tracker. Deterministically transform the Playwright JSON report into report.json, hard-fail validation on missing evidence, provenance or a broken write policy, compute exactly what the tracker may receive (no application data at all when evidence stays local, as it always does on production), then update each case task's custom fields and status and post one feature-level run summary. A report that fails validation is never published, so QA never has to police formatting. Use when the user says "publish results", "push the run to ClickUp", "report the run", or "/publish-results <feature>".
argument-hint: "<feature> [--run <run_id>]"
---

# publish-results: put the run into the record

Everything here except the tracker calls themselves is deterministic. Your job is to run the scripts, respect their verdict, and copy values, not to interpret, summarize, or improve them. **Everything you send to the tracker comes from `publish-payload.mjs`.** If a field is not in its output, it does not get written, and you never add one.

Recommended model: any current model. This step is mechanical by design.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP, print errors, point at `/qa-pilot:qa-init`. Note the profile's `tracker`, and the run environment's `kind` and effective `evidence_upload`, from the normalized output.

## 1. Locate the run

`testing/<feature>/runs/<run_id>/`, called `$RUN_DIR` below: either the newest or the one named by `--run`. `/qa-pilot:run-tests` left in it `meta.json`, the Playwright JSON report `results.json`, `statuses.json`, and `test-results/` with each attempt's trace and `writes.json`. If the directory or any of those three files is missing, stop: there is nothing to publish, and you must not reconstruct a run from memory or from an agentic session.

A stabilization run (on the sandbox, or on the profile's `stabilization.env`) is never published. If the user points you at one, say so and stop.

## 2. Build the report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-report.mjs" "$RUN_DIR/results.json" "$RUN_DIR/meta.json" \
  --specs testing/<feature>/specs.json
```

It writes `$RUN_DIR/report.json`, beside the files it was built from; every trace and write-record path in it is relative to that directory. Do not pass `-o` to put it anywhere else: the gate re-reads the run's files relative to the report's own directory.

`specs.json` is the `{"<CASE-ID>": "<path to its spec file>"}` map `/qa-pilot:run-tests` wrote. It makes each verdict record `spec_sha`, the hash of the spec that produced it. Without it approval cannot carry forward, because there is no way to tell an unchanged spec from a rewritten one, and every passing case goes back for review.

If it warns about specs with neither a case-ID prefix nor a `FIXTURE` title, surface that: those results are absent from the report and will not be published. Do not try to match them to cases yourself.

## 3. Validate, and obey the answer

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-report.mjs" "$RUN_DIR/report.json" \
  --profile <profile-path> \
  --cases testing/<feature>/cases.yaml \
  --statuses "$RUN_DIR/statuses.json" \
  --map testing/<feature>/clickup-map.json
```

Leave out `--map` under `tracker: none`, where there is no case map. Always pass the other three:

- `--statuses` is the statuses file recorded at the start of the run, and it is what proves each published case was approved. The map only proves a task exists, which every generated case does from the moment it is created.
- `--cases` is the feature's `cases.yaml`, the only source of its mutation policy and fixtures. The gate refuses without it on every environment.

Evidence is checked on disk, relative to `$RUN_DIR`. Do not pass `--base` unless the run directory was moved, and then expect the write-record checks to refuse: they compare the report against `results.json` and the files exactly where the run left them.

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
| `env_kind: missing` | the run predates 0.3.0 | re-run with this version |
| `rule 1:` | the cases file is missing, or the run did not enforce what it declares, or an unrestricted feature ran on production | pass `--cases`; set `QA_PILOT_MUTATION` from `cases.yaml`; declare a policy |
| `rule 1b:` | the report does not match `results.json` or the write records on disk | rebuild the report with step 2; never edit it |
| `rule 2:` | a spec ran without the write guard, or the guard had no signatures | import `test` from the guard; set `QA_PILOT_MUTATION_CONFIG` |
| `rule 3:` / `rule 4:` | a read-only run wrote, or a scoped-write run tried to write outside its scope | fix the spec, or the policy, and re-run |
| `rule 5:` | fixtures and cases disagree | fix the setup spec or the `fixture:` keys, re-run |
| `rule 6:` | a local trace has no hash, moved outside the run directory, or changed after the run | re-run; never touch traces between run and publish |

## 4. Compute the confidence score

Never do this arithmetic yourself. Write each case's current status to a file (fetched from ClickUp, or copied from `testing/<feature>/statuses.json` under `tracker: none`), and ask the script, keeping its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml --statuses <current statuses.json> \
  --verdicts "$RUN_DIR/report.json" --profile <profile-path> > "$RUN_DIR/confidence.json"
```

Pass `--verdicts`. A case counts toward the numerator only when QA accepted its verdict **and** that verdict was a pass. Without it the score reads `Unknown`, which is the honest answer: approval on its own says a human looked, not that the feature works. This matters because `/qa-pilot:qa-review` correctly tells QA that a confirmed real failure is a bug rather than a broken test, so the right action on a failing P0 is to approve the verdict, and scoring on status alone would then read the feature as Ready precisely when QA had confirmed it was broken.

It exits 1 when no case is currently executable, which says nothing about this step: the file is still complete. Its `confidence` object goes into the payload verbatim, and when the cases file declares requirements and they are lint-clean, its `requirements` object feeds the summary's `requirement_coverage` (step 6). Keep the whole file: step 6 passes it, not just `.confidence`. **Any P0 without an accepted verdict reads "Not Ready", whatever the percentage says.** Quarantined and flaky cases stay in the denominator, and that they lower the number is the point.

Read the timing honestly when you report it: this publish is about to move these cases into `under_review`, and only `approved` counts toward the numerator. So the score you post is the state *going into* review, and it is expected to be low, often zero on a feature's first run. It rises as QA works the queue in `/qa-pilot:qa-review`. Say that plainly rather than posting a number that looks like a failing grade with no explanation.

## 5. Work out the status transitions

Ask the script rather than deciding per case:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" --transitions \
  --cases testing/<feature>/cases.yaml --statuses <current statuses.json> \
  --verdicts "$RUN_DIR/report.json" --approved testing/<feature>/approved.json \
  --profile <profile-path> > "$RUN_DIR/transitions.json"
```

It returns each case's target lifecycle key with a reason, plus the updated approval ledger. Write `approved_ledger` back to `testing/<feature>/approved.json` and commit it.

**A case whose spec has not changed and which passed again keeps its approval.** Only cases that failed, went flaky, or ran from an edited spec go back to `under_review`. Sending the whole feature back on every run means one person re-reviewing several hundred cases weekly, which ends in either abandoned regression runs or rubber-stamping, and both are worse than no review.

`approved.json` is the record of which spec QA accepted, as `{"<CASE-ID>": "<spec_sha>"}`. Committing it is what makes "approved" mean approved-for-this-spec rather than approved-once-forever across the team, and it is the only thing CI reads to decide what it may run.

Check whether it is tracked:

```bash
git ls-files --error-unmatch testing/<feature>/approved.json
```

If it is not, **state the consequence once and carry on**: approval will not carry forward for anyone else, every regression run will send the feature back to review, and CI will have nothing to select. That is the expected shape of local-only mode rather than an error, so say it and move on.

## 6. Compute what the tracker may receive

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-payload.mjs" "$RUN_DIR/report.json" \
  --profile <profile-path> \
  --transitions "$RUN_DIR/transitions.json" \
  --confidence "$RUN_DIR/confidence.json" > "$RUN_DIR/payload.json"
```

`--confidence` takes the **whole** step 4 output (`confidence.json` as written), not `.confidence` extracted from it: the requirement coverage lives beside the score, and a trimmed file silently drops it. When that output carries `requirements`, the summary gains `requirement_coverage`: `criteria_total`, `proved`, `failing`, `unproved`, `uncovered` and `not_proved` (the requirement ids with a criterion not `proved`). It is ids and counts only, never a title or criterion text, so it is sent in every mode. When the output has no `requirements` (none declared, or the block has lint errors, which a step 4 warning names), the key is absent: report that, do not compute it yourself.

Its `mode` decides step 7, and it is set from the environment's effective `evidence_upload`, never by you:

| `mode` | When | What reaches the tracker |
|---|---|---|
| `tracker` | evidence may upload | the field set in `references/clickup-fields.md`, one trace attachment per case, the full run summary |
| `local` | evidence stays local; **always on production** | per case only the case ID, verdict, target status, environment, build, run ID, and the trace's run-relative path and sha256; the summary only counts, blocked percentage, confidence, readiness and, when present, `requirement_coverage` (ids and counts). No attachment, no failure text, no console text, no URL, no executor |
| `none` | `tracker: none` | nothing; a plan of local file writes instead |

Post exactly what `payload.json` holds. On `local`, **never attach a trace and never add a field from the report**, however useful it looks: the trace carries the session credential and every request body it touched, and the failure text can carry the application's data. A reviewer finds the evidence on the executor's machine, by the path and hash the payload gives.

## 7. Write it

**`mode: none`**: no tracker call, no write flag. Merge `status_writes` into `statuses_file` (`testing/<feature>/statuses.json`), keeping every case it does not name; write `summary` as JSON to `summary_file` in the run directory. That is the publish.

**`mode: tracker` or `local`**: create the write flag the guard hook checks, at the repo root next to the profile, and remove it when you are done:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

The flag expires after 30 minutes, so a session that dies mid-publish cannot leave ClickUp writes open. If a long publish starts getting denied part-way through, `touch` the flag again and resume from the case you stopped at. Do not restart the whole publish.

**Per case** (`payload.cases[]`): the task ID comes from `clickup-map.json`. Never search by name: a renamed task would create a duplicate and silently split the case's history.

- One `clickup_update_task` call per task, setting every field the payload gives for it at once (the mapping to ClickUp field names is in `references/clickup-fields.md`). Coalescing matters: the Business tier allows 100 requests per minute per token, and a 25-case feature plus attachments gets close.
- Status: `target_status`, already resolved to this host's name. `null` means leave the status alone. Never decide the target status yourself: a case that passed on an unchanged approved spec stays `approved`, and moving it back to `under_review` is what turns a regression suite into a weekly re-review of everything.
- **On `tracker`, attach the trace named in `attach`, and only that**, with `clickup_attach_task_file`, under `attach.name`, resolving `attach.path` against `$RUN_DIR`. Do not upload the `.webm` or the console log: the trace already contains the video byte-for-byte plus the console output. **On `local` there is no `attach` and nothing is uploaded.**
- If a trace exceeds 1 GB (the API's per-file cap), something is wrong with the run, not with the upload, so report it rather than working around it.

**Once per feature** (`payload.summary`): a single run-summary comment on the feature task (`clickup_create_task_comment`), not one comment per case, holding exactly the summary's fields (`requirement_coverage` included when the payload has it, and only then) and starting with the run ID so a re-publish can find its own prior comment. On `tracker` it includes the executor and the reviewer line (traces open at <https://trace.playwright.dev> by drag-and-drop, entirely in the browser); on `local` it does not, because neither is in the payload.

**Rate discipline**: sequential calls, never parallel. On a 429, wait 60 seconds and resume from where you stopped. Do not restart the whole publish. Note that the 100/min budget is **per token**: if several developers publish on one shared token they will exhaust it together. Per-user OAuth tokens give each executor their own budget and make the `executor` field truthful for free.

## 8. Idempotency

Re-publishing the same run must produce the same state, not a second copy of it. Fields are overwritten with the same values; the run-summary comment is found by its run-ID prefix (`clickup_get_task_comments`) and **updated**, not duplicated. A re-run of the *same cases* with a *new* run ID appends a new comment, and that is run history, which is wanted. Under `tracker: none` the same holds for the files: rewriting `summary_file` and re-merging `status_writes` changes nothing.

## 9. Report back

Tell the user what landed: case count by verdict, the confidence score and whether the feature reads Ready, anything quarantined, and the ClickUp list link (or the statuses file under `tracker: none`). For a `local` run, say that the traces are on this machine under `$RUN_DIR` and that QA reviews them here. Then point QA at `/qa-pilot:qa-review <feature>`.

If validation refused, report only that: the refusals, verbatim, and what to fix. Do not soften them, and do not offer to publish "just the passing cases".
