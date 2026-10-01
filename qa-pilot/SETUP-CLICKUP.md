# ClickUp setup

QA-Pilot does not create your ClickUp structure. You do, once, by hand. This is the exact
list. `/qa-pilot:publish-results` writes into what you build here, and it fails on anything
missing, so get the names right: **the plugin matches on names, not IDs.**

Fifteen minutes, once per workspace.

Not using ClickUp? Set `tracker: none` in the profile and skip this document: approvals live
in `testing/<feature>/statuses.json`, evidence stays on the executor's machine, and bugs are
markdown files in each run's directory.

## 1. Space

Use a Space for QA work, and inside it create a **Folder dedicated to the automated
pipeline**, with **one List per feature**. Case tasks live in the feature's List.

Record both in `qa-pilot.config.yaml` as `clickup.space` and `clickup.folder`. Name the
folder, because a space usually holds several and "the feature's list in space X" is
otherwise ambiguous enough to create 25 case tasks beside somebody's manual QA work.

Put the statuses and custom fields below on the **folder**, not the space. Everything
inside inherits them, and existing manual QA lists elsewhere in the space stay untouched.

## 2. Custom statuses

Right-click the folder, choose **Task statuses**, and switch to custom statuses.

**The names below are only defaults.** If your workspace already has QA statuses, keep your own wording and record the mapping in the profile's `clickup.statuses` instead. What the pipeline needs is seven *distinct* states, not seven particular words. What it cannot work without is a way to express **approval**, both of a case's design and of its verdict, so a board that only has `pass` and `fail` is recording verdicts and still needs approval states added.

| Group | Statuses |
|---|---|
| Active | `Case Review`, `Approved for Execution`, `Under Review`, `Retest`, `Quarantined`, `Rejected` |
| Closed | `Approved` |

ClickUp requires at least one Closed status, and `Approved` is the only genuinely finished
state, so it goes there. Closed statuses are hidden from default views, which turns out to
be what you want: an approved case reappears by itself when the next build re-runs it and
moves it back to `Under Review`. The pipeline reads statuses by name through the API, so
the grouping never affects behaviour.

**Gotcha:** ClickUp refuses a folder status whose name is already used by the parent space
("Status name is already taken"). If your space already has `to do`, pick something else
for `case_review` and record the name you chose in `clickup.statuses`.

## 3. Custom fields

Right-click the folder, choose **Custom Fields**, and create these. Names must match
exactly, and so must dropdown options: `P0` is not `p0`.

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
| Run ID | Text | none; only needed if any environment keeps evidence local |
| Trace Path | Text | none; same |
| Trace SHA256 | Text | none; same |

The three host-specific dropdowns (Env, API Mode, App) take their options from your
`qa-pilot.config.yaml`, so create them after `/qa-pilot:qa-init` has written it.

The last three fields are what a run whose evidence stays local writes instead of attaching
a trace: every production environment keeps its evidence local, and any other environment
can choose to (`evidence_upload: local`). A reviewer uses the path and the hash to find the
trace on the executor's machine and verify it. A host that never keeps evidence local can
skip them.

There is no Trace field. Traces are **attachments** on the case task, not a field value,
for environments that upload evidence.

There is no Bug field either. A confirmed defect becomes its own task, linked to the case
with a native ClickUp task relationship, so there is nothing to create here for it. Point
`clickup.bug_list` in your profile at the list your developers already work from.

## 4. Two settings that matter

**Turn on Private Attachment Links.** Settings → Advanced Permissions. Available on every
plan, **off by default**. Without it, every attachment URL is public, unauthenticated and
non-expiring, secured by an unguessable string alone. That matters more than it sounds,
because of what is actually inside a trace.

### What a trace contains

A Playwright trace is a full recording of the session, not a screenshot of it. Every trace
carries:

- **The session credential.** Whatever authenticated the run: the `Authorization` header,
  the session cookie, the Firebase ID token in local storage. Network requests and storage
  snapshots are both recorded, so the token is in there in more than one place.
- Every request and response body the run touched, including any personal data in the
  fixtures.
- DOM snapshots of every page state, so anything rendered on screen is in the file.
- The video, byte for byte, and the console output.

Two things follow.

**Treat an attachment link as the credential itself.** Anyone holding the URL holds the
session that ran the test. Private Attachment Links is what makes this a link your team
can hold rather than one anybody can. Turn it on before the first publish, not after.

**Use short-lived, low-privilege test accounts.** The right fix is that a leaked trace
leaks a token that expires and could not do much anyway. Never run QA-Pilot as an admin
account.

**Production evidence never reaches ClickUp.** An environment declared `kind: production`
keeps its traces on the executor's machine: uploading them is refused by the profile
validator, the publish step attaches nothing, and the case task receives only the verdict,
the environment, the build, the run ID, and the trace's run-relative path and sha256. No
failure text, no console output, no URL, no executor. QA reviews production traces on the
executor's machine, or wherever the host chooses outside the tracker. Every other
environment uploads traces by default, and any can opt out with `evidence_upload: local`.

Consequence to know: `npx playwright show-trace <url>` stops working against ClickUp URLs
because it sends no auth header. Reviewers download the trace first, then open it.

**Give each developer their own API token.** The rate limit is 100 requests per minute
**per token** on Free through Business (1,000 on Business Plus, 10,000 on Enterprise). One
shared token means five developers exhaust one budget between them and 429 each other
mid-publish. Per-user tokens also make the `Executor` field truthful without anyone
maintaining it.

## 5. Check it before the pilot

Run one feature end to end on a throwaway List. If `/qa-pilot:publish-results` reports a
missing field or an unknown dropdown option, the name does not match this document.
Fix the ClickUp side rather than loosening the publish step.

## What you are signing up for

**Retention is manual.** ClickUp's API has no delete-attachment endpoint, and case tasks
must persist because the status lifecycle lives on them, so traces accumulate at roughly
1 to 5 MB per case per run and are pruned by hand from task attachment lists. Budget a
quarterly pass: oldest passing runs first, keep every failure. Nobody re-opens a passing
trace once QA has approved it.

Storage is 60 MB on Free and unlimited on paid plans, but the usage meter exists **only**
on Free. A paid workspace cannot see its own consumption, so the prune is on your
calendar, not on a warning.
