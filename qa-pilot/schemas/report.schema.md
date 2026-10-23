# `report.json`: uniform run report

Produced by `parse-report.mjs` from a Playwright JSON report plus the run's `meta.json`, and gated by `validate-report.mjs` before anything reaches the tracker. No field is written by a model: each is copied from the Playwright report or run metadata, or computed from them.

```yaml
run_id: <ISO timestamp>-<feature>-<short sha>
feature: string
app: string                  # which frontend, on multi-app hosts
env_name: string             # must be a registered environment
env_kind: qa | staging | production | null  # from meta.json; the gate recomputes it from the profile
env_url: string              # must match the registry for this app+env
mutation_policy: read-only | scoped-write | unrestricted | null  # from meta.json
mutation_prefix: string | null  # from meta.json; non-null only under scoped-write
api_mode: string             # "server" | the host's sandbox value; sandbox runs cannot publish
commit_sha: string           # the deployed build
sha_before: string           # read from the environment before the run
sha_after: string            # and after
sha_source: string           # required; the URL it was read from
sha_format: commit | build-id  # what commit_sha actually is
evidence_capture: always | on-failure | off
sha_mismatch: boolean        # true => every case must be blocked
executor: string
model_version: string        # model that authored/updated the specs
playwright_version: string
browser: string
started_at / finished_at: ISO 8601

cases:
  - id: CHECKOUT-ORDER-001
    verdict: pass | fail | flaky | blocked
    duration_ms: integer     # summed across attempts
    assertions: null         # Playwright's JSON reporter exposes no count
    trace: <path>            # REQUIRED for pass | fail | flaky: the evidence artifact,
                             # relative to the run dir
    trace_sha256: string | null  # 64 hex chars, computed by the parse-report CLI from the
                             # file's bytes; null (with a warning) when there is no readable trace
    writes: <writes> | null  # the write guard's record; null when no attempt attached a writes.json
    video: <path>            # optional carry-through
    console_log: <path>      # optional carry-through
    failure_summary: string  # REQUIRED for fail: the Playwright error, ANSI-stripped, max 500 chars
    retries: integer
    spec_sha: string | null  # hash of the spec file, from parse-report's --specs map. null means
                             # "changed": a passing case with no hash goes back for review

fixtures:                    # one entry per fixture spec that ran; [] when none did
  - name: string             # from the title, which must match ^FIXTURE ([a-z0-9-]+)( teardown)?$;
                             # any other title starting with FIXTURE goes to unmapped_specs
    phase: setup | teardown  # teardown iff the title ends in " teardown"
    verdict: pass | fail | flaky | blocked   # derived as for cases
    trace: <path> | null
    trace_sha256: string | null
    writes: <writes> | null

summary: { pass, fail, flaky, blocked }   # cases only; fixtures are not counted
unmapped_specs: [string]     # titles with neither a case-ID prefix nor a FIXTURE title; dropped
```

`<writes>` aggregates every `writes.json` the case's or fixture's attempts attached, across all retries and projects (a write on a failed first attempt is still a write):

```yaml
attempts: integer            # non-skipped attempt results across all projects
paths: [<path>]              # each attempt's writes.json attachment path as Playwright recorded it
                             # (it may be a copy), run-dir relative, in attempt order. A record
                             # from a runtime-skipped attempt stays in paths and is counted
installed: boolean           # true iff every non-skipped attempt attached a writes.json with
                             # installed: true
policy: string | null        # the policy every file recorded; null when they disagree
prefix: string | null        # likewise
write_signatures: integer    # the smallest count any file recorded
routed_requests: integer     # summed
blocked: integer             # summed
observed: integer            # summed
```

Events stay in the `writes.json` files inside the run directory and are never sent to the tracker.

## Run metadata

`/qa-pilot:run-tests` writes `testing/<feature>/runs/<run_id>/meta.json`, including:

| Field | Value |
|---|---|
| `env_kind` | the environment's `kind` from the host profile |
| `mutation_policy` | `cases.yaml` `mutation.policy`, or `unrestricted` when the file has no `mutation` |
| `mutation_prefix` | `cases.yaml` `mutation.prefix` under `scoped-write`, else `null` |

