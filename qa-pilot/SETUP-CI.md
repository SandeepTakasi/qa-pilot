# Running the approved suite in CI

Specs accumulate as a side effect of normal QA work. Running them unattended is what turns
that pile into regression coverage, and it is the one step that keeps paying after the
feature ships.

Copy `templates/qa-pilot-ci.yml` into `.github/workflows/`, edit the lines marked `EDIT`,
and read the two prerequisites below before you expect it to go green. On another CI
system the same six steps port directly; nothing here is GitHub-specific except the YAML.

## What the CI job does, and what it deliberately does not

It runs the specs QA approved, against a deployed environment, and fails the build when
one of them stops passing. It uploads `report.json` and the traces as build artifacts.

**It does not publish to ClickUp.** Publishing runs through the approval gate over MCP and
writes to the tracker as a person, and a build runner is neither. Adding a second write
path, with a CI token and its own copy of the rules, would mean two things to keep honest
instead of one. When a CI regression needs to be in ClickUp, download `report.json` from
the build artifacts and run `/qa-pilot:publish-results` against it.

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

## Prerequisite 3: something has to be approved first

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

## Evidence in CI

The template uses `evidence_capture: on-failure`. Nobody samples CI passes, so keeping a
trace for every green case buys storage and wall clock and nothing else. Failures still
carry a full trace, which is what a red build needs.

Traces upload as build artifacts with a 14-day retention. They contain the test account's
session token, so treat the artifacts as credentials and keep the retention short.

## Pin the plugin

The workflow checks QA-Pilot out at a ref. Pin a tag or a commit SHA rather than a branch.
An unpinned ref means a change to QA-Pilot can turn your build red overnight with nothing
in your own repository's history to explain it.
