# QA-Pilot

Evidence-first feature testing for Claude Code. Any developer can generate and execute feature tests in their own session; every executed case produces the same report structure with mandatory evidence; QA reviews instead of executing; ClickUp, or local files when you run without a tracker, holds one live view of testing confidence per feature.

The design rests on two ideas. **Uniformity is enforced by tooling, not discipline**, because anything that depends on five people remembering a convention during crunch fails inside a week. And **the committed Playwright spec is the durable asset**: agentic sessions are scaffolding that authors and triages; the spec is what runs today for evidence and, once QA approves it, unattended in CI ([SETUP-CI.md](./SETUP-CI.md)).

## The pipeline

```
/qa-init          →  discover the host repo, write qa-pilot.config.yaml   (once per project)
/setup-profiles   →  log in once per account, save the session            (once per developer)
/generate-tests   →  author cases.yaml, create ClickUp tasks              (per feature)
      ↓  QA approves the scenario matrix, the write policy and the cases
/run-tests        →  committed specs run against a deployed env, with evidence,
                     under a write guard when the feature may not write freely
/publish-results  →  validate, then write verdicts and evidence to ClickUp
/qa-review        →  QA's queue: approve, reject with a reason, or retest,
                     and file a linked bug for every confirmed defect
```

## What it refuses to publish

The publish step is a script, not a judgement call, and it rejects each of these outright. QA never has to police any of it.

- **A verdict without evidence.** Every executed case needs a Playwright trace and a deploy SHA read from the running environment. Missing, empty, or unreadable artifacts fail the report.
- **A verdict from a local or sandbox environment.** Mock backends are seeded and always succeed. Runs against them are useful for stabilizing specs and are stamped as such, but they cannot carry a verdict.
- **A pass that was really a retry.** Pass-on-retry is recorded `flaky`, always, derived from the attempt results rather than from Playwright's own status field, so no config change can turn it green. A failure in any browser is a failure, never a flake.
- **A verdict for a case QA never approved.** Checked against the case's recorded ClickUp status at the time of the run, not against the case map: every generated case is in the map from the moment it is created, so map membership proves nothing about approval.
- **A run that lost its ground truth.** If the deployed build changes mid-run, every case is `blocked`, because half tested one build and half another. Past 10% blocked the run halts: the environment failed, not the feature.
- **A run that broke its write policy.** Each feature declares whether its specs may write (`read-only`, `scoped-write` with a name prefix, or `unrestricted`). The write guard records every write control and write request it saw, and a read-only run that recorded one, or a run whose guard never reported in, does not publish. The gate re-reads those records and the Playwright report from disk rather than trusting the report it is handed.

## Production

An environment says what it is: `kind: qa | staging | production`, declared rather than guessed from the hostname. Production is allowed, under rules that are refusals, not advice:

- **Evidence stays local.** Traces carry the session and every request body they touched, so a production trace is never attached to the tracker, never uploaded by CI, and never committed (`/run-tests` refuses unless the run directory is gitignored). The tracker record carries no application data: case IDs, verdicts, build, run, and each trace's path and sha256 so a reviewer can find and verify it on the executor's machine.
- **Full capture.** Every case keeps a trace.
- **A declared write policy and a live guard.** A production feature must be `read-only` or `scoped-write`, and the host profile must say what a write looks like on that host (`mutation.write_signatures`). The guard works without the specs' cooperation: clicks are judged in the page before the app sees them, requests at the network layer.

What the gate cannot verify, it says: the environment name in a report is taken on trust, like the deploy SHA, and the guard's ceilings are listed in its source.

### How strong these gates actually are

Worth being precise, because "impossible" would be overselling it. The checks above are deterministic scripts, so a rushed developer cannot skip them by accident, and that is the failure mode this system is built for. What they verify is that a report is internally consistent and that its evidence exists on disk. They do not cryptographically bind a report to a Playwright run that actually happened.

So someone determined to fabricate a green result could hand-write the inputs. Nothing here stops that, and the honest framing is that QA-Pilot makes the evidenced path the path of least resistance rather than the only conceivable one. The backstop for deliberate fabrication is QA's sampling: watching 100% of P0 evidence and every failure. A fake trace does not survive being opened.

An agentic browser session is a good example of the same idea. It cannot produce a trace or a machine-readable result, so it has nothing to publish with, and "Claude clicked through it and it looked fine" never reaches the record by the normal route. That is a strong practical barrier, not a mathematical one.

