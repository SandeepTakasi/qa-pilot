# Running the approved suite in CI

Specs accumulate as a side effect of normal QA work. Running them unattended is what turns
that pile into regression coverage, and it is the one step that keeps paying after the
feature ships.

Copy `templates/qa-pilot-ci.yml` into `.github/workflows/`, edit the lines marked `EDIT`,
and read the four prerequisites below before you expect it to go green. On another CI
system the same steps port directly; nothing here is GitHub-specific except the YAML.

## What the CI job does, and what it deliberately does not

It runs the specs QA approved, against a deployed environment, and fails the build when
one of them stops passing. It lints the selected specs, and it uploads the run directory
(`report.json`, the Playwright results and the traces) as build artifacts on every run of a
private repository. On a public repository it uploads nothing (see "Evidence in CI").

**It never runs against production.** The job reads the environment's `kind` from the
profile and stops if it is `production`. Build artifacts leave the machine, and a production
trace carries a live session and every request body it touched; production runs are made by
a person, with evidence kept on their machine (see `/qa-pilot:run-tests`).

**It does not publish to ClickUp.** Publishing runs through the approval gate over MCP and
writes to the tracker as a person, and a build runner is neither. Adding a second write
path, with a CI token and its own copy of the rules, would mean two things to keep honest
instead of one. When a CI regression needs to be in ClickUp, download the run directory from
the build artifacts and run `/qa-pilot:publish-results` against it. On a private repository
the artifact is there on every run, whatever the environment's `evidence_upload` says (see
"Evidence in CI"). On a public repository there is no artifact, so run the specs locally.

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
| `REFUSED: no approved spec at priority <list> is runnable` | `PRIORITY` is set and no approved, undrifted spec has that priority | QA, via `/qa-pilot:qa-review`, or whoever set `PRIORITY` |
| `REFUSED: <k> approved spec(s) were skipped and --max-skipped allows <n>` | more approved specs were skipped (edited, missing or without a path) than `MAX_SKIPPED` allows; the step summary lists each one | QA, via `/qa-pilot:qa-review`, or whoever owns the spec |
| `eslint` errors on a spec | a test with no assertion, a fixed sleep, or a skipped or focused test | whoever wrote the spec |
| `File ignored` in the lint step | the config's `files` globs do not cover a selected spec, so it was not linted | whoever owns the config: add the app's `spec_dir` |

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

### Failing the build on a skip: `--max-skipped`

A skipped spec is not run, so a job that skips some and runs the rest reports green on part
of the suite. `select` takes `--max-skipped <n>`, a whole number, 0 or more, to turn that
into a failure. When more than `n` approved specs were skipped, `select` prints the skip
lines, then
`REFUSED: <k> approved spec(s) were skipped and --max-skipped allows <n>, so this job would report green on part of the suite.`
to stderr, prints nothing on stdout and exits 1. A limit at or above the skip count passes.

- Any other value, including an empty one or `--max-skipped` as the last argument, is an
  error: `select: --max-skipped must be a whole number, 0 or more` (exit 1). A job never
  falls back to "unlimited" by accident.
- Without the flag the count is not limited, exactly as in 0.4.0.
- Cases left out by `PRIORITY` are not skips: leaving them out is the job's intent. The
  zero-runnable refusal comes first and keeps its own message.
- **The flag needs plugin 0.4.1.** An older `ci-gate.mjs` ignores flags it does not know,
  so below 0.4.1 it would skip silently and the job would go green on part of the suite.

The template sets `MAX_SKIPPED: '0'`, so any skip fails the job. Raise it deliberately to
tolerate drift while QA catches up, or set it empty to drop the limit. It passes the flag
only when `MAX_SKIPPED` is non-empty, through an array like `PRIORITY_ARGS`, and it
captures select's stderr so the skipped specs reach the step summary even when select
fails. GitHub runs steps with `bash -eo pipefail`, which ends a step the moment a failing
command substitution returns, so the capture is written to survive that:

```bash
SPECS=$(node $PLUGIN/ci-gate.mjs select \
  --approved testing/$FEATURE/approved.json \
  --specs testing/$FEATURE/specs.json \
  "${PRIORITY_ARGS[@]}" "${SKIP_ARGS[@]}" 2>sel.err) || rc=$?
tee -a "$GITHUB_STEP_SUMMARY" < sel.err >&2
[ "${rc:-0}" = 0 ] || exit "$rc"
```

With the limit at 0, two things now fail CI that used to pass quietly:

- **An edited spec fails CI until QA re-approves it and its hash is recorded.** Run it,
  have QA approve it in `/qa-pilot:qa-review`, and commit the updated `approved.json`.
- **Retiring a case means deleting its key from `approved.json`.** A case that stays in the
  ledger with its spec file deleted is a skip on every run.

## Choosing what runs

