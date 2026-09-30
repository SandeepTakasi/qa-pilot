# `report.json`: uniform run report

Produced by `parse-report.mjs` from a Playwright JSON report plus the run's `meta.json`. Gated by `validate-report.mjs` before anything reaches ClickUp.

Nothing in this file is written by a model. Every field is copied from the Playwright report or the run metadata, or computed from them. That is what makes the record of truth immune to hallucination.

```yaml
run_id: <ISO timestamp>-<feature>-<short sha>
feature: string
app: string                  # which frontend, on multi-app hosts
env_name: string             # must be a registered environment
env_kind: qa | staging | production  # from meta.json; the gate recomputes it from the profile
env_url: string              # must match the registry for this app+env
mutation_policy: read-only | scoped-write | unrestricted | null  # from meta.json
mutation_prefix: string | null  # from meta.json; non-null only under scoped-write
api_mode: string             # "server" | the host's sandbox value; sandbox runs cannot publish
commit_sha: string           # the deployed build
sha_before: string           # read from the environment before the run
sha_after: string            # and after
sha_source: string           # required; the URL it was read from
sha_format: commit | build-id  # what commit_sha actually is; see the profile schema
evidence_capture: always | on-failure | off  # what the host chose to keep
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
    trace: <path>            # REQUIRED for pass | fail | flaky: THE evidence artifact.
                             # Relative to the run dir (see "Where the report lives").
    trace_sha256: string | null  # sha256 of the trace file, 64 hex chars, computed by the
                             # parse-report CLI; null when there is no trace
    writes: <writes> | null  # the write guard's record, below; null when no attempt
                             # attached a writes.json
    video: <path>            # optional carry-through; the trace already contains it
    console_log: <path>      # optional carry-through; the trace already contains it
    failure_summary: string  # REQUIRED for fail: the Playwright error, ANSI-stripped,
                             # capped at 500 chars. Never model prose.
    retries: integer
    spec_sha: string | null  # hash of the spec file that produced this verdict, from
                             # parse-report's --specs map. null means the spec was not
                             # hashed, which is treated as "changed": a passing case with
                             # no hash goes back for review rather than keeping approval.

fixtures:                    # one entry per fixture spec that ran; [] when none did
  - name: string             # from the title, which must match
                             # ^FIXTURE ([a-z0-9-]+)( teardown)?$ ; any other title that
                             # starts with FIXTURE goes to unmapped_specs
    phase: setup | teardown  # teardown iff the title ends in " teardown"
    verdict: pass | fail | flaky | blocked   # derived exactly as for cases
    trace: <path> | null     # relative to the run dir
    trace_sha256: string | null
    writes: <writes> | null

summary: { pass, fail, flaky, blocked }   # cases only; fixtures are not counted
unmapped_specs: [string]     # spec titles with neither a case-ID prefix nor a FIXTURE title;
                             # dropped, never guessed at
```

`<writes>` is the aggregate of every `writes.json` the case's (or fixture's) attempts attached,
across all retries and all projects, because a write on a failed first attempt is still a write:

```yaml
attempts: integer            # attempt results across all projects (the length of every
                             # tests[].results[] for this spec, summed)
paths: [<path>]              # every writes.json, relative to the run dir, in attempt order
installed: boolean           # true iff paths.length === attempts and every file has
                             # installed: true; an attempt with no writes.json makes it false
policy: string | null        # the policy every file recorded; null when they disagree
prefix: string | null        # likewise
write_signatures: integer    # the smallest count any file recorded
routed_requests: integer     # summed
blocked: integer             # summed
observed: integer            # summed
```

Events are not copied into the report. They stay in the `writes.json` files, inside the run
directory, and are never sent to the tracker.

## Run metadata

`/qa-pilot:run-tests` writes `testing/<feature>/runs/<run_id>/meta.json`. On top of the 0.2.0
fields it records:

| Field | Value |
|---|---|
| `env_kind` | the environment's `kind` from the host profile |
| `mutation_policy` | `cases.yaml` `mutation.policy`, or `unrestricted` when the file has no `mutation` |
| `mutation_prefix` | `cases.yaml` `mutation.prefix` under `scoped-write`, `null` otherwise |

`parse-report.mjs` copies all three into the report, as `null` when meta lacks them (a 0.2.0
run). The gate never takes `env_kind` on trust: it recomputes it from the profile, and a `null`
`env_kind` is refused (see the refusals below), so a 0.2.0 run cannot be published by 0.3.0.

## Where the report lives

The run directory is `dirname(meta.json)`, that is `testing/<feature>/runs/<run_id>/`.
`parse-report.mjs` writes `report.json` there by default, and every `trace` and `writes.paths`
entry is relative to it, so `validate-report.mjs`'s default `--base` (the report's own
directory) resolves them. Paths use `/` separators.

