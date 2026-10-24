# QA-Pilot

Evidence-first feature testing for Claude Code. Any developer can generate and execute feature tests in their own session; every executed case produces the same report structure with mandatory evidence; QA reviews instead of executing; ClickUp, or local files when you run without a tracker, holds one live view of testing confidence per feature.

The design rests on two ideas. **Uniformity is enforced by tooling, not discipline**, because a convention that depends on five people remembering it during crunch does not last. And **the committed Playwright spec is the durable asset**: agentic sessions author and triage; the spec is what runs for evidence and, once QA approves it, unattended in CI ([SETUP-CI.md](./SETUP-CI.md)).

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

The publish step is a script, not a judgement call, and it rejects each of these.

- **A verdict without evidence.** Every executed case needs a Playwright trace and a deploy SHA read from the running environment.
- **A verdict from a local or sandbox environment.** Mock backends always succeed, so those runs can stabilize specs but cannot carry a verdict.
- **A pass that was really a retry.** Pass-on-retry is recorded `flaky`, derived from the attempt results rather than Playwright's own status field. A failure in any browser is a failure, not a flake.
- **A verdict for a case QA never approved.** Checked against the case's recorded status at run time, not the case map, which holds every generated case.
- **A run that lost its ground truth.** If the deployed build changes mid-run, every case is `blocked`. Past 10% blocked the run halts: the environment failed, not the feature.
- **A run that was not a verdict run.** Stabilization and CI runs say so in their metadata, and a run Playwright reported an error outside any test for (a failed global setup, a timeout) is incomplete.
- **A run that broke its write policy.** Each feature declares `read-only`, `scoped-write` (with a name prefix) or `unrestricted`. A read-only run whose write guard recorded a write, or never reported in, does not publish. The gate re-reads the guard's records and the Playwright report from disk rather than trusting the report it is handed.

## Production

An environment says what it is: `kind: qa | staging | production`, declared rather than guessed from the hostname. Production is allowed, under rules that are refusals, not advice:

- **A restricted account.** A production environment must declare `test_account`, naming the account the runs sign in as and how it is restricted. Without it the whole profile is invalid. It is an attestation nothing verifies.
- **Evidence stays local.** A production trace is never attached to the tracker, uploaded by CI or committed (`/run-tests` refuses unless the run directory is gitignored). The tracker record carries no application data: case IDs, verdicts, build, run, and each trace's path and sha256, so a reviewer can find and verify it on the executor's machine.
- **Full capture.** Every case keeps a trace.
- **A declared write policy and a live guard.** A production feature must be `read-only` or `scoped-write`, and the profile must say what a write looks like on that host (`mutation.write_signatures`). Clicks are judged in the page before the app sees them, requests at the network layer. The guard is a second layer under the restricted account, not the boundary.

The reasoning and each rule's enforcement point are in [the production page](https://sandeeptakasi.github.io/qa-pilot/docs/production/).

### How strong these gates actually are

Worth being precise, because "impossible" would be overselling it. The checks above are deterministic scripts, so a rushed developer cannot skip them by accident, and that is the failure mode this system is built for. What they verify is that a report is internally consistent and that its evidence exists on disk. They do not cryptographically bind a report to a Playwright run that actually happened.

So someone determined to fabricate a green result could hand-write the inputs, and nothing here stops that. QA-Pilot makes the evidenced path the path of least resistance, not the only conceivable one. Sampling does not close that gap: it has QA open a share of passing evidence (all P0, at least 30% of P1, 10% of P2) and every failure, which checks that what is recorded shows what the case claims. A pass that rests on a weak assertion looks green in its trace, which is why specs are linted for missing assertions, fixed sleeps and skipped tests, and QA reviews each case's expected outcomes before it runs.

