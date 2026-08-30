# ClickUp setup

QA-Pilot does not create your ClickUp structure — you do, once, by hand. This is the exact
list. `/qa-pilot:publish-results` writes into what you build here, and it fails on anything
missing, so get the names right: **the plugin matches on names, not IDs.**

Fifteen minutes, once per workspace.

## 1. Space

Create a Space for QA work. Any name; record it as `clickup.space` in `qa-pilot.config.yaml`.

Inside it, one Folder per release or sprint, and **one List per feature**. Case tasks live
in the feature's List. Nothing enforces the Folder layer — it is there so a sprint's
features stay together.

## 2. Custom statuses

Set these on the Space so every feature List inherits them. **Use these exact names.**

| Status | Suggested type |
|---|---|
| `Case Review` | Not started |
| `Approved for Execution` | Active |
| `Under Review` | Active |
| `Approved` | Done |
| `Rejected` | Active |
| `Retest` | Active |
| `Quarantined` | Active |

Do not mark `Approved` as Closed. Closed statuses hide tasks from default views, and an
approved case is not finished — it re-runs on the next build. That persistence is what
makes this a regression suite instead of a one-shot.

## 3. Custom fields

Create these on the Space. Names must match exactly; dropdown options must match exactly.

| Field | Type | Options |
|---|---|---|
| Verdict | Dropdown | `pass`, `fail`, `flaky`, `blocked` |
| Priority | Dropdown | `P0`, `P1`, `P2` |
| Type | Dropdown | `happy`, `negative`, `edge`, `permission`, `data-validation` |
| Build SHA | Text | — |
| Env | Dropdown | one option per environment in your profile (e.g. `qa`, `staging`) |
| API Mode | Dropdown | `server`, plus your sandbox value (e.g. `mocks`) |
| App | Dropdown | one option per app in your profile (e.g. `storefront`, `admin`) |
| Executor | Text | — |
| Run Date | Date | — |
| Flake Count | Number | — |
| Model Version | Text | — |

The last three dropdowns are host-specific: their options come from your
`qa-pilot.config.yaml`, so create them after `/qa-pilot:qa-init` has written it.

There is no Trace field. Traces are **attachments** on the case task, not a field value.

## 4. Two settings that matter

**Turn on Private Attachment Links.** Settings → Advanced Permissions. Available on every
plan, **off by default**. Without it, every attachment URL is public, unauthenticated and
non-expiring — security by unguessable string alone. Test traces carry application state
and can carry tokens.

Consequence to know: `npx playwright show-trace <url>` stops working against ClickUp URLs
because it sends no auth header. Reviewers download the trace first, then open it.

**Give each developer their own API token.** The rate limit is 100 requests per minute
**per token** on Free through Business (1,000 on Business Plus, 10,000 on Enterprise). One
shared token means five developers exhaust one budget between them and 429 each other
mid-publish. Per-user tokens also make the `Executor` field truthful without anyone
maintaining it.

## 5. Check it before the pilot

Run one feature end to end on a throwaway List. If `/qa-pilot:publish-results` reports a
missing field or an unknown dropdown option, the name does not match this document —
fix the ClickUp side rather than loosening the publish step.

## What you are signing up for

**Retention is manual.** ClickUp's API has no delete-attachment endpoint, and case tasks
must persist because the status lifecycle lives on them — so traces accumulate at roughly
1–5 MB per case per run and are pruned by hand from task attachment lists. Budget a
quarterly pass: oldest passing runs first, keep every failure. Nobody re-opens a passing
trace once QA has approved it.

Storage is 60 MB on Free and unlimited on paid plans, but the usage meter exists **only**
on Free — a paid workspace cannot see its own consumption, so the prune is on your
calendar, not on a warning.
