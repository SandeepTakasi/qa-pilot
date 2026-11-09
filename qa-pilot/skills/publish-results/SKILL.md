---
name: publish-results
description: Publish a completed test run to ClickUp, or to local files without a tracker, only after the report passes hard-fail validation. Use when the user says "publish results", "push the run to ClickUp", "report the run", or "/publish-results <feature>".
argument-hint: "<feature> [--run <run_id>]"
---

# publish-results: put the run into the record

Run the script, respect its verdict, copy values; do not interpret or improve them. **Everything you send to the tracker comes from `payload.json`.** A field not in it is never written.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit: STOP, print errors, point at `/qa-pilot:qa-init`. Note the profile's `tracker`, and the run environment's `kind` and effective `evidence_upload`. When `tracker` is `clickup`, read `references/clickup-fields.md` now.

## 1. Locate the run

`testing/<feature>/runs/<run_id>/` (`$RUN_DIR`): the newest, or the one named by `--run`. `/qa-pilot:run-tests` left in it `meta.json`, `spec-shas.json`, `results.json`, `statuses.json` and `test-results/`. Never reconstruct a run from memory or an agentic session. A stabilization run (`run_kind: stabilization`) is never published; the gate refuses it too.

Then `git pull`. The approval ledger and the run records are shared through git; publishing on a stale checkout sends cases QA has just approved back to review.

## 2. Read the current statuses

Write each case's status **now** to `$RUN_DIR/current-statuses.json` as `{"<CASE-ID>": "<status>"}`: from ClickUp (see `references/clickup-fields.md`), or a copy of `testing/<feature>/statuses.json` under `tracker: none`. This is not `$RUN_DIR/statuses.json`, which holds the statuses the run started under and proves approval.

## 3. Publish

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/publish.mjs" "$RUN_DIR" \
  --feature-dir testing/<feature> --profile <profile-path> \
  --statuses "$RUN_DIR/current-statuses.json"
```

It runs the whole sequence in the only safe order (build the report, the publish gate, status transitions, the confidence score after them, the payload), stops at the first refusal, and writes nothing further when it does. Never run its steps by hand, edit what it wrote, or decide a status, score or field yourself. On success it has written `$RUN_DIR/payload.json`, the run record `testing/<feature>/verdicts/<run_id>.json`, and the approval ledger `testing/<feature>/approved.json`.

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
| `rule 1:` | the run did not enforce what its cases file declares, or an unrestricted feature ran on production | set `QA_PILOT_MUTATION` from `cases.yaml`; declare a policy |
| `rule 1b:` | the report does not match `results.json` or the write records on disk | re-run the publish; never edit the report |
| `rule 2:` | a spec ran without the write guard, or the guard had no signatures | import `test` from the guard; set `QA_PILOT_MUTATION_CONFIG` |
| `rule 3:` / `rule 4:` | a read-only run wrote, or a scoped-write run tried to write outside its scope | fix the spec, the policy or the profile's `allow_signatures`, and re-run |
| `rule 5:` | fixtures and cases disagree | fix the setup spec or the `fixture:` keys, re-run |
| `rule 6:` | a local trace has no hash, moved outside the run directory, or changed after the run | re-run; never touch traces between run and publish |
| `run_kind:` | a stabilization or CI run, or one that never said what it was | publish a verdict run; set `run_kind` in `meta.json` |
| `run_id:` | the id has characters a directory or file name cannot carry everywhere | re-run with an id like `20261024T101500Z-checkout-a1b2c3d` |
| merge-conflict markers | `approved.json` is mid-merge | resolve it; never replace it with an empty ledger |

**Surface every warning it prints.** In particular: no `spec-shas.json` means no verdict can carry an approval, so every passing case goes back to review; specs with neither a case-ID prefix nor a `FIXTURE` title were dropped from the report and are not published (do not match them to cases yourself).

**What the result means**, so you can say it plainly:

- A case whose spec is unchanged and which passed again keeps its approval; only failed, flaky or edited-spec cases return to `under_review`. Publishing never creates a first approval: `/qa-pilot:qa-review` does that.
- The score in `payload.json` is the state going into review, often zero on a first run, and it rises as QA works `/qa-pilot:qa-review`. Say so rather than posting a number that looks like a failing grade. **Any P0 without an accepted verdict reads "Not Ready", whatever the percentage.**
- `summary.requirement_coverage` is present only when the cases file declares lint-clean requirements; when absent, say so and do not compute it.

Check the ledger is tracked: `git ls-files --error-unmatch testing/<feature>/approved.json`. If untracked, **state the consequence once and carry on**: approval will not carry forward for anyone else, every regression run sends the feature back to review, and CI has nothing to select.

`payload.json`'s `mode` comes from the environment's effective `evidence_upload`, never from you, and decides step 4:

| `mode` | When | What reaches the tracker |
|---|---|---|
| `tracker` | `evidence_upload: tracker` (never production) | the fields in `references/clickup-fields.md`, one trace attachment per case, the full summary |
| `reference` | `evidence_upload: reference`, the default off production | the same fields and summary, no trace file; each case also carries `run_id`, `trace_path` (run-relative) and `trace_sha256` |
| `local` | evidence stays local; **always on production** | per case only ID, verdict, target status, environment, build, run ID, trace path and sha256; summary only counts, blocked percentage, confidence, readiness, `requirement_coverage`. No attachment, failure text, console text, URL or executor |
| `none` | `tracker: none` | nothing; a plan of local file writes |

Post exactly what `payload.json` holds. On `reference` and `local` never attach a trace, and on `local` never add a field from the report: the trace carries the session credential and every request body, and failure text can carry application data. A reviewer finds the evidence on the executor's machine by the path and hash.

## 4. Write it

**`mode: none`**: no tracker call, no write flag. Merge `status_writes` into `statuses_file` (`testing/<feature>/statuses.json`), keeping every case it does not name; write `summary` as JSON to `summary_file`. That is the publish; re-publishing rewrites the same values.

**Otherwise** create the write flag the guard hook checks, at the repo root next to the profile, and remove it when done:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

It expires after 30 minutes. If a long publish starts getting denied, `touch` it again and resume from the case you stopped at; do not restart.

Then follow `references/clickup-fields.md`, "Writing the tasks": per-case updates and attachments, the run-summary comment, rate discipline, idempotency.

## 5. Report back

Commit and push `testing/<feature>/approved.json` and `testing/<feature>/verdicts/<run_id>.json` (and `statuses.json` under `tracker: none`) now, so QA works from them and a teammate's next publish does not start from an old ledger.

Tell the user what landed: case count by verdict, the confidence score and whether the feature reads Ready, anything quarantined, and the ClickUp list link (or the statuses file under `tracker: none`). For a `reference` or `local` run, say the traces are on this machine under `$RUN_DIR` and QA reviews them here. Then point QA at `/qa-pilot:qa-review <feature>`.

If the publish refused, report only that: the refusals, verbatim, and what to fix. Do not offer to publish "just the passing cases".
