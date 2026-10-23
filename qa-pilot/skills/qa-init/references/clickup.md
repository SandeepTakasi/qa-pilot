# qa-init: ClickUp steps

Read this only when `tracker: clickup`. It holds interview items 7 and 8 and the ClickUp rows of the gap report.

## Interview item 7: ClickUp

Ask for the space that holds QA work. Do not ask about the tier: `clickup.plan_tier` is optional and nothing reads it. Also ask which **folder** in that space holds the feature lists and record it as `clickup.folder`; without it a feature list can land beside someone's manual QA work. A dedicated folder for the pipeline is the usual answer.

## Interview item 8: status names

Ask what statuses the QA space already has and reuse that vocabulary. Map the names onto the seven keys and write them to `clickup.statuses`, explicitly even when the canonical names fit:

| Key | What it means |
|---|---|
| `case_review` | authored, awaiting QA design review |
| `approved_for_execution` | design approved, never yet run |
| `under_review` | executed, awaiting QA verdict review |
| `approved` | verdict accepted; counts toward confidence |
| `rejected` | the test itself is wrong, which is different from the test failing |
| `retest` | needs another run |
| `quarantined` | flaky; held out, still in the denominator |

Trap: a board whose statuses are `pass` and `fail` records a **verdict**. QA-Pilot keeps the verdict in a custom field and uses status for approval, so `pass` is not `approved`. If the existing vocabulary cannot express approval, say so and have them add statuses rather than forcing a mapping.

## Gap report rows

| Gap | Blocks |
|---|---|
| ClickUp space, statuses or custom fields not created | `/publish-results` |
| Private Attachment Links not enabled in ClickUp | `evidence_upload: tracker` on any environment: attachment URLs are public and non-expiring by default |
| All developers sharing one ClickUp API token | `/publish-results` under concurrency: the 100 req/min budget is per token |
| `Run ID`, `Trace Path`, `Trace SHA256` fields not created | `/publish-results` by default, since `reference` and `local` fill them on every case |

The plugin does not create the ClickUp structure; the user does, once. Point them at `${CLAUDE_PLUGIN_ROOT}/SETUP-CLICKUP.md` (exact statuses, custom fields, dropdown options, the two settings above). Names are matched literally at publish time. `Env`, `App` and one `API Mode` option are host-specific, so list the concrete values from the profile you wrote: the environment names, the app names and the sandbox value.