`trace_sha256` is computed by the parse-report CLI from the trace file's bytes and injected into
`buildReport`, as `spec_sha` is, so `buildReport` stays free of I/O. It is the full 64-character
hex digest. A trace the CLI cannot read gets `null` and a warning.

## Environment the write guard reads

`/qa-pilot:run-tests` (and the CI template) set these for the Playwright process:

| Variable | Value | Unset |
|---|---|---|
| `QA_PILOT_MUTATION` | JSON `{"policy": "<policy>", "prefix": "<prefix>"}`, from `cases.yaml`; `prefix` only under `scoped-write` | the guard runs `read-only`. It never falls back to `unrestricted` |
| `QA_PILOT_MUTATION_CONFIG` | the host profile's `mutation` block, as JSON, uncompiled | the guard uses its generic control defaults and has no write signatures, which it records as `write_signatures: 0` |
| `QA_PILOT_FIXTURE_DIR` | absolute path of `testing/<feature>/runs/<run_id>/fixtures/` | a fixture setup or dependent throws |

`QA_PILOT_MUTATION` that is not valid JSON, names a policy outside the enum, lacks a `prefix`
under `scoped-write`, or carries a prefix under any policy other than `scoped-write` makes the
guard throw before the test starts, so every test fails rather than running with a scope nobody
declared. `QA_PILOT_MUTATION_CONFIG` that is set but not valid JSON, or holds a regex that does
not compile, throws the same way.

## The write guard's record: `writes.json`

The guard fixture writes one `writes.json` per test attempt to `testInfo.outputPath('writes.json')`
and attaches it **by path** (attachment name `writes.json`, content type `application/json`). It
lives inside the run directory and never leaves the executor's machine.

```yaml
installed: boolean           # true once the page-side guard has reported in (a heartbeat
                             # from the init script); false or absent means it never ran
policy: read-only | scoped-write | unrestricted   # what the guard actually enforced
prefix: string | null        # the scoped-write prefix it enforced
scope_urls: [string]         # every scope URL regex the spec set with setScope, in order
write_signatures: integer    # how many write signatures the guard compiled
routed_requests: integer     # requests the network route saw
blocked: integer             # controls and requests the guard stopped
observed: integer            # write requests it let through and recorded (scoped-write)
events:
  - kind: control | request
    action: block | observe
    reason: string           # why: the deny rule, signature or scope check that decided it
    label: string            # control only: innerText, aria-label or title
    method: string           # request only
    url: string              # request only
    at: ISO 8601
```

`blocked` and `observed` equal the number of `events` with that `action`. A worker that dies
before the fixture's teardown writes no `writes.json`, and the gate reads that attempt as not
installed.

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
- `--statuses` was not passed. It is the statuses recorded at the start of the run, and it is the only thing that proves each case was approved. A gate that can be skipped by omitting a flag is not a gate
- `--cases` was not passed, on any environment. It is the feature's `cases.yaml`, and it is the only source of the mutation policy and the fixture declarations the rules below check against. Same reasoning as `--statuses`
- a case was not in an approved state when it ran. Executable states are `approved_for_execution`, `approved`, `retest`, `under_review` and `quarantined`; `case_review` and `rejected` are refused. Matching uses this host's names from `clickup.statuses`, so a status the profile does not declare is a refusal rather than a guess
- a verdict is outside the enum, a case ID is not in the case map, a `fail` has no failure summary, or the summary disagrees with the cases
- more than 10% of cases are `blocked`. **RUN HALTED**: the environment failed, not the feature

### Mutation, fixture and production refusals

The gate reads three things from the profile rather than from the report: the environment's
`kind`, its effective `evidence_upload`, and its `mutation` block. A report whose `env_kind` is
`null` or absent is refused with `env_kind: missing; re-run with 0.3.0`, and one whose `env_kind`
disagrees with the profile's kind for `env_name` is refused.

The **effective policy** is the `--cases` file's `mutation.policy`, or `unrestricted` when the
file has no `mutation`. The **declared prefix** is its `mutation.prefix`, or `null` when absent.
Neither is ever taken from the report. "Executed" below means a verdict of `pass`, `fail` or
`flaky`. Each refusal message starts with `rule <n>: `, for example
`rule 3: read-only run recorded 2 write(s)`, so a test can tell which rule refused.

1. **Policy matches the declaration.** `--cases` is required on every environment; without it
   the gate refuses with `rule 1: --cases is required`. The report's `mutation_policy` must equal
   the effective policy and its `mutation_prefix` must equal the declared prefix, where `null`
   equals `null` and a `null` report value never equals a non-null declaration. Every non-null
   `writes` in `cases[]` and `fixtures[]` must carry the same `policy` and `prefix` by the same
   comparison; a `null` `writes` is governed only by rule 2. On a production environment an
   effective policy of `unrestricted` is refused.
   **1b. The record matches the disk.** Every non-null `writes` in the report must equal the
   aggregate recomputed from its `paths`, each re-read from disk, with `attempts` taken from the
   report (a missing or unparseable file reads as not installed). The report is the file the
   gate is handed, so it is never the source.
