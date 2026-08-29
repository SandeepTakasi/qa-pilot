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

```
Case Review → Approved for Execution → Under Review → Approved | Rejected | Retest | Quarantined
```

| Status | Set by | Means |
|---|---|---|
| `Case Review` | `/generate-tests` | authored, awaiting QA design review |
| `Approved for Execution` | QA | `/run-tests` will execute it; nothing else will |
| `Under Review` | `/publish-results` | executed with evidence, awaiting QA verdict review |
| `Approved` | QA via `/qa-review` | the verdict is trusted; counts toward confidence |
| `Rejected` | QA via `/qa-review` | the verdict is not trusted; carries a tagged reason |
| `Retest` | QA, or CI on failure | needs another run |
| `Quarantined` | `/publish-results` on flaky | excluded from the confidence numerator, still in the denominator |

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
Confidence: 78% · Ready
Executor: <name> · Playwright 1.62.1 · chromium-141

Failed: CHECKOUT-ORDER-002, CHECKOUT-QTY-007
Quarantined (flaky): CHECKOUT-QTY-003
```

Keep it to facts already in the report. A comment that interprets the run is a model opinion wearing the record's authority.
