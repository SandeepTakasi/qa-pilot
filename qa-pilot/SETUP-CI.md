# Running the approved suite in CI

Specs accumulate as a side effect of normal QA work. Running them unattended is what turns
that pile into regression coverage, and it is the one step that keeps paying after the
feature ships.

Copy `templates/qa-pilot-ci.yml` into `.github/workflows/`, edit the lines marked `EDIT`,
and read the four prerequisites below before you expect it to go green. On another CI
system the same steps port directly; nothing here is GitHub-specific except the YAML.

## What the CI job does, and what it deliberately does not

It runs the specs QA approved, against a deployed environment, and fails the build when
one of them stops passing. It uploads the run directory (`report.json`, the Playwright
results and the traces) as build artifacts, unless the environment keeps its evidence local.

**It never runs against production.** The job reads the environment's `kind` from the
profile and stops if it is `production`. Build artifacts leave the machine, and a production
trace carries a live session and every request body it touched; production runs are made by
a person, with evidence kept on their machine (see `/qa-pilot:run-tests`).

**It does not publish to ClickUp.** Publishing runs through the approval gate over MCP and
writes to the tracker as a person, and a build runner is neither. Adding a second write
path, with a CI token and its own copy of the rules, would mean two things to keep honest
instead of one. When a CI regression needs to be in ClickUp, download the run directory from
the build artifacts and run `/qa-pilot:publish-results` against it. That route exists only
where the environment uploads evidence: under `tracker: none`, or on an environment set to
`evidence_upload: local`, there is no artifact (see "Evidence in CI").

**It does not need ClickUp at all.** `testing/<feature>/approved.json` is committed. It
names every case QA accepted and the hash of the spec they accepted, so CI can answer
"what did QA approve, and is this still that spec" from the repo alone. No token, no
network call to the tracker, nothing to expire.

## This is not a pull request check

Point it at a deploy, or a schedule. Not at pull requests.

A PR-triggered run tests whatever happens to be deployed to the shared QA environment,
which is not the PR's code. The result would be red or green for reasons unconnected to
the change under review, which is worse than no signal: people learn to ignore it, and
then ignore it on the day it was right.

Run it after a deploy to QA, and nightly. If your setup gives each PR its own preview
deployment, that is a genuine per-PR environment: register it in the profile and point the
job at it.

## Prerequisite 1: a non-interactive login

This is the real work, and it is the reason CI is a step beyond running locally.

`/qa-pilot:setup-profiles` hands a headed browser to a human who signs in once. CI has no
human and no interactive terminal, so that path cannot run there. The job needs its own
login step that writes the same storage state file the specs already load.

Roughly fifteen lines, written once, host-specific because every login form is:

```js
// scripts/ci-login.mjs
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${process.env.QA_URL}/login`);
await page.getByTestId('email').fill(process.env.QA_USER);
await page.getByTestId('password').fill(process.env.QA_PASSWORD);
await page.getByTestId('submit').click();
await page.waitForURL('**/dashboard');          // wait for the app, not for the network
await page.context().storageState({
  path: '.playwright/profiles/member.json',
  indexedDB: true,                              // Firebase-style auth lives here
});
await browser.close();
```

`indexedDB: true` matters as much here as it does locally: without it a Firebase session
saves as an empty-looking profile and every spec fails at the first authenticated page.

**Use a dedicated, low-privilege test account.** Its credentials go in CI secrets, and its
session ends up inside every trace the job uploads. Never a real user's account, never an
admin, and never production. See "What a trace contains" in `SETUP-CLICKUP.md`.

## Prerequisite 2: the runner has to reach the environment

The job reads the deploy SHA from the environment and drives a browser against it. If your
QA environment sits behind a VPN or an IP allowlist, a hosted runner cannot see it, and
every case comes back `blocked`. Either allowlist the runner or use a self-hosted one
inside the network.

The blocked-ratio rule turns that into a clear message rather than a wall of failures: over
10% blocked reports the environment failed, not the feature.

## Prerequisite 3: the specs and ledgers are in the checkout

CI reads `testing/<feature>/approved.json`, `testing/<feature>/specs.json` and the spec
files themselves out of the checkout. There is no other source, and that is exactly what
lets the job run without a ClickUp token.

So this is the one part of QA-Pilot with a hard requirement about your repository. Running
in local-only mode, where the specs and `testing/` are gitignored, is a legitimate way to
use the rest of the pipeline, and CI is simply not available in that mode: the files exist
on the machine that wrote them and nowhere else. The job fails at selection with "no
approved spec is runnable", which is the correct outcome and a puzzling one if `.gitignore`
is not the first place you look.

If you want CI, commit the spec directory and `testing/`, and ignore `testing/*/runs/` to
keep the bulky per-run artifacts out.

## Prerequisite 4: something has to be approved first

`ci-gate.mjs select` refuses when no approved spec is runnable, and the job fails rather
than reporting green having run nothing. That is deliberate: a suite that passes because it
executed zero tests is the most expensive kind of false confidence.

So the CI job only becomes useful after a feature has been through the full loop once:
generate, run, publish, review. Add the workflow when you have your first approved feature,
not on day one.

## What a red build means

| Message | What happened | Who acts |
|---|---|---|
| `REGRESSION` | a case QA approved as passing now fails | the team that owns the feature |
| `ENVIRONMENT FAILED` | over 10% blocked, or the build changed mid-run | whoever owns the environment |
| `REFUSED: no approved spec is runnable` | nothing is approved, or every spec drifted | QA, via `/qa-pilot:qa-review` |

A `flaky` case fails the build. Pass-on-retry is never a pass anywhere else in this
pipeline, and letting CI be the one place it goes green makes CI the place people go for a
friendlier answer.

## Specs that changed since approval are skipped, not run

`select` re-hashes each spec and compares it to the hash in `approved.json`. A spec that no
longer matches is excluded, with its case ID and both hashes printed.

It may well be a better spec. Nobody has reviewed it, and a green CI run against an
unreviewed spec claims a human stands behind something no human has read. Publish a run and
have QA review it; the approval then carries forward on its own.

If you see this on every case at once, someone reformatted the spec directory. Re-review
once and it settles.

## Choosing what runs

By default the job runs every approved spec for the feature. A deploy job usually wants less:
the cases that must never break, quickly. The template's `PRIORITY` setting does that.

```yaml
env:
  PRIORITY: ''      # EDIT: P0 on a deploy-triggered job; empty runs everything approved
```

When `PRIORITY` is non-empty the select step adds
`--cases testing/$FEATURE/cases.yaml --priority $PRIORITY`. Priority is not recorded in
`approved.json` or `specs.json`, only in `cases.yaml`, which is why the filter needs that file.
The call is:

```
node ci-gate.mjs select --approved <approved.json> --specs <specs.json> \
  [--cases <cases.yaml>] [--priority <P0[,P1[,P2]]>] [--json]
```

The rules, in full:

- `--priority` without `--cases` is an error. `--cases` without `--priority` is accepted and
  changes nothing.
- Values are case-sensitive and comma-separated, each one trimmed: `P0,P1` and `P0, P1` mean
  the same, `p0` is not `P0`. An unknown value is an error that names it.
- Filtering happens first. An approved case outside the filter is dropped silently, with no
  skip line and nothing on stderr, because leaving it out is the job's intent and not a problem.
- An approved case that is missing from the cases file is skipped, with the reason
  `not in cases.yaml, so its priority is unknown`.
- The usual hash check then runs on whatever remains, so a drifted spec is still skipped and
  still printed with both hashes.
- If nothing is runnable at that priority, `select` exits 1 with
  `REFUSED: no approved spec at priority <list> is runnable, so this job would report green having proved nothing.`
  A P0 job that finds no P0 spec fails; it never goes green having run nothing.

**Recommended split: P0 on every deploy, everything on the nightly schedule.** A deploy needs
a fast answer about the cases that matter most, and the nightly run is where the slower P1 and
P2 cases are allowed to take their time. Because one template serves both, copy the workflow
twice or use two jobs: set `PRIORITY: P0` on the deploy-triggered one and leave it empty on the
scheduled one. Cases carry their priority in `cases.yaml`, so promoting a case to P0 moves it
into the deploy job with no change to the workflow.

## Each run has its own directory

Everything a run produces goes under `testing/<feature>/runs/<run_id>/`, as it does locally:
`meta.json`, the Playwright JSON report as `results.json` (the job sets
`PLAYWRIGHT_JSON_OUTPUT_NAME` to it, as an absolute path, because Playwright resolves that name
against the config file's directory), the per-test output and traces under `test-results/`
(`--output`), shared fixture identities under `fixtures/` (`QA_PILOT_FIXTURE_DIR`; the job also
exports `QA_PILOT_FEATURE`, which your config's fixture projects use to run only this feature's
fixtures, see `/qa-pilot:run-tests`), and the
`report.json` that `parse-report.mjs` writes there by default. Two runs never overwrite each
other's evidence, and the publish gate finds everything it re-reads relative to that one
directory.

## The write guard in CI

The job exports the feature's declared mutation policy from `testing/<feature>/cases.yaml` as
`QA_PILOT_MUTATION`, after linting the file, and the profile's `mutation` block as
`QA_PILOT_MUTATION_CONFIG`. Specs that import `test` from `write-guard.fixture.ts` then run
under the same guard as they do locally, and each attempt leaves its `writes.json` beside its
trace. A feature with no `mutation` block runs `unrestricted`, as in 0.2.0; one whose policy
cannot be read fails the step rather than running unguarded.

## Evidence in CI

**Under `tracker: none` the job uploads no artifact at all.** Without a tracker every
environment's effective `evidence_upload` is `local`, so the upload step is skipped and the
run directory stays on the runner, discarded with it. The red or green build is the whole
result; a team that wants to keep a CI run's evidence runs the same specs on a machine of its
own with `/qa-pilot:run-tests`.

The job reads `evidence.capture` from the profile and passes the matching `--trace` mode to
Playwright (`always` keeps a trace for every test, `on-failure` only for failures), and it
records that mode in `meta.json`, so the report claims exactly what the run kept. For a
regression job `on-failure` is a reasonable profile choice: nobody samples CI passes, and
failures still carry a full trace.

Playwright has no command-line flag for video, so the job cannot set it. **Make your config's
`use.video` match the profile's capture mode** (`retain-on-failure` under `on-failure`, `on`
under `always`), as `/qa-pilot:run-tests` describes; otherwise every passing test still records
and keeps a video, which throws away most of what `on-failure` saves.

Traces upload as build artifacts with a 14-day retention, and only when the environment's
effective `evidence_upload` is `tracker`. They contain the test account's session token, so
treat the artifacts as credentials and keep the retention short. An environment that keeps
evidence local uploads nothing.

## Pin the plugin

The workflow checks QA-Pilot out at a ref. Pin a tag or a commit SHA rather than a branch.
An unpinned ref means a change to QA-Pilot can turn your build red overnight with nothing
in your own repository's history to explain it.

The template pins `ref: v0.4.0`. **`--priority` needs 0.4.0 or newer.** An older `ci-gate.mjs`
only reads the flags it knows, so below 0.4.0 it silently ignores `--priority` and runs every
approved spec: the job looks like a P0 job and is not. Keep the pin at 0.4.0 or later for any
job that sets `PRIORITY`.
