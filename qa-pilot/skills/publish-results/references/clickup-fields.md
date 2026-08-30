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
                                                    └──> Rejected      (the test is wrong — back to Case Review to fix)
```

| Status | Set by | Means | Runs again? |
|---|---|---|---|
| `Case Review` | `/generate-tests` | authored, awaiting QA design review | no — nothing executes before approval |
| `Approved for Execution` | QA | design approved, never yet run | **yes** |
| `Under Review` | `/publish-results` | executed with evidence, awaiting QA verdict review | **yes** — a newer build supersedes; you are warned that unreviewed evidence is being replaced |
| `Approved` | QA via `/qa-review` | the verdict is trusted; counts toward confidence | **yes** — this is what makes regression runs possible |
| `Rejected` | QA via `/qa-review` | the *test* is wrong; carries a tagged reason | no — fix it via `/generate-tests`, which returns it to `Case Review` |
| `Retest` | QA, or CI on failure | needs another run | **yes** |
| `Quarantined` | `/publish-results` on flaky | excluded from the confidence numerator, still in the denominator | only with `--include-quarantined`, while hardening it |

**Design approval persists.** That is the load-bearing rule: a case QA approved stays executable, so the next build regresses it without anyone resetting anything. Treating `Approved` as terminal would mean the pipeline runs exactly once per feature and then deadlocks with nothing eligible.

Which statuses these are is decided by `scripts/case-status.mjs`, not by prose in three separate skills — ask it rather than reasoning about the table:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml --statuses <statuses.json>
```

## Custom fields

Every value comes from the validated `report.json`. Nothing here is inferred.

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
| Video | attachment or URL | `cases[].video` |
| Trace | attachment or URL | `cases[].trace` |
| Flake Count | number | `cases[].retries` |
| Model Version | text | `model_version` |

`API Mode` earns its place: it is what makes "this pass came from a seeded mock backend" auditable after the fact rather than a thing someone has to remember.

## Rate and size limits

- **100 requests per minute per token** on Free through Business; 1,000 on Business Plus; 10,000 on Enterprise. The profile's `clickup.plan_tier` records which applies.
- One coalesced update per task. A 25-case feature is then ~25 updates plus attachments plus one comment — comfortably inside the budget, but only if calls are sequential and updates are not split per field.
- On a 429: wait 60 seconds, resume where you stopped. Never restart the whole publish.
- Attachments: 1 GB per file by API, but keep videos under 50 MB inline; link anything larger.
- Retention: keep the latest run's videos plus every failure's video. Prune passing-run videos older than 14 days.

## Run-summary comment

One per run, on the **feature** task. Begin with the run ID so a re-publish can find and update its own comment instead of duplicating it.

```
2026-08-30T09:22Z-checkout-a1b2c3d — qa @ a1b2c3d (server)

12 pass · 2 fail · 1 flaky · 0 blocked
Confidence: 31% · Not Ready — 14 cases now awaiting QA review
Executor: <name> · Playwright 1.62.1 · chromium-141

Failed: CHECKOUT-ORDER-002, CHECKOUT-QTY-007
Quarantined (flaky): CHECKOUT-QTY-003
```

The score is deliberately low here: publishing moves cases to `Under Review`, and only `Approved` counts toward the numerator. It climbs as QA works the queue. A first publish scoring 0% is normal, not alarming — say so rather than posting a bare number.

Keep it to facts already in the report. A comment that interprets the run is a model opinion wearing the record's authority.