2. **The guard was live.** On a production environment, or under any effective policy other than
   `unrestricted` on any environment, every executed case and every executed fixture needs a
   non-null `writes` with `installed: true` and `routed_requests > 0`. Whenever the profile has a
   `mutation` block and the effective policy is not `unrestricted`, each such `writes` must also
   have `write_signatures` equal to the number of entries in the profile's
   `mutation.write_signatures`, so a run whose guard never received the host's signatures cannot
   pass as clean.
3. **Read-only wrote nothing.** Under `read-only`, any case or fixture whose `writes` has
   `blocked + observed > 0` is refused: `rule 3: read-only run recorded N write(s)`.
4. **Scoped-write stayed in scope.** Under `scoped-write`, any case or fixture whose `writes` has
   `blocked > 0` is refused.
5. **Fixtures are consistent.** A `fixtures` entry whose name the cases file does not declare is
   refused. A declared fixture
   that some executed case names must have a `setup` entry. A `setup` whose verdict is not `pass`
   requires every case naming that fixture to be `blocked`, and is refused otherwise. Under
   `teardown: delete`, a `teardown` entry whose verdict is not `pass`, or a passing setup with no
   `teardown` entry, is a **warning** naming the fixture and the environment, because an entity
   was left behind.
6. **Local evidence is pinned.** When the effective `evidence_upload` is `local`, every case or
   fixture that has a `trace` needs `trace_sha256`; the gate re-hashes the file and refuses a
   mismatch. The `trace` must also be a relative path that stays inside the run directory (no
   leading `/`, no `..` segment), because that path is what the tracker receives.

Fixtures follow the same trace requirement as cases under the recorded `evidence_capture`.

## What the tracker receives

`scripts/publish-payload.mjs` computes everything a publish sends to the tracker; the skill
posts only what it prints. What it prints depends on the effective `evidence_upload` of the
report's `env_name`, read from the normalized profile given by `--profile`. An `env_name` the
profile does not register is an error, never a fallback to `tracker`.

**`tracker`** (the 0.2.0 field set). Per case: verdict, build SHA (`commit_sha`), env
(`env_name`), API mode (`api_mode`), app, executor, run date (`finished_at`), flake count
(`retries`), model version, the target status, and the trace file to attach; priority and type
are set at generation, not per run. See `skills/publish-results/references/clickup-fields.md` for
the field names. The run summary, one comment on the feature task, starts with the run id and
carries the env name, build SHA, counts by verdict, blocked percentage, confidence score and
readiness, the executor, and the line telling the reviewer that traces open at
<https://trace.playwright.dev> by drag-and-drop.

**`local`**, which every production environment is: no host application data. Per case, exactly:

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

The run summary carries exactly: run id, env name, build id, counts by verdict, blocked
percentage, confidence score and readiness. Nothing else is sent: no attachment, no
`failure_summary`, no console text, no absolute path, no executor. A bug filed from such a run
(and a dedup comment on an existing bug) names the case id, run id, env name, build id, trace
path and trace sha256, and no failure text. `bug-report.mjs` keys this on the same effective
`evidence_upload: local` from the profile, not on `env_kind`; given no profile, it refuses a
report whose `env_kind` is `production` or absent.
A reviewer finds the evidence by opening that path on the executor's machine and checking it with
the sha256.

**`tracker: none`**: nothing is sent anywhere. The payload is a plan of local writes: status
transitions applied to `testing/<feature>/statuses.json`, the run summary written into the run
directory, and bugs written to `testing/<feature>/runs/<run_id>/bugs/<CASE-ID>.md`.

## Confidence score

A case counts toward the numerator only when QA **approved** its verdict **and** that verdict was a **pass**, weighted P0 x 3, P1 x 2, P2 x 1 over the same weighted total.

Both halves are required. `/qa-pilot:qa-review` correctly tells QA that a confirmed real failure is a bug rather than a broken test, so the honest action on a failing P0 is to approve the verdict. Scoring on approval alone therefore read a feature as 100% Ready precisely when QA had just confirmed its P0s were broken.

Any P0 that is not an approved pass displays **Not Ready** regardless of the score. A case with no verdict never counts, so a case that did not run is not a proved case. With no verdicts at all the score is **Unknown**, not zero: nothing has been proved either way, and saying so beats printing a number that means something else.

Quarantined and flaky cases stay in the denominator, since lowering the number is the point.