## Evidence

One artifact per case per run: **`trace.zip`, attached to the case's ClickUp task**, or kept on the executor's machine for production and any environment set to `evidence_upload: local`. A trace carries the video byte-for-byte, the console output, the screenshot film-strip, DOM snapshots and the network log, so it replaces uploading a video and a console log separately, which would store the same bytes twice and split one investigation across three files.

Reviewers drag it onto <https://trace.playwright.dev>, which runs entirely in the browser and transmits nothing. No second storage system, no extra credentials, and the evidence sits on the task the reviewer is already looking at.

Without ClickUp, set `tracker: none` in the profile: approvals live in `testing/<feature>/statuses.json`, all evidence stays local, and bugs are markdown files in the run directory.

With ClickUp, you set up its side once, by hand. The plugin writes into it but does not create it. [SETUP-CLICKUP.md](./SETUP-CLICKUP.md) is the exact checklist: the statuses, the custom fields and their options, and the two settings that matter (**Private Attachment Links**, off by default and leaving attachment URLs public; and a **per-developer API token**, since the 100 requests/minute budget is per token, not per person). Fifteen minutes, once per workspace. `/qa-init` reminds you and fills in the host-specific dropdown values.

Retention is manual, because ClickUp has no delete-attachment endpoint, so traces are pruned from task attachment lists by hand. Budget a quarterly pass: oldest passing runs first, keep every failure.

## Portability

The plugin ships generic. Everything project-specific (environment URLs, auth mechanics, selector policy, assertion constraints, evidence requirements, propagation windows) lives in `qa-pilot.config.yaml`, committed in the consuming repo and owned by QA. Onboarding a second project is one `/qa-init` run and a profile review, with no plugin-code changes.

## Install

```bash
claude plugin marketplace add https://github.com/SandeepTakasi/qa-pilot
claude plugin install qa-pilot
```

Or for local development: `claude --plugin-dir /path/to/QAED/qa-pilot`.

Requires Node ≥ 20 (scripts are zero-dependency ESM) and, in the host repo, Playwright >= 1.51, because `storageState({ indexedDB: true })` landed there and IndexedDB-persisted auth such as Firebase silently fails to restore below it.

## Model fitting

| Stage | Model |
|---|---|
| `generate-tests` | **The strongest available.** Case design is the only stage where model judgment decides quality, and the 25-case cap makes it cheap. The host profile's `models.generation_approved` gates this: cases stamped with an unapproved model are rejected by the validator, so a model upgrade cannot quietly change what the suite tests. |
| `run-tests` | Sonnet-class for ordinary spec authoring; reach higher for cross-app multi-context specs and stubborn flake triage. |
| everything else | Any current model. Discovery, mechanical writes, and presentation. |

Execution itself costs no tokens: it is `npx playwright test`.

## Layout

```
skills/            the five entry points plus setup-profiles
scripts/           deterministic validators and transforms (zero deps, node --test)
schemas/           the host profile, case, and report contracts
hooks/             ClickUp write guard, so the scripted path is the only write path,
                   active only in repos that have a host profile
SETUP-CLICKUP.md   one-time workspace setup you do by hand
DECISIONS.md       what this plugin enforces on a host, and what swapping it would cost
SETUP-CI.md        running the approved suite unattended, and what CI cannot do
templates/         the write guard (write-guard.mjs, write-guard.fixture.ts) and a
                   GitHub Actions workflow, to copy into a host repo
CHANGELOG.md       what changed, and what to do when upgrading
THIRD_PARTY_NOTICES.md  licence of the one bundled dependency
```

[DECISIONS.md](./DECISIONS.md) is worth reading before adopting this anywhere new. Short version: Playwright is a deliberate hard dependency because the trace *is* the evidence model, while ClickUp is surface-level, since no script ever calls it and swapping trackers is mostly prose.

The only third-party code is `scripts/lib/yaml.mjs`, a bundled copy of [yaml](https://github.com/eemeli/yaml) 2.9.0, under the ISC licence; its text is in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Node ships no YAML parser, the host profile is hand-edited by QA and needs comments (so JSON is out), and bundling keeps consuming repos install-free.

## Development

```bash
node --test qa-pilot/scripts/tests/*.test.mjs
claude plugin validate ./qa-pilot
```

Leave the glob unquoted, so the shell expands it: `node --test` only expands a quoted glob itself from Node 21, and handed a directory instead it reports a spurious failing "test" on Node 22.
