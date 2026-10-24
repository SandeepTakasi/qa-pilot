---
name: publish-results
description: Publish a completed test run to ClickUp, or to local files without a tracker, only after the report passes hard-fail validation. Use when the user says "publish results", "push the run to ClickUp", "report the run", or "/publish-results <feature>".
argument-hint: "<feature> [--run <run_id>]"
---

# publish-results: put the run into the record

Run the scripts, respect their verdict, copy values; do not interpret or improve them. **Everything you send to the tracker comes from `publish-payload.mjs`.** A field not in its output is never written.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit: STOP, print errors, point at `/qa-pilot:qa-init`. Note the profile's `tracker`, and the run environment's `kind` and effective `evidence_upload`. When `tracker` is `clickup`, read `references/clickup-fields.md` now.

## 1. Locate the run

`testing/<feature>/runs/<run_id>/` (`$RUN_DIR`): the newest, or the one named by `--run`. `/qa-pilot:run-tests` left in it `meta.json`, `spec-shas.json`, `results.json` (the Playwright JSON report), `statuses.json` and `test-results/` (each attempt's trace and `writes.json`). If the directory or any of `meta.json`, `results.json` and `statuses.json` is missing, stop. Never reconstruct a run from memory or an agentic session.

A stabilization run (`run_kind: stabilization` in `meta.json`) is never published; the gate refuses it too.

Then `git pull`. The approval ledger and the run records are shared through git; publishing on a stale checkout sends cases QA has just approved back to review.

## 2. Build the report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-report.mjs" "$RUN_DIR/results.json" "$RUN_DIR/meta.json"
```

It writes `$RUN_DIR/report.json`, with every path relative to that directory. Never pass `-o`: the gate re-reads the run's files relative to the report.

Each verdict's `spec_sha` comes from `$RUN_DIR/spec-shas.json`, taken when the run started. If it warns that the file is missing, say so: no verdict can carry an approval, and every passing case goes back for review.

If it warns about specs with neither a case-ID prefix nor a `FIXTURE` title, surface that: those results are absent from the report and will not be published. Do not match them to cases yourself.

## 3. Validate, and obey the answer

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-report.mjs" "$RUN_DIR/report.json" \
  --profile <profile-path> \
  --cases testing/<feature>/cases.yaml \
  --statuses "$RUN_DIR/statuses.json" \
  --map testing/<feature>/clickup-map.json
```

Leave out `--map` under `tracker: none`; always pass the other three. `--statuses` (recorded at the start of the run) is what proves each case was approved; `--cases` is the only source of the mutation policy and fixtures. Do not pass `--base` unless the run directory was moved, and then expect the write-record checks to refuse.

**Nonzero exit: STOP. Print the refusals verbatim and publish nothing**: not the passing cases, not a partial update, not a comment saying it failed. Never edit `report.json` to get past one. Each names a real defect in the run:

| Refusal | What actually happened | Fix |
|---|---|---|
| missing trace | the run did not capture evidence | fix the Playwright config, re-run |
| `sha_source` / `commit_sha` missing | the deploy SHA was never read | fix `sha_source` in the profile, re-run |
| SHA changed mid-run | a deploy landed mid-run | re-run once the deploy settles |
| sandbox `api_mode` | this was a stabilization run | re-run against a deployed environment |
| case not in the case map | the case was never synced to the tracker | run `/qa-pilot:generate-tests` |
| case was not in an approved state | an unapproved case executed | get QA approval first, then re-run |
| RUN HALTED | over 10% blocked; the environment failed | fix the environment, re-run |
| `rule 1:` | the cases file is missing, the run did not enforce what it declares, or an unrestricted feature ran on production | pass `--cases`; set `QA_PILOT_MUTATION` from `cases.yaml`; declare a policy |
| `rule 1b:` | the report does not match `results.json` or the write records on disk | rebuild the report with step 2; never edit it |
| `rule 2:` | a spec ran without the write guard, or the guard had no signatures | import `test` from the guard; set `QA_PILOT_MUTATION_CONFIG` |
| `rule 3:` / `rule 4:` | a read-only run wrote, or a scoped-write run tried to write outside its scope | fix the spec, or the policy, and re-run |
| `rule 5:` | fixtures and cases disagree | fix the setup spec or the `fixture:` keys, re-run |
| `rule 6:` | a local trace has no hash, moved outside the run directory, or changed after the run | re-run; never touch traces between run and publish |
| `run_kind:` | a stabilization or CI run, or one that never said what it was | publish a verdict run; set `run_kind` in `meta.json` |
| `run_id:` | the id has characters a directory or file name cannot carry everywhere | re-run with an id like `20261024T101500Z-checkout-a1b2c3d` |

## 4. Work out the status transitions

Write each case's current status to a file (from ClickUp, or copy `testing/<feature>/statuses.json` under `tracker: none`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" --transitions \
  --cases testing/<feature>/cases.yaml --statuses <current statuses.json> \
  --verdicts "$RUN_DIR/report.json" --approved testing/<feature>/approved.json \
  --profile <profile-path> > "$RUN_DIR/transitions.json"
```

It returns each case's target lifecycle key with a reason, plus the updated ledger. Write `approved_ledger` back to `testing/<feature>/approved.json` and commit it. Never decide a target status yourself. A nonzero exit naming merge-conflict markers means `approved.json` is mid-merge: STOP and resolve it; never replace it with an empty ledger.

This step keeps and clears ledger entries; it never creates a first one. `/qa-pilot:qa-review` does that with `--record-approvals` when QA approves, so a case approved without it goes back to review on its next pass.

**A case whose spec is unchanged and which passed again keeps its approval.** Only failed, flaky or edited-spec cases return to `under_review`; sending everything back means weekly re-review of the whole feature. `approved.json` is `{"<CASE-ID>": "<spec_sha>"}`, approved-for-this-spec, and the only thing CI reads to decide what to run.

```bash
git ls-files --error-unmatch testing/<feature>/approved.json
```

If untracked, **state the consequence once and carry on**: approval will not carry forward for anyone else, every regression run sends the feature back to review, and CI has nothing to select. That is the expected shape of local-only mode.

## 5. Compute the confidence score

Never do this arithmetic yourself. Score the statuses as they will be once this publish lands, not as they are now, and keep the output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml --statuses <current statuses.json> \
  --verdicts "$RUN_DIR/report.json" --apply-transitions "$RUN_DIR/transitions.json" \
  --profile <profile-path> > "$RUN_DIR/confidence.json"
```

Without `--apply-transitions` a case this publish sends back to review still counts as an approved pass.

Always pass `--verdicts`: a case counts only when QA accepted its verdict **and** it passed; without it the score reads `Unknown`. The script exits 1 when no case is currently executable; the file is still complete. Keep the whole file: its `confidence` goes into the payload, and its `requirements` (when the cases file declares lint-clean requirements) feeds `requirement_coverage` in step 6. **Any P0 without an accepted verdict reads "Not Ready", whatever the percentage.** Quarantined and flaky cases stay in the denominator.

Report the timing honestly: this publish moves cases to `under_review`, and only `approved` counts, so the posted score is the state going into review, often zero on a first run. It rises as QA works `/qa-pilot:qa-review`. Say so rather than posting a number that looks like a failing grade.

## 6. Compute what the tracker may receive

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-payload.mjs" "$RUN_DIR/report.json" \
  --profile <profile-path> \
  --transitions "$RUN_DIR/transitions.json" \
  --confidence "$RUN_DIR/confidence.json" \
  --record-dir testing/<feature>/verdicts > "$RUN_DIR/payload.json"
```

It also writes the run's record, `testing/<feature>/verdicts/<run_id>.json`: each verdict, the spec hash it ran under, and failure text only where the tracker receives it. QA records approvals and files bugs from it on their own machine, so **commit and push it with `approved.json`** once step 7 is done.

Pass `--confidence` the **whole** step 5 file, not `.confidence`: a trimmed file silently drops requirement coverage. When it carries `requirements`, the summary gains `requirement_coverage` (`criteria_total`, `proved`, `failing`, `unproved`, `uncovered`, `not_proved` as requirement ids), ids and counts only, sent in every mode. When absent (none declared, or lint errors a step 5 warning names), report that; do not compute it.

`mode` is set from the environment's effective `evidence_upload`, never by you, and decides step 7:

| `mode` | When | What reaches the tracker |
|---|---|---|
| `tracker` | `evidence_upload: tracker` (never production) | the fields in `references/clickup-fields.md`, one trace attachment per case, the full summary |
| `reference` | `evidence_upload: reference`, the default off production | the same fields and summary, no trace file; each case also carries `run_id`, `trace_path` (run-relative) and `trace_sha256` |
| `local` | evidence stays local; **always on production** | per case only ID, verdict, target status, environment, build, run ID, trace path and sha256; summary only counts, blocked percentage, confidence, readiness, `requirement_coverage`. No attachment, failure text, console text, URL or executor |
| `none` | `tracker: none` | nothing; a plan of local file writes |

Post exactly what `payload.json` holds. On `reference` and `local` never attach a trace, and on `local` never add a field from the report: the trace carries the session credential and every request body, and failure text can carry application data. A reviewer finds the evidence on the executor's machine by the path and hash.

## 7. Write it

**`mode: none`**: no tracker call, no write flag. Merge `status_writes` into `statuses_file` (`testing/<feature>/statuses.json`), keeping every case it does not name; write `summary` as JSON to `summary_file`. That is the publish; re-publishing rewrites the same values.

**Otherwise** create the write flag the guard hook checks, at the repo root next to the profile, and remove it when done:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

It expires after 30 minutes. If a long publish starts getting denied, `touch` it again and resume from the case you stopped at; do not restart.

Then follow `references/clickup-fields.md`, "Writing the tasks": per-case updates and attachments, the run-summary comment, rate discipline, idempotency.

## 8. Report back

Commit and push `testing/<feature>/approved.json` and `testing/<feature>/verdicts/<run_id>.json` (and `statuses.json` under `tracker: none`) now, so QA works from them and a teammate's next publish does not start from an old ledger.

Tell the user what landed: case count by verdict, the confidence score and whether the feature reads Ready, anything quarantined, and the ClickUp list link (or the statuses file under `tracker: none`). For a `reference` or `local` run, say the traces are on this machine under `$RUN_DIR` and QA reviews them here. Then point QA at `/qa-pilot:qa-review <feature>`.

If validation refused, report only that: the refusals, verbatim, and what to fix. Do not offer to publish "just the passing cases".