By default the job runs every approved spec for the feature. A deploy job usually wants less:
the cases that must never break, quickly. The template's `PRIORITY` setting does that.

```yaml
env:
  PRIORITY: ''      # EDIT: P0 on a deploy-triggered job; empty runs everything approved
```

When `PRIORITY` is non-empty the select step adds
`--cases testing/$FEATURE/cases.yaml --priority "$PRIORITY"`, quoted so that `P0, P1` stays
one argument, and adds nothing when it is empty:

```bash
PRIORITY_ARGS=()
if [ -n "$PRIORITY" ]; then
  PRIORITY_ARGS=(--cases testing/$FEATURE/cases.yaml --priority "$PRIORITY")
fi
SPECS=$(node $PLUGIN/ci-gate.mjs select \
  --approved testing/$FEATURE/approved.json \
  --specs testing/$FEATURE/specs.json \
  "${PRIORITY_ARGS[@]}")
```

Priority is not recorded in `approved.json` or `specs.json`, only in `cases.yaml`, which is
why the filter needs that file. The call is:

```
node ci-gate.mjs select --approved <approved.json> --specs <specs.json> \
  [--cases <cases.yaml>] [--priority <P0[,P1[,P2]]>] [--max-skipped <n>] [--json]
```

The rules, in full:

- `--priority` without `--cases` is an error:
  `select: --priority needs --cases <cases.yaml>, because priority is recorded only there`.
  `--cases` without `--priority` is accepted and changes nothing: the file is not read, so even
  a `--cases` path that does not exist passes. With `--priority`, a `--cases` path that does not
  exist is an error: `no cases file at <path>`.
- Values are case-sensitive and comma-separated, each one trimmed: `P0,P1` and `P0, P1` mean
  the same, `p0` is not `P0`. An unknown value is an error that names it:
  `select: unknown priority "<v>"; use P0, P1 or P2`. An empty element, such as `P0,,P1` or a
  trailing comma, is an unknown value too, reported as `""`. With several bad values, the
  first unknown value in list order is the one named. So is `--priority` given with an empty
  value, or as the last argument with none: it is the unknown value `""`, because the flag's
  presence is what counts, not its value. A job can never silently fall back to running
  everything.
- Each of these errors exits 1, like every other error `ci-gate.mjs` throws. The checks run in
  a fixed sequence, so the first failure is the one reported. They are checked in this order:
  `--approved` or `--specs` missing, `--priority` without `--cases`, an unknown priority value,
  a missing cases file (only with `--priority`), and a missing approval ledger.
- Filtering happens first, meaning before the hash check. An approved case outside the filter
  is dropped silently, with no skip line and nothing on stderr, because leaving it out is the
  job's intent and not a problem.
- The two unknown-priority skips are decided before the filter, so a case the filter could not
  place is never dropped silently. An approved case that is missing from the cases file is
  skipped with the reason `not in cases.yaml, so its priority is unknown`. One that is present
  but has no valid priority (`P0`, `P1` or `P2`) is skipped with the reason
  `no valid priority in cases.yaml, so its priority is unknown`. A case with priority `P3`
  under `--priority P0` therefore gets a skip line, not a silent drop.
- The usual hash check then runs on whatever remains, so a drifted spec is still skipped and
  still printed with both hashes.
- If nothing is runnable at that priority, `select` exits 1 with
  `REFUSED: no approved spec at priority <list> is runnable, so this job would report green having proved nothing.`
  `<list>` is the trimmed values joined by `,`, so `P0, P1` prints as `P0,P1`. A P0 job that
  finds no P0 spec fails; it never goes green having run nothing.

**Recommended split: P0 on every deploy, everything on the nightly schedule.** A deploy needs
a fast answer about the cases that matter most, and the nightly run is where the slower P1 and
P2 cases are allowed to take their time. Because one template serves both, copy the workflow
twice or use two jobs: set `PRIORITY: P0` on the deploy-triggered one and leave it empty on the
scheduled one. Cases carry their priority in `cases.yaml`, so promoting a case to P0 moves it
into the deploy job with no change to the workflow.

The deploy P0 run and the nightly run must never hit one environment at the same time, so both
must share one concurrency group per environment, for example `qa-pilot-<env>`. This holds
whether the workflow is copied or holds two jobs. The template's group is
`qa-pilot-${{ github.workflow }}`, so a renamed copy gets its own group and would run in
parallel with the other; set the same group on both. Two jobs in one workflow are gated by
trigger with `if: github.event_name == ...`, for example `push` or `deployment` for the P0 job
and `schedule` for the nightly one, since otherwise both fire on every trigger.

## Linting the specs

After `select`, the template lints exactly the specs it selected, passing them to ESLint as
file paths:

```bash
rc=0
out=$(npx eslint -c eslint.qa-pilot.config.mjs $SPECS 2>&1) || rc=$?
printf '%s\n' "$out"
case "$out" in
  *'File ignored'*) echo "add the app's spec_dir to the files list" >&2; exit 1 ;;
esac
exit "$rc"
```