An agentic browser session has no trace or machine-readable result to publish with, so "Claude clicked through it and it looked fine" does not reach the record by the normal route. That is a practical barrier, not a mathematical one. What the gate cannot verify (such as the environment name in a report, which is taken on trust like the deploy SHA) is listed in [the production page](https://sandeeptakasi.github.io/qa-pilot/docs/production/).

## Evidence

One artifact per case per run: **`trace.zip`**, carrying the video, console output, DOM snapshots and network log in one file.

Where it goes is the environment's `evidence_upload`: `reference` (the default off production: the tracker gets the usual fields plus the trace's path and sha256, and the trace stays on the machine that ran it), `tracker` (opt-in: attached to the case's ClickUp task) or `local` (production and `tracker: none`: no application data leaves the machine). The rules are in the [host profile schema](./schemas/qa-pilot.config.schema.md); why a trace is a credential is in [the production page](https://sandeeptakasi.github.io/qa-pilot/docs/production/). Reviewers verify a kept trace by its sha256 and open it with `npx playwright show-trace <path>`.

Without ClickUp, set `tracker: none` and everything stays in local files. With ClickUp, you set up its side once, by hand, from the checklist in [SETUP-CLICKUP.md](./SETUP-CLICKUP.md); the plugin writes into it but does not create it.

## Portability

The plugin ships generic. Everything project-specific (environment URLs, auth mechanics, selector policy, assertion constraints, evidence requirements, propagation windows) lives in `qa-pilot.config.yaml`, committed in the consuming repo and owned by QA. A second project needs no plugin-code changes; its profile, including its write signatures, is the work.

## Install

```bash
claude plugin marketplace add https://github.com/SandeepTakasi/qa-pilot
claude plugin install qa-pilot
```

Or for local development: `claude --plugin-dir /path/to/QAED/qa-pilot`.

Requires Node ≥ 20 (scripts are zero-dependency ESM) and, in the host repo, Playwright >= 1.51, because `storageState({ indexedDB: true })` landed there and IndexedDB-persisted auth such as Firebase fails to restore below it.

## Model fitting

Use the strongest available model for `generate-tests`, where model judgment decides quality; the profile's `models.generation_approved` lists approved models, and a case stamped with another gets a validator warning, not an error. `run-tests` is fine on a Sonnet-class model, with a stronger one for cross-app specs and stubborn flake triage. Anything else takes any current model. Execution itself costs no tokens: it is `npx playwright test`.

## Layout

```
skills/            the five entry points plus setup-profiles
scripts/           deterministic validators and transforms (zero deps, node --test)
schemas/           the host profile, case, and report contracts
hooks/             ClickUp write guard: QA-Pilot's own case tasks change only through
                   its skills; every other ClickUp write passes
SETUP-CLICKUP.md   one-time workspace setup you do by hand
DECISIONS.md       what this plugin enforces on a host, and what swapping it would cost
SETUP-CI.md        running the approved suite unattended, and what CI cannot do
templates/         the write guard (write-guard.mjs, write-guard.fixture.ts), a GitHub
                   Actions workflow and the spec lint config (eslint.qa-pilot.config.mjs),
                   to copy into a host repo
CHANGELOG.md       what changed, and what to do when upgrading
THIRD_PARTY_NOTICES.md  licence of the one bundled dependency
```

[DECISIONS.md](./DECISIONS.md) is worth reading before adopting this anywhere new. Short version: Playwright is a deliberate hard dependency because the trace *is* the evidence model, while ClickUp is surface-level, since no script calls it and swapping trackers is mostly prose.

The only third-party code is `scripts/lib/yaml.mjs`, a bundled copy of [yaml](https://github.com/eemeli/yaml) 2.9.0 under the ISC licence ([THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)).

## Development

```bash
node --test qa-pilot/scripts/tests/*.test.mjs
claude plugin validate ./qa-pilot
```

Leave the glob unquoted, so the shell expands it: `node --test` only expands a quoted glob itself from Node 21, and handed a directory instead it reports a spurious failing "test" on Node 22.
