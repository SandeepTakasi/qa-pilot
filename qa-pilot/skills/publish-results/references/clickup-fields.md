# ClickUp mapping

## Space layout

```
Space: <profile clickup.space>
└── Folder: <Release / Sprint>
    └── List: <Feature>                    one list per feature
        └── Task: <CASE-ID> <Title>        one task per test case
```

The run-summary comment goes on the feature's own task (the one developers work from). Case tasks live in the feature's list.

## Statuses

The lifecycle is a loop: a feature is tested on every build, so the states a case returns to matter as much as the ones it passes through.

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
| `Case Review` | `/generate-tests` | authored, awaiting QA design review | no |
| `Approved for Execution` | QA | design approved, never yet run | **yes** |
| `Under Review` | `/publish-results` | executed with evidence, awaiting QA verdict review | **yes**; a newer build supersedes, with a warning that unreviewed evidence is being replaced |
| `Approved` | QA via `/qa-review` | verdict trusted; counts toward confidence | **yes**, which is what makes regression runs possible |
| `Rejected` | QA via `/qa-review` | the *test* is wrong; carries a tagged reason | no; fix via `/generate-tests`, which returns it to `Case Review` |
| `Retest` | QA, or CI on failure | needs another run | **yes** |
| `Quarantined` | `/publish-results` on flaky | out of the confidence numerator, still in the denominator | only with `--include-quarantined` |

Design approval persists: `Approved` is not terminal, or the pipeline would run once per feature and deadlock. `scripts/case-status.mjs` decides which statuses mean what; ask it rather than reasoning from the table:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml --statuses <statuses.json> --profile <profile-path>
```

The names above are canonical. **A host names its own statuses** in the profile's `clickup.statuses` and the pipeline matches on lifecycle keys, so read the profile.

## Custom fields

Every value comes from the validated `report.json`; nothing is inferred. The user creates these by hand per `../../../SETUP-CLICKUP.md`. **If you change a field name or dropdown option here, change it there too**: publish matches on names.

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
| Trace | **attachment** | `cases[].trace`, only under `evidence_upload: tracker` |
| Flake Count | number | `cases[].retries` |
| Model Version | text | `model_version` |

On `tracker` and `reference` payloads each case's `fields` object uses exactly these names; write them as given. Under `tracker`, `attach` names the trace file.

### When evidence is a reference

Same per-case fields and summary as `tracker`, nothing attached. Each case also carries three more values:

| Field | Type | Payload key |
|---|---|---|
| Run ID | text | `run_id` |
| Trace Path | text | `trace_path`, relative to `testing/<feature>/runs/<run_id>/` on the executor's machine |
| Trace SHA256 | text | `trace_sha256`, the full digest, for `shasum -a 256` before opening |

### When evidence stays local

Every production run. These are the only fields written:

| Field | Type | Payload key |
|---|---|---|
| Verdict | dropdown | `verdict` |
| Env | dropdown | `env_name` |
| Build SHA | text | `build_id` |
| Run ID | text | `run_id` |
| Trace Path | text | `trace_path` |
| Trace SHA256 | text | `trace_sha256` |

Status comes from `target_status`. API Mode, App, Executor, Run Date, Flake Count and Model Version are left as they were. `Run ID`, `Trace Path` and `Trace SHA256` are created once with the other fields (`../../../SETUP-CLICKUP.md`) and are needed by default, since `reference` writes them too.

## Writing the tasks

Step 7 of `SKILL.md`, after the write flag is set. Calls are sequential, never parallel.

**Per case** (`payload.cases[]`):

- Take the task ID from `clickup-map.json`. Never search by name: a renamed task would create a duplicate and split the case's history.
- One `clickup_update_task` per task, setting every field the payload gives at once (the Business tier allows 100 requests per minute per token).
- Status is `target_status`, already resolved to this host's name; `null` leaves it alone. A case that passed on an unchanged approved spec stays `approved`.
- On `tracker` only, attach the trace named in `attach` with `clickup_attach_task_file`, under `attach.name`, resolving `attach.path` against `$RUN_DIR`. Do not upload the `.webm` or console log: the trace holds both. On `reference` and `local` upload nothing.
- A trace over 1 GB (the API cap) means something is wrong with the run; report it.

**Once per feature** (`payload.summary`): one comment on the feature task (`clickup_create_task_comment`), not one per case. It holds exactly the summary's fields (`requirement_coverage` only when the payload has it) and starts with the run ID. On `tracker` and `reference` it includes the executor and the payload's `reviewer_note`, posted as given; on `local` neither, since neither is in the payload.

**Rate limit**: 100 requests/min is per token, so developers sharing one token exhaust it together; per-user OAuth tokens give each executor a budget and make `executor` truthful. On a 429, wait 60 seconds and resume where you stopped.

**Idempotency**: re-publishing the same run overwrites fields with the same values and finds its own summary comment by run-ID prefix (`clickup_get_task_comments`) and **updates** it. A new run ID appends a new comment; that is run history.

## Evidence stays on the machine, unless an environment opts in

One artifact per case per run: **`trace.zip`**. It holds the video byte-for-byte, console output, screenshots, DOM snapshots and the network log, so the video and console are never attached separately. Where it goes depends on the environment's effective `evidence_upload`:

- `reference` (default off production): not attached; the case task records its path and sha256.
- `tracker` (opt-in, never production): attached to the case task. Turn on Private Attachment Links and use a restricted test account first: a trace can carry a long-lived refresh token.
- `local` (always on production): not attached, no application data sent; path and sha256 only.

Open a trace with `npx playwright show-trace <path>`, which keeps it on the reviewer's machine; use this for any trace that can carry a credential. Dragging it onto <https://trace.playwright.dev> also works: Playwright's docs say the viewer "loads the trace entirely in your browser and does not transmit any data externally".

### Limits

| | |
|---|---|
| Storage | 60 MB on Free; unlimited on paid plans, but the usage meter exists only on Free |
| Max file size | **1 GB** per attachment |
| Attachments per task | **1,000.** One trace per run on a case task is about six years at three runs a week, so evidence goes on the case task, never the feature task (full in about seven weeks) |
| Rate | **100 requests/min per token** on Free through Business; 1,000 on Business Plus; 10,000 on Enterprise |

### Two operational requirements

**Before opting an environment in to `evidence_upload: tracker`, turn on Private Attachment Links** (Settings → Advanced Permissions; all plans, **off by default**). Without it every attachment URL is public, unauthenticated and non-expiring. Use a restricted account too; a leaked trace means disabling or rotating it. `npx playwright show-trace <url>` stops working on ClickUp URLs (no auth header), so reviewers download first.

**Retention is manual under `tracker`.** ClickUp's API has no delete-attachment endpoint, and case tasks must persist because the status lifecycle lives on them. Traces accumulate at about 1 to 5 MB per case-run and are pruned by hand from the attachment list. Budget a quarterly pass, oldest passing runs first; keep every failure.

## Run-summary comment

One per run, on the **feature** task, beginning with the run ID. Facts from the report only: a comment that interprets the run is a model opinion wearing the record's authority.

```
20260830T092200Z-checkout-a1b2c3d · qa @ a1b2c3d (server)

