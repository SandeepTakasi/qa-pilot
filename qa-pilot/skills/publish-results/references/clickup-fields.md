# ClickUp mapping

## Space layout

```
Space: <profile clickup.space>
└── Folder: <Release / Sprint>
    └── List: <Feature>                    one list per feature
        └── Task: <CASE-ID> <Title>        one task per test case
```

The feature's own task (the thing developers work from) is where the run-summary comment goes. The case tasks live in the feature's list.

## Statuses

The lifecycle is a **loop**, not a line. A feature is tested on every build, so the states a case returns to matter as much as the ones it passes through.

```
Case Review ──approve──> Approved for Execution
                                  │
                                  ├──────────────< ────────────────┐
                                  ▼                                │
                              (run) ──> Under Review ──> Approved ─┘   re-runs on the next build
                                                    ├──> Retest ───┘   re-runs immediately
                                                    ├──> Quarantined   (flaky: held out, still counted against)
                                                    └──> Rejected      (the test is wrong: back to Case Review to fix)
```

| Status | Set by | Means | Runs again? |
|---|---|---|---|
| `Case Review` | `/generate-tests` | authored, awaiting QA design review | no, nothing executes before approval |
| `Approved for Execution` | QA | design approved, never yet run | **yes** |
| `Under Review` | `/publish-results` | executed with evidence, awaiting QA verdict review | **yes**, and a newer build supersedes; you are warned that unreviewed evidence is being replaced |
| `Approved` | QA via `/qa-review` | the verdict is trusted; counts toward confidence | **yes**, and this is what makes regression runs possible |
| `Rejected` | QA via `/qa-review` | the *test* is wrong; carries a tagged reason | no, fix it via `/generate-tests`, which returns it to `Case Review` |
| `Retest` | QA, or CI on failure | needs another run | **yes** |
| `Quarantined` | `/publish-results` on flaky | excluded from the confidence numerator, still in the denominator | only with `--include-quarantined`, while hardening it |

**Design approval persists.** That is the load-bearing rule: a case QA approved stays executable, so the next build regresses it without anyone resetting anything. Treating `Approved` as terminal would mean the pipeline runs exactly once per feature and then deadlocks with nothing eligible.