`parse-report.mjs` copies all three into the report (`null` when meta lacks them). The gate refuses a `null` `env_kind`.

## Where the report lives

The run directory is `dirname(meta.json)`, `testing/<feature>/runs/<run_id>/`. `parse-report.mjs` writes `report.json` there; every `trace` and `writes.paths` entry is relative to it with `/` separators, and `validate-report.mjs` resolves them against `--base` (default: the report's own directory).

## Environment the write guard reads

`/qa-pilot:run-tests` (and the CI template) set these for the Playwright process:

| Variable | Value | If unset |
|---|---|---|
| `QA_PILOT_MUTATION` | JSON `{"policy": "<policy>", "prefix": "<prefix>"}` from `cases.yaml`; `prefix` only under `scoped-write` | the guard runs `read-only`, never `unrestricted` |
| `QA_PILOT_MUTATION_CONFIG` | the profile's `mutation` block as JSON, uncompiled | generic control defaults, no write signatures (recorded as `write_signatures: 0`) |
| `QA_PILOT_FIXTURE_DIR` | absolute path of `testing/<feature>/runs/<run_id>/fixtures/` | a fixture setup or dependent throws |

The guard throws before the test starts (every test fails) when `QA_PILOT_MUTATION` is invalid JSON, names an unknown policy, lacks a `prefix` under `scoped-write`, or carries a `prefix` under another policy; and when `QA_PILOT_MUTATION_CONFIG` is invalid JSON or holds a regex that does not compile.

## The write guard's record: `writes.json`

The guard fixture writes one `writes.json` per test attempt to `testInfo.outputPath('writes.json')`, once at the end of the attempt and never modified afterwards, and attaches it **by path** (name `writes.json`, type `application/json`). It stays in the run directory.

```yaml
installed: boolean           # true once the page-side guard has reported in; false or absent means it never ran
policy: read-only | scoped-write | unrestricted   # what the guard enforced
prefix: string | null
scope_urls: [string]         # every scope URL regex the spec set with setScope, in order
write_signatures: integer    # how many write signatures the guard compiled
routed_requests: integer     # requests the network route saw
blocked: integer             # controls and requests the guard stopped
observed: integer            # write requests it let through and recorded (scoped-write)
events:
  - kind: control | request
    action: block | observe
    reason: string           # the deny rule, signature or scope check that decided it
    label: string            # control only: innerText, aria-label or title
    method: string           # request only
    url: string              # request only
    at: ISO 8601
```

`blocked` and `observed` must equal the number of `events` with that `action` (rule 1b). A worker that dies before teardown writes no `writes.json`; the gate reads that attempt as not installed.

## Verdict derivation

Verdicts come from the attempt results, **not** Playwright's `status`, so `retries` or `failOnFlakyTests` cannot turn a flaky case green. A spec has one `tests[]` entry per Playwright project; its `results[]` are the retry attempts. Derive **per entry**, then combine.

Per entry:

| Attempts | Verdict |
|---|---|
| any passed **and** any failed/timedOut | `flaky` |
| any failed/timedOut, none passed | `fail` |
| all passed | `pass` |
| all skipped, all interrupted, or none ran | `blocked` |
| **any**, when the SHAs disagree | `blocked` |

Then across entries: any `fail` gives `fail`; else any `flaky` gives `flaky`; else any `pass` gives `pass`; else `blocked`. Failing in any browser is a failure, never a flake. A case that passed only on retry is `flaky`, never `pass`. `interrupted` (run aborted) is `blocked`; `timedOut` is a real failure. `retries` is summed per entry, so two projects never invent a retry.

## Publish refusals

`validate-report.mjs` exits nonzero, and nothing is written to the tracker, when:

- a `pass`, `fail` or `flaky` case has no trace, or the file is absent or zero bytes. Evidence is always checked on disk
- a recorded `video` or `console_log` path points at a missing or empty file
- `commit_sha` or `sha_source` is absent
- the deployed build changed mid-run and any case still carries a verdict. The mismatch is recomputed from `sha_before`/`sha_after`; a `sha_mismatch` flag that disagrees is itself a refusal
- `env_name` is unregistered, `env_url` is missing, or `env_url` disagrees with the registry
- `api_mode` matches the host's sandbox mode
- `--statuses` is not passed (the statuses recorded at run start, the only proof each case was approved)
- `--cases` is not passed, on any environment (the feature's `cases.yaml`, the only source of the mutation policy and fixture declarations)
- a case was not in an executable state when it ran: `approved_for_execution`, `approved`, `retest`, `under_review` and `quarantined` pass; `case_review` and `rejected` are refused. Names come from `clickup.statuses` (canonical under `tracker: none`); an undeclared status is a refusal
- a verdict is outside the enum, a case ID is not in the case map, a `fail` has no failure summary, or the summary disagrees with the cases
- more than 10% of cases are `blocked` (**RUN HALTED**: the environment failed, not the feature)

### Mutation, fixture and production refusals

The gate takes the environment's `kind`, effective `evidence_upload` and `mutation` block from the profile, not the report. It refuses:

- a report whose `env_kind` is `null` or absent (`env_kind: missing; re-run with 0.3.0`), or differs from the profile's kind for `env_name`
- on production, a report whose `evidence_capture` is not `always`
- a `--cases` file whose `feature` differs from the report's, or that fails the mutation and fixture lint in `cases.schema.md`

`env_name` itself is taken from the report: a report relabelled to another registered environment is a known gap of this gate.

The **effective policy** is the `--cases` file's `mutation.policy`, or `unrestricted` when it has no `mutation`; the **declared prefix** is its `mutation.prefix` or `null`. Neither comes from the report. "Executed" means a verdict of `pass`, `fail` or `flaky`. Each message starts with `rule <n>: `, for example `rule 3: read-only run recorded 2 write(s)`.

1. **Policy matches the declaration.** `--cases` is required (`rule 1: --cases is required`). The report's `mutation_policy` and `mutation_prefix` must equal the effective policy and declared prefix (`null` equals only `null`). Every non-null `writes` in `cases[]` and `fixtures[]` must carry the same `policy` and `prefix`; a `null` `writes` is governed only by rule 2. On production an effective policy of `unrestricted` is refused.

   **1b. The record matches the disk** (messages start `rule 1b: `).
   - Every non-null `writes` must equal the aggregate recomputed from its `paths`, each re-read from disk. A file that is missing, unparseable, or whose `blocked` or `observed` differs from its count of `events` with that `action` reads as not installed.
   - Every `paths` entry must be relative, with no leading `/` and no `..` segment.
   - Let L be the files listed in `paths` across `cases[]` and `fixtures[]`, and U every `writes.json` under the run directory (`--base`), excluding `fixtures/`, that is not in L. Playwright copies attachments, so each file in U must have the same sha256 as a distinct file in L. A `writes.json` no listed file accounts for belongs to a dropped attempt.
   - `attempts`, `retries`, each verdict and every other field parse-report derives from the Playwright JSON (`trace`, `video`, `console_log`, `failure_summary`, `duration_ms`, `assertions`, `writes`) are recomputed from `results.json` in the run directory (the name run-tests gives it; refused when absent), and a differing report value is refused, so a relabelled `blocked` case or a borrowed trace cannot slip through. Exceptions: `trace_sha256` (rule 6 re-hashes the file) and `spec_sha` (needs the spec files).
2. **The guard was live.** On production, or under any effective policy other than `unrestricted`, every executed case and fixture needs a non-null `writes` with `installed: true` and `routed_requests > 0`, and every file in `paths` records `routed_requests > 0`. This also refuses a case with an attempt that never loaded a page (no heartbeat, no routed request); re-run it. When the profile has a `mutation` block and the policy is not `unrestricted`, `write_signatures` must equal the number of the profile's `mutation.write_signatures`.
3. **Read-only wrote nothing.** Under `read-only`, `blocked + observed > 0` in any case or fixture is refused.
4. **Scoped-write stayed in scope.** Under `scoped-write`, `blocked > 0` is refused.
5. **Fixtures are consistent.** Refused: a `fixtures` entry the cases file does not declare; two entries with the same `name` and `phase`; a `teardown` entry for a `teardown: keep` fixture; a declared fixture that an executed case names but that has no `setup` entry; a setup whose verdict is not `pass` while a case naming that fixture is not `blocked`. Under `teardown: delete`, a failed teardown or a passing setup with no teardown entry is a **warning** (an entity was left behind).
6. **Evidence that stays on the machine is pinned.** When effective `evidence_upload` is `reference` or `local`, every case or fixture with a `trace` needs `trace_sha256`; the gate re-hashes the file and refuses a mismatch, and refuses a `trace` that is not a relative path inside the run directory.

Fixtures follow the same trace requirement as cases under the recorded `evidence_capture`.

## What the tracker receives

`scripts/publish-payload.mjs` computes everything a publish sends; the skill posts only what it prints. The output depends on the effective `evidence_upload` of the report's `env_name`, read from the normalized profile (`--profile`). An unregistered `env_name` is an error, never a fallback.

**`tracker`**. Per case: verdict, build SHA (`commit_sha`), env (`env_name`), API mode, app, executor, run date (`finished_at`), flake count (`retries`), model version, target status, and the trace file to attach. Field names are in `skills/publish-results/references/clickup-fields.md`. The run summary, one comment on the feature task, starts with the run id and carries env name, build SHA, counts by verdict, blocked percentage, confidence score and readiness, `requirement_coverage` (below), the executor, and a line saying traces open at <https://trace.playwright.dev> by drag-and-drop.

**`reference`**. The same fields and summary as `tracker`, no attachment. Each case also carries `run_id`, `trace_path` (`cases[].trace`, run-dir relative, same escape check as `local`) and `trace_sha256`. The summary says the traces stay on the machine that ran them, to be verified by sha256 and opened with `npx playwright show-trace <path>`. A bug filed from such a run carries the tracker body including failure text, no attachment, and names the trace path and sha256.

**`local`** (every production environment): no host application data. Per case, exactly:

| Field | From |
|---|---|
| case id | `cases[].id` |
| verdict | `cases[].verdict` |
| target status | `case-status.mjs --transitions` |
| env name | `env_name` |
| build id | `commit_sha` |
| run id | `run_id` |
| trace path | `cases[].trace`, run-dir relative |
| trace sha256 | `cases[].trace_sha256` |

The run summary carries exactly: run id, env name, build id, counts by verdict, blocked percentage, confidence score and readiness, and `requirement_coverage`. Nothing else: no attachment, `failure_summary`, console text, absolute path or executor. A bug filed from such a run (and a dedup comment on an existing bug) names the case id, run id, env name, build id, trace path and trace sha256, and no failure text. A reviewer opens that path on the executor's machine and checks the sha256.

`bug-report.mjs` keys this on the effective `evidence_upload` from the profile, not `env_kind`. Given no profile, it accepts only a report whose `env_kind` is exactly `qa` or `staging` and files it as `reference`; given a profile that does not register `env_name`, it refuses.

**`tracker: none`**: nothing is sent. The payload is a plan of local writes: status transitions applied to `testing/<feature>/statuses.json`, the run summary written into the run directory (same fields as under `tracker`), and bugs written to `testing/<feature>/runs/<run_id>/bugs/<CASE-ID>.md`, which keep the failure text since they never leave the machine. The run directory must be gitignored whenever evidence stays on the machine.

**`requirement_coverage`**, in all modes, is present only when the `case-status.mjs` output given to `publish-payload.mjs` carries `requirements` (see "Requirements and coverage" in `cases.schema.md`: the cases file declares requirements and they are lint-clean); otherwise the key is absent, not empty:

```json
"requirement_coverage": {
  "criteria_total": 4,
  "proved": 1,
  "failing": 1,
  "unproved": 1,
  "uncovered": 1,
  "not_proved": ["ORDER-1", "ORDER-2"]
}
```

The counts are copied from that output. `not_proved` lists, in declaration order, every requirement with at least one criterion not `proved` (uncovered included). Only ids and counts are sent, never criterion text or requirement titles.

## Confidence score

A case counts toward the numerator only when QA **approved** its verdict **and** the verdict was a **pass**, weighted P0 x 3, P1 x 2, P2 x 1 over the same weighted total. (Approval alone would read a feature as 100% Ready just when QA confirmed its P0s were broken.)

Any P0 that is not an approved pass shows **Not Ready** regardless of score. A case with no verdict never counts. With no verdicts at all the score is **Unknown**, not zero. Quarantined and flaky cases stay in the denominator.