12 pass · 2 fail · 1 flaky · 0 blocked
Confidence: 31% · Not Ready (14 cases now awaiting QA review)
Executor: <name> · Playwright 1.62.1 · chromium-141

Requirements: 6 criteria · 2 proved · 1 failing · 2 unproved · 1 uncovered
Not proved: CHECKOUT-1, CHECKOUT-3
Failed: CHECKOUT-ORDER-002, CHECKOUT-QTY-007
Quarantined (flaky): CHECKOUT-QTY-003
```

The two `Requirements` lines are the payload's `requirement_coverage`: ids and counts, never titles or criterion text, so written in every mode. They appear only when the payload carries it, and change neither score nor readiness.

The score is low by design: publishing moves cases to `Under Review`, and only `Approved` counts. A first publish at 0% is normal; say so rather than posting a bare number.

When evidence stays local the comment holds only the payload summary: no executor, no failed-case list, no trace link. A reviewer finds the run directory from the feature and run ID, and the file from the case task's trace path and `trace_sha256`.

```
20260830T092200Z-checkout-a1b2c3d · production @ a1b2c3d

12 pass · 2 fail · 1 flaky · 0 blocked (0% blocked)
Confidence: 31% · Not Ready
Requirements: 6 criteria · 2 proved · 1 failing · 2 unproved · 1 uncovered
Not proved: CHECKOUT-1, CHECKOUT-3
```
