# ClickUp setup

QA-Pilot does not create your ClickUp structure. You build it once, by hand, from the list
below. `/qa-pilot:publish-results` writes into it and fails on anything missing, and **the
plugin matches on names, not IDs**, so get the names right. Fifteen minutes, once per
workspace.

Not using ClickUp? Set `tracker: none` in the profile and skip this document: approvals live
in `testing/<feature>/statuses.json`, evidence stays on the executor's machine, and bugs are
markdown files in each run's directory.

## 1. Space

Use a Space for QA work, and inside it a **Folder dedicated to the automated pipeline**, with
**one List per feature**. Case tasks live in the feature's List.

Record both in `qa-pilot.config.yaml` as `clickup.space` and `clickup.folder`. Put the
statuses and custom fields below on the **folder**, not the space, so existing manual QA lists
stay untouched.

## 2. Custom statuses

Right-click the folder, choose **Task statuses**, and switch to custom statuses.

**The names below are only defaults.** If your workspace already has QA statuses, keep your
wording and record the mapping in the profile's `clickup.statuses`. The pipeline needs seven
*distinct* states, including a way to express **approval** of both a case's design and its
verdict: a board with only `pass` and `fail` records verdicts and still needs approval states.

| Group | Statuses |
|---|---|
| Active | `Case Review`, `Approved for Execution`, `Under Review`, `Retest`, `Quarantined`, `Rejected` |
| Closed | `Approved` |

ClickUp requires at least one Closed status, and `Approved` is the only finished state. The
grouping does not affect behaviour, since statuses are read by name.

**Gotcha:** ClickUp refuses a folder status whose name the parent space already uses ("Status
name is already taken"). If your space has `to do`, pick another name for `case_review` and
record it in `clickup.statuses`.

## 3. Custom fields

Right-click the folder, choose **Custom Fields**, and create these. Names and dropdown
options must match exactly: `P0` is not `p0`.

| Field | Type | Options |
|---|---|---|
| Verdict | Dropdown | `pass`, `fail`, `flaky`, `blocked` |
| Priority | Dropdown | `P0`, `P1`, `P2` |
| Type | Dropdown | `happy`, `negative`, `edge`, `permission`, `data-validation` |
| Build SHA | Text | none |
| Env | Dropdown | one option per environment in your profile (e.g. `qa`, `staging`) |
| API Mode | Dropdown | `server`, plus your sandbox value (e.g. `mocks`) |
| App | Dropdown | one option per app declared in your profile |
| Executor | Text | none |
| Run Date | Date | none |
| Flake Count | Number | none |
| Model Version | Text | none |
| Run ID | Text | none; needed by default, see below |
| Trace Path | Text | none; same |
| Trace SHA256 | Text | none; same |

Env, API Mode and App take their options from your `qa-pilot.config.yaml`, so create them
after `/qa-pilot:qa-init` has written it.

Run ID, Trace Path and Trace SHA256 are needed by default, because the default
`evidence_upload` records where the trace is and its hash instead of attaching it. Only a host
that opts every environment in to `tracker` can skip them.

There is no Trace field: under `tracker` the trace is an **attachment** on the case task, and
under `reference` and `local` nothing is attached. There is no Bug field either. A confirmed
defect becomes its own task, linked to the case with a native ClickUp relationship; point
`clickup.bug_list` at the list your developers work from.

## 4. Two settings that matter

**Turn on Private Attachment Links.** Settings → Advanced Permissions. Available on every
plan and **off by default**; without it every attachment URL is public, unauthenticated and
non-expiring. Under the default `evidence_upload: reference` nothing is attached, so this
protects nothing until you opt an environment in to `tracker`, but turn it on first anyway.

**Give each developer their own API token.** The rate limit is 100 requests per minute **per
token** on Free through Business (1,000 on Business Plus, 10,000 on Enterprise). A shared
token means five developers exhaust one budget and 429 each other mid-publish. Per-user
tokens also keep the `Executor` field truthful.

### What a trace contains

A Playwright trace is a full recording of the session. It carries:

- **The session credential**: the `Authorization` header, the session cookie, the Firebase ID
  token in local storage. Requests and storage snapshots are both recorded, so the token is
  in there more than once.
- Every request and response body the run touched, including personal data in fixtures.
- DOM snapshots of every page state, so anything rendered on screen is in the file.
- The video, byte for byte, and the console output.

A trace can also hold a long-lived refresh token, so a leaked trace can keep minting sessions
for that account long after the run. The account the runs use must be restricted: its own
tenant, no admin rights, no billing, nothing it could not safely lose. If a trace leaks,
disable that account or rotate its credentials; deleting the attachment does not un-leak it.
[Production](https://sandeeptakasi.github.io/qa-pilot/docs/production/) has the full reasoning.

**Where traces go** is the environment's `evidence_upload` (`tracker`, `reference` or
`local`), described in the [profile schema](./schemas/qa-pilot.config.schema.md). Off
production the default is `reference`: nothing is attached. Opt an environment in to `tracker`
only after turning on Private Attachment Links and giving the runs a restricted account. A
production environment keeps its traces on the executor's machine, and its case task receives
only verdict, environment, build, run ID, and trace path and sha256.

Reviewers verify a kept trace against its sha256 and open it with
`npx playwright show-trace <path>`. Under `tracker`, `show-trace <url>` fails against ClickUp
URLs because it sends no auth header, so download the trace first.

## 5. Check it before the pilot

Run one feature end to end on a throwaway List. If `/qa-pilot:publish-results` reports a
missing field or an unknown dropdown option, the name does not match this document. Fix the
ClickUp side rather than loosening the publish step.

## What you are signing up for

**Retention is manual for environments on `tracker`.** ClickUp's API has no delete-attachment
endpoint and case tasks must persist, so uploaded traces accumulate at roughly 1 to 5 MB per
case per run and are pruned by hand from task attachment lists. Budget a quarterly pass:
oldest passing runs first, keep every failure.

Storage is 60 MB on Free and unlimited on paid plans, but the usage meter exists only on
Free, so on a paid workspace the prune is on your calendar, not on a warning.