Which statuses these are is decided by `scripts/case-status.mjs`, not by prose in three separate skills, so ask it rather than reasoning about the table:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml --statuses <statuses.json> --profile <profile-path>
```

The table above uses the canonical names. **A host names its own statuses** in the profile's `clickup.statuses`, and the pipeline matches on lifecycle keys, so read the profile rather than assuming this wording.

## Custom fields

Every value comes from the validated `report.json`. Nothing here is inferred.

The user creates these by hand per `../../../SETUP-CLICKUP.md`; this table is the
report-to-field mapping for writing values. **If you change a field name or a dropdown
option here, change it there too**, because publish matches on names, so the two drifting
apart breaks it.

| Field | Type | Source |
|---|---|---|
| Verdict | dropdown: pass / fail / flaky / blocked | `cases[].verdict` |
| Priority | dropdown: P0 / P1 / P2 | `cases.yaml` (set at generation, not per run) |
| Type | dropdown: happy / negative / edge / permission / data-validation | `cases.yaml` |
| Build SHA | text | `commit_sha` |
| Env | dropdown | `env_name` |
| API Mode | dropdown: server / mocks | `api_mode` |
| App | dropdown | `app` |
| Executor | text or person | `executor` |
| Run Date | date | `finished_at` |
| Trace | **attachment** | `cases[].trace`, the one evidence artifact, only under `evidence_upload: tracker` |
| Flake Count | number | `cases[].retries` |
| Model Version | text | `model_version` |

`API Mode` earns its place: it is what makes "this pass came from a seeded mock backend" auditable after the fact rather than a thing someone has to remember.

Those values arrive already named: on a `tracker`-mode or `reference`-mode payload, each case's `fields` object uses exactly the field names above, and under `tracker` `attach` names the trace file. Write them as given.

### When evidence is a reference

The default off production is `evidence_upload: reference`. The payload carries the same per-case fields as `tracker` mode and the same run summary, and never the trace file: nothing is attached. Each case also carries three more values, written to the fields below, and the summary's reviewer note says traces stay on the machine that ran them, to be verified by sha256 and opened with `npx playwright show-trace <path>`.

| Field | Type | Payload key |
|---|---|---|
| Run ID | text | `run_id` |
| Trace Path | text | `trace_path`: relative to `testing/<feature>/runs/<run_id>/` on the executor's machine |
| Trace SHA256 | text | `trace_sha256`: the full digest, so a reviewer can verify the file with `shasum -a 256` before opening it |

### When evidence stays local

A run whose environment keeps evidence local, which every production run does, sends no application data. `publish-payload.mjs` returns a different, smaller set per case, and these are the only fields written:

| Field | Type | Payload key |
|---|---|---|
| Verdict | dropdown | `verdict` |
| Env | dropdown | `env_name` |
| Build SHA | text | `build_id` |
| Run ID | text | `run_id` |
| Trace Path | text | `trace_path`: relative to `testing/<feature>/runs/<run_id>/` on the executor's machine |
| Trace SHA256 | text | `trace_sha256`: the full digest, so a reviewer can verify the file with `shasum -a 256` before opening it |

Status comes from `target_status`. Nothing is attached, and API Mode, App, Executor, Run Date, Flake Count and Model Version are left as they were. `Run ID`, `Trace Path` and `Trace SHA256` are created once alongside the other fields (see `../../../SETUP-CLICKUP.md`); they are needed by default, because `reference` writes them too. Only a host that opts every environment in to `evidence_upload: tracker` can skip them.

## Evidence stays on the machine, unless an environment opts in

One artifact per case per run: **`trace.zip`**. Where it goes depends on the environment's effective `evidence_upload`:

- `reference` (the default off production): nothing is attached. The trace stays in the run directory and the case task records its path and sha256 next to the usual fields (above).
- `tracker` (opt-in per environment): the trace is attached to the case task. Turn on Private Attachment Links and use a restricted test account first: a trace can carry a long-lived refresh token, which stays valid until the account is disabled, deleted or changed.
- `local` (always on production): nothing is attached and no application data is sent; the case task records the path and sha256 only.

A Playwright trace contains the video byte-for-byte, the console output, the screenshot film-strip, DOM snapshots and the network log. Attaching the video and console separately stores the same bytes twice and splits one investigation across three files, so the trace supersedes both.

Reviewers open a trace with `npx playwright show-trace <path>`, which keeps it on their machine, and for any trace that can carry a credential this is the way to open it. Dragging it onto <https://trace.playwright.dev> also works: Playwright's docs are explicit that the viewer "loads the trace entirely in your browser and does not transmit any data externally".

### Limits that shaped this

| | |
|---|---|
| Storage | 60 MB on Free; **unlimited on every paid plan**, but the usage meter exists *only* on Free, so paid workspaces cannot see their own consumption |
| Max file size | **1 GB** per attachment, via UI and API alike, far above any real trace |
| Attachments per task | **1,000.** One trace per run against a per-*case* task is ~1,000 runs, six years at three a week. This is why evidence goes on the case task and never on the feature task, which would fill in about seven weeks |
| Rate | **100 requests/min per token** on Free through Business; 1,000 on Business Plus; 10,000 on Enterprise. Per *token*, so give each developer their own OAuth token rather than sharing one |

On a 429: wait 60 seconds and resume where you stopped. Never restart the whole publish.

### Two operational requirements

**Before opting an environment in to `evidence_upload: tracker`, turn on Private Attachment Links** (Settings → Advanced Permissions; available on all plans, **off by default**). Without it, every attachment URL is public, unauthenticated and non-expiring: security by unguessable string alone. Traces carry application state and can carry long-lived tokens, so use a restricted account too; a leaked trace means disabling or rotating that account. The trade-off: `npx playwright show-trace <url>` stops working against ClickUp URLs, because it sends no auth header, so reviewers download first and then open.

**Retention is manual, under `tracker`.** ClickUp's API has no delete-attachment endpoint: deleting the parent task is the only programmatic lever, and case tasks must persist because the status lifecycle lives on them. So traces accumulate at roughly 1 to 5 MB per case-run and are pruned by hand from the task's attachment list. Budget a quarterly pass, oldest passing runs first; keep every failure. Nobody re-opens a passing trace once QA has approved it.

## Run-summary comment

One per run, on the **feature** task. Begin with the run ID so a re-publish can find and update its own comment instead of duplicating it.

```
2026-08-30T09:22Z-checkout-a1b2c3d · qa @ a1b2c3d (server)

12 pass · 2 fail · 1 flaky · 0 blocked
Confidence: 31% · Not Ready (14 cases now awaiting QA review)
Executor: <name> · Playwright 1.62.1 · chromium-141

Requirements: 6 criteria · 2 proved · 1 failing · 2 unproved · 1 uncovered
Not proved: CHECKOUT-1, CHECKOUT-3
Failed: CHECKOUT-ORDER-002, CHECKOUT-QTY-007
Quarantined (flaky): CHECKOUT-QTY-003
```

The two `Requirements` lines are the payload's `requirement_coverage` (`criteria_total`, `proved`, `failing`, `unproved`, `uncovered`, `not_proved`), and they appear only when the payload carries it: the cases file declares requirements and they are lint-clean, and `--confidence` was given the whole `case-status.mjs` output. They are ids and counts, never a requirement title or criterion text, so they are written in every mode, local included. A feature with no requirements has no such lines. They sit beside the score and change neither it nor the readiness.

The score is deliberately low here: publishing moves cases to `Under Review`, and only `Approved` counts toward the numerator. It climbs as QA works the queue. A first publish scoring 0% is normal, not alarming, so say so rather than posting a bare number.

Keep it to facts already in the report. A comment that interprets the run is a model opinion wearing the record's authority.

For a run whose evidence stays local, the comment holds only what the payload's summary holds: run ID, environment, build, counts, blocked percentage, confidence, readiness and, when present, the requirement coverage lines (ids and counts). No executor, no failed-case list with failure text, no trace link:

```
2026-08-30T09:22Z-checkout-a1b2c3d · production @ a1b2c3d

12 pass · 2 fail · 1 flaky · 0 blocked (0% blocked)
Confidence: 31% · Not Ready
Requirements: 6 criteria · 2 proved · 1 failing · 2 unproved · 1 uncovered
Not proved: CHECKOUT-1, CHECKOUT-3
```

Each case task carries its own trace path and `trace_sha256`, which is how a reviewer finds and verifies the file; the run directory follows from the feature and the run ID (`testing/<feature>/runs/<run_id>/`).