ESLint 9 does not fail on an explicit file path that the config's `files` globs do not cover.
It prints `File ignored because no matching configuration was supplied` and exits 0, so a
config that covers none of your specs would lint nothing and go green. The template fails the
step when the output contains `File ignored`, and otherwise keeps ESLint's exit code. The
`|| rc=$?` form is what lets the step survive GitHub's `bash -eo pipefail`. `/qa-pilot:run-tests`
passes directories instead, where a glob that matches nothing exits 2.

The lint catches what a reviewer skims past: a test with no assertion, a fixed `waitForTimeout`,
a skipped or focused test. Such a spec passes, and a pass proves nothing. The rules come
from `eslint-plugin-playwright`, which is maintained outside QA-Pilot.

To set it up:

1. Copy `templates/eslint.qa-pilot.config.mjs` to your repo root and commit it. It must sit
   there, not in the plugin checkout, because ESLint resolves `files` against the config
   file's directory. `/qa-pilot:run-tests` copies it if it is absent and writes your
   `spec_dir` values in.
2. Edit its `files` list, which holds one `<spec_dir>/**/*.spec.ts` glob per app. Cover every
   app's `spec_dir`: CI passes file paths, and a file no glob covers is ignored and now fails
   the CI lint step with `File ignored`. When run-tests passes directories, a glob that
   matches nothing makes ESLint exit 2, so list only directories that exist.
3. Add the dev dependencies `eslint@9`, `eslint-plugin-playwright`, `typescript-eslint` and
   `typescript`, so the job's `npm ci` installs them. `typescript-eslint` needs
   `typescript` as a peer, and only npm installs peers on its own.

Keep assertions in the test body. `expect-expect` flags a test whose only `expect` sits in a
helper, so moving the assertion out of the test hides it from the lint.

The lint only helps while the specs stay strict. A pull request check that flags weakened or
deleted tests is worth adding if your repo does not already have one, for example a
test-diff bot or a CODEOWNERS rule on the spec directory.

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

**Public repositories: the job uploads nothing.** On a public repository anyone can download a
build artifact, and a trace can carry the test account's refresh token. An early step asks
GitHub whether the repository is private (`gh api "repos/$GITHUB_REPOSITORY" --jq .private`)
and sets `PRIVATE_REPO`. If the lookup fails for any reason the repository counts as public:
it fails closed. The upload step runs only when `PRIVATE_REPO` is `true`; otherwise the step
summary says the artifacts were skipped, and the run directory stays on the runner. A public
repository that relied on artifacts should run the specs locally, or move the workflow to a
private repository.

**On a private repository the job uploads the run directory as a build artifact on every
run**, pass or fail, whatever the profile's `evidence_upload` is, `evidence_upload: local` and
`tracker: none` included. This is safe because CI never runs production, and a GitHub artifact
is visible only to people with read access to the repository, for 14 days. Reviewers need it:
without the trace, a red CI build is a message with nothing behind it.

The job reads `evidence.capture` from the profile and passes the matching `--trace` mode to
Playwright (`always` keeps a trace for every test, `on-failure` only for failures), and it
records that mode in `meta.json`, so the report claims exactly what the run kept. For a
regression job `on-failure` is a reasonable profile choice: nobody samples CI passes, and
failures still carry a full trace.

Playwright has no command-line flag for video, so the job cannot set it. **Make your config's
`use.video` match the profile's capture mode** (`retain-on-failure` under `on-failure`, `on`
under `always`), as `/qa-pilot:run-tests` describes; otherwise every passing test still records
and keeps a video, which throws away most of what `on-failure` saves.

Traces contain the test account's session token, so treat the artifacts as credentials:
everyone with read access to the repo can download them. Keep the retention short (the
template uses 14 days) and the test account restricted.

## Pin the plugin

The workflow checks QA-Pilot out at a ref. Pin a tag or a commit SHA rather than a branch.
An unpinned ref means a change to QA-Pilot can turn your build red overnight with nothing
in your own repository's history to explain it.

The template pins `ref: v0.4.1`. **`--priority` needs 0.4.0 or newer, and `--max-skipped`
needs 0.4.1 or newer.** An older `ci-gate.mjs` only reads the flags it knows, so below 0.4.0
it silently ignores `--priority` and runs every approved spec: the job looks like a P0 job and
is not. Below 0.4.1 it silently ignores `--max-skipped` and tolerates every skip. Keep the pin
at 0.4.1 or later for a job with `MAX_SKIPPED`, which the template sets by default.

Moving the pin to v0.4.0 also applies the breaking `test_account` rule to the whole profile. A
production environment without `test_account` makes the profile invalid, so every CI job fails,
including jobs against non-production environments, because the template validates the profile
first. Add `test_account` to each production environment before you move the pin.
