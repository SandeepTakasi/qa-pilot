# `report.json`: uniform run report

Produced by `parse-report.mjs` from a Playwright JSON report plus the run's `meta.json`. Gated by `validate-report.mjs` before anything reaches ClickUp.

Nothing in this file is written by a model. Every field is copied from the Playwright report or the run metadata, or computed from them. That is what makes the record of truth immune to hallucination.

```yaml
run_id: <ISO timestamp>-<feature>-<short sha>
feature: string
app: string                  # which frontend, on multi-app hosts
env_name: string             # must be a registered environment
env_url: string              # must match the registry for this app+env
api_mode: string             # "server" | the host's sandbox value; sandbox runs cannot publish
commit_sha: string           # the deployed build
sha_before: string           # read from the environment before the run
sha_after: string            # and after
sha_source: string           # required; the URL it was read from
sha_mismatch: boolean        # true => every case must be blocked
executor: string             # who ran it
model_version: string        # model that authored/updated the specs
playwright_version: string
browser: string
started_at / finished_at: ISO 8601

cases:
  - id: CHECKOUT-ORDER-001
    verdict: pass | fail | flaky | blocked
    duration_ms: integer     # summed across attempts
    assertions: null         # Playwright's JSON reporter does not expose a count
    trace: <path>            # REQUIRED for pass | fail | flaky: THE evidence artifact
    video: <path>            # optional carry-through; the trace already contains it
    console_log: <path>      # optional carry-through; the trace already contains it
    failure_summary: string  # REQUIRED for fail: the Playwright error, ANSI-stripped,
                             # capped at 500 chars. Never model prose.
    retries: integer

summary: { pass, fail, flaky, blocked }
unmapped_specs: [string]     # spec titles with no case-ID prefix; dropped, never guessed at
```

## Verdict derivation

Derived from the attempt results, **not** from Playwright's own `status` field, so a config change (`retries`, `failOnFlakyTests`) cannot turn a flaky case green:

A spec has one `tests[]` entry per Playwright project (chromium, firefox, a merged shard); that entry's `results[]` are its retry attempts. Verdicts are derived **per entry**, then combined. Flattening the entries would make a genuine cross-browser failure look like a retry.

Per entry, from its attempts:

| Attempts | Verdict |
|---|---|
| any passed **and** any failed/timedOut | `flaky` |
| any failed/timedOut, none passed | `fail` |
| all passed | `pass` |
| all skipped, all interrupted, or none ran | `blocked` |
| **any**, when the SHAs disagree | `blocked` |

Then across entries: any `fail` → `fail`; else any `flaky` → `flaky`; else any `pass` → `pass`; else `blocked`. **Failing in any browser is a failure, never a flake.**

A case that passed only on retry is `flaky`, never `pass`. This is the rule that keeps a suite's green from meaning less than it appears to.

`interrupted` means the attempt never finished (the run was aborted), which is `blocked`, not a failure. `timedOut` is a real failure. `retries` is summed per entry, so running two projects never invents a retry.

## Publish refusals

`validate-report.mjs` exits nonzero (and nothing is written to ClickUp) when:

- a `pass`, `fail`, or `flaky` case is missing its **trace**, or the artifact is absent from disk, or it is zero bytes (a crashed browser writes an empty file). Evidence is always checked on disk; `--base` only resolves relative paths and defaults to the report's own directory
- a `video` or `console_log` path *is* recorded but points at a missing or empty file. They are optional, but a broken path is still a broken path
- `commit_sha` or `sha_source` is absent: a run with no readable build identity has no provenance
- the deployed build changed mid-run and any case still carries a verdict. The mismatch is **recomputed** from `sha_before`/`sha_after`, never taken from the report's own `sha_mismatch` flag, and a flag that disagrees with the SHAs is itself a refusal
- `env_name` is not registered, `env_url` is missing, or `env_url` disagrees with the registry
- `api_mode` matches the host's sandbox mode: sandbox backends are seeded and always succeed
- a verdict is outside the enum, a case ID is not in the approved map, a `fail` has no failure summary, or the summary disagrees with the cases
- more than 10% of cases are `blocked`. **RUN HALTED**: the environment failed, not the feature

## Confidence score

`(approved P0 × 3 + approved P1 × 2 + approved P2 × 1) / (total, same weights)`.

Any P0 not Approved displays **Not Ready** regardless of the score. Quarantined and flaky cases stay in the denominator, since lowering the number is the point.
