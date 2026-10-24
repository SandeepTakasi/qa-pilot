# Running the approved suite in CI

Specs accumulate as a side effect of normal QA work. Running them unattended turns that pile
into regression coverage.

Copy `templates/qa-pilot-ci.yml` into `.github/workflows/`, edit the lines marked `EDIT`, and
meet the four prerequisites below. Only the YAML is GitHub-specific; the steps port to other
CI systems.

## What the CI job does, and what it does not

It runs the specs QA approved against a deployed environment and fails the build when one
stops passing. It lints the selected specs, and on a private repository it uploads the run
directory (`report.json`, the Playwright results and the traces) as build artifacts on every
run (see "Evidence in CI").

**It does not run against production.** The job reads the environment's `kind` from the
profile and stops if it is `production`. Artifacts leave the machine and a production trace
carries a live session, so production runs are made by a person with evidence kept on their
machine (see `/qa-pilot:run-tests`).

**It does not publish to ClickUp, and its runs cannot be published.** Publishing goes through
the approval gate over MCP as a person; a build runner is neither, and a second write path
with its own copy of the rules would be two things to keep honest. A CI run records
`run_kind: ci`, which the publish gate refuses. To get a regression into the tracker,
reproduce it with `/qa-pilot:run-tests` and publish that run. The artifacts are for
diagnosing the failure.

**It does not need ClickUp.** `testing/<feature>/approved.json` is committed. It lists every
case QA accepted and the hash of what they accepted: the spec, the local files it imports, and
the case's steps, expected outcomes, preconditions and fixture in `cases.yaml`. CI answers
"what did QA approve, and is this still that test" from the repo alone.

## Not a pull request check

Point it at a deploy or a schedule, not at pull requests. A PR-triggered run tests whatever
is deployed to the shared QA environment, which is not the PR's code, so the result is red or
green for reasons unrelated to the change. Run it after a deploy to QA, and nightly. If each
PR gets its own preview deployment, register that environment in the profile and point the
job at it.

## Prerequisite 1: a non-interactive login

This is the real work. `/qa-pilot:setup-profiles` hands a headed browser to a human, which CI
cannot do, so the job needs its own login step that writes the same storage state file the
specs already load. About fifteen lines, host-specific because every login form is:

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

Keep `indexedDB: true`: without it a Firebase session saves as an empty-looking profile and
every spec fails at the first authenticated page.

Use a dedicated, low-privilege test account, with its credentials in CI secrets. Its session
ends up inside every trace the job uploads (see "What a trace contains" in
[SETUP-CLICKUP.md](./SETUP-CLICKUP.md)).

## Prerequisite 2: the runner reaches the environment

Behind a VPN or IP allowlist, a hosted runner cannot see the environment and every case comes
back `blocked`. Allowlist the runner or use a self-hosted one.

## Prerequisite 3: specs and ledgers are in the checkout

CI reads `approved.json`, `specs.json`, `cases.yaml` and the spec files from the checkout. In local-only
mode, where the specs and `testing/` are gitignored, the job fails at selection with "no
approved spec is runnable", so check `.gitignore` first. To use CI, commit the spec directory
and `testing/`, and ignore `testing/*/runs/`.

## Prerequisite 4: something is approved

`ci-gate.mjs select` refuses when no approved spec is runnable, so the job fails instead of
going green having run nothing. Add the workflow after a feature has been through the full
loop once: generate, run, publish, review.

## What a red build means

| Message | What happened | Who acts |
|---|---|---|
| `REGRESSION` | a case QA approved as passing now fails | the team that owns the feature |
| `ENVIRONMENT FAILED` | a case was blocked (often a failed setup project or an expired session), a fixture spec failed, Playwright reported an error outside any test (a failed global setup, a timeout), or the build changed mid-run | whoever owns the environment |
| `INCOMPLETE` | a selected approved case never ran, or a test ran without a case-ID title. Playwright reads file arguments as patterns, so a path with `(`, `)`, `[` or `]`, or a config `testIgnore`, can match nothing | whoever owns the spec paths or the Playwright config |
| `REFUSED: no approved spec is runnable` | nothing is approved, or every spec drifted | QA, via `/qa-pilot:qa-review` |
| `REFUSED: no approved spec at priority <list> is runnable` | `PRIORITY` is set and no approved, undrifted spec has that priority | QA, or whoever set `PRIORITY` |
| `REFUSED: <k> approved spec(s) were skipped and --max-skipped allows <n>` | more approved specs were skipped (changed since approval, missing, without a path, or removed from `cases.yaml`) than `MAX_SKIPPED` allows; the step summary lists each one | QA, or whoever owns the spec |
| `eslint` errors on a spec | a test with no assertion, a fixed sleep, a skipped or focused test, or a selector bound to CSS, XPath or position | whoever wrote the spec |
| `File ignored` in the lint step | the config's `files` globs do not cover a selected spec, so it was not linted | whoever owns the config: add the app's `spec_dir` |

A `flaky` case fails the build, as pass-on-retry is not a pass anywhere else in the pipeline.
Green means every selected approved case ran and passed; nothing less is reported as green.

## Tests that changed since approval are skipped, not run

`select` re-hashes each approved case (the spec, the local files it imports, and the case's
steps, expected outcomes, preconditions and fixture) and compares it to `approved.json`. A case
that no longer matches is excluded, with its case ID and both hashes printed, because nobody has reviewed the change.
Publish a run and have QA review it; the approval then carries forward. Editing a shared helper
skips every spec that imports it. Line endings are normalised, so a Windows checkout hashes
like CI's. If every case is skipped at once, someone probably reformatted the spec directory.

A case deleted from `cases.yaml` while its key stays in `approved.json` is skipped with
`no longer in cases.yaml`: delete the key to retire it.

### Failing the build on a skip: `--max-skipped`

A job that skips some specs and runs the rest reports green on part of the suite.
`select --max-skipped <n>` (a whole number, 0 or more) turns that into a failure: when more
than `n` approved specs were skipped, it prints the skip lines, then
`REFUSED: <k> approved spec(s) were skipped and --max-skipped allows <n>, so this job would report green on part of the suite.`
to stderr, prints nothing on stdout and exits 1.

- Any other value, including an empty one or the flag as the last argument, is an error:
  `select: --max-skipped must be a whole number, 0 or more` (exit 1).
- Without the flag the count is not limited.
- Cases left out by `PRIORITY` are not skips. The zero-runnable refusal comes first and keeps
  its own message.
- **Pin the plugin to the release the template came from.** An older `ci-gate.mjs` ignores
  flags it does not know, so the job would skip silently and go green on part of the suite.

The template sets `MAX_SKIPPED: '0'`, so any skip fails the job. Raise it to tolerate drift
while QA catches up, or set it empty to drop the limit. It passes the flag only when
`MAX_SKIPPED` is non-empty, and captures select's stderr so the skipped specs reach the step
summary even when select fails. GitHub runs steps with `bash -eo pipefail`, which ends a step
the moment a failing command substitution returns, so the capture is written to survive that:

```bash
node $PLUGIN/ci-gate.mjs select \
  --approved testing/$FEATURE/approved.json \
  --specs testing/$FEATURE/specs.json \
  --cases testing/$FEATURE/cases.yaml \
  "${PRIORITY_ARGS[@]}" "${SKIP_ARGS[@]}" --json >select.json 2>sel.err || rc=$?
tee -a "$GITHUB_STEP_SUMMARY" < sel.err >&2
[ "${rc:-0}" = 0 ] || exit "$rc"
SPECS=$(jq -er 'map(.path) | join(" ")' select.json)
```

`select.json` is kept for the verdict step, which fails the job if any selected case is
missing from the report (`verdict --expect select.json`).

With the limit at 0:

- **An edited spec fails CI until QA re-approves it** in `/qa-pilot:qa-review` and the updated
  `approved.json` is committed.
- **Retiring a case means deleting its key from `approved.json`.** A case left in the ledger
  with its spec file deleted is a skip on every run.

## Choosing what runs

By default the job runs every approved spec for the feature. A deploy job usually wants only
the cases that must not break, quickly. The template's `PRIORITY` setting does that:

```yaml
env:
  PRIORITY: ''      # EDIT: P0 on a deploy-triggered job; empty runs everything approved
```

When `PRIORITY` is non-empty the select step adds `--priority "$PRIORITY"` (quoted, so
`P0, P1` stays one argument), and adds nothing when it is empty. Priority is read from
`cases.yaml`, which `select` always reads:

```
node ci-gate.mjs select --approved <approved.json> --specs <specs.json> --cases <cases.yaml> \
  [--priority <P0[,P1[,P2]]>] [--max-skipped <n>] [--json]
```

- Values are case-sensitive and comma-separated, each trimmed: `P0, P1` equals `P0,P1`, `p0`
  is not `P0`. An unknown value is an error naming the first one:
  `select: unknown priority "<v>"; use P0, P1 or P2`. An empty element, empty value or missing
  value is the unknown value `""`, so the job does not fall back to running everything.
- Every error exits 1, and the first failing check is reported, in this order: a missing
  `--approved`, `--specs` or `--cases`, an unknown priority, a malformed `--max-skipped`, a
  missing approval ledger, a missing cases file.
- A case no longer in `cases.yaml` is skipped whatever the filter. The filter then drops an
  approved case outside it silently, because leaving it out is the job's intent, and skips one
  it cannot place: `no valid priority in cases.yaml, so its priority is unknown`.
- The hash check then runs on what remains, so a drifted spec is still skipped and printed.
- If nothing is runnable at that priority, `select` exits 1 with
  `REFUSED: no approved spec at priority <list> is runnable, so this job would report green having proved nothing.`
  `<list>` is the trimmed values joined by `,`.

**Recommended split: P0 on every deploy, everything on the nightly schedule.** Copy the
workflow twice or use two jobs: `PRIORITY: P0` on the deploy-triggered one, empty on the
scheduled one. Promoting a case to P0 in `cases.yaml` moves it into the deploy job with no
workflow change.

The two runs must not hit one environment at the same time, so give both the same concurrency
group per environment, for example `qa-pilot-<env>`. The template's group is
`qa-pilot-${{ github.workflow }}`, so a renamed copy gets its own group and would run in
parallel; set the same group on both. Two jobs in one workflow need
`if: github.event_name == ...` (for example `push` or `deployment` for P0, `schedule` for the
nightly), since otherwise both fire on every trigger.

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

ESLint 9 prints `File ignored because no matching configuration was supplied` and exits 0
for an explicit path the config's `files` globs do not cover, so a config that covers none of
your specs would lint nothing and go green. The template fails the step on that output and
otherwise keeps ESLint's exit code. The `|| rc=$?` form lets the step survive
`bash -eo pipefail`. `/qa-pilot:run-tests` passes directories instead, where a glob that
matches nothing exits 2.

The lint flags a test with no assertion, a fixed `waitForTimeout`, or a skipped or focused
test, which pass while proving nothing, and a selector bound to CSS, XPath or position
(`no-raw-locators`, `no-nth-methods`, `prefer-native-locators`), which breaks on the next
layout change. The rules come from `eslint-plugin-playwright`,
maintained outside QA-Pilot. To set it up:

1. Copy `templates/eslint.qa-pilot.config.mjs` to your repo root and commit it (ESLint
   resolves `files` against the config's directory). `/qa-pilot:run-tests` copies it if
   absent and writes your `spec_dir` values in.
2. Edit its `files` list: per app, `<spec_dir>/**/*.spec.ts` and `<spec_dir>/**/FIXTURE-*.ts`
   (fixture specs write; `/qa-pilot:run-tests` lints them, while this job lints only the
   selected case specs), covering every app's `spec_dir` and only
   directories that exist. If a component library teleports overlays, add each overlay root's
   CSS selector to `no-raw-locators`' `allowed` list.
3. Add the dev dependencies `eslint@9`, `eslint-plugin-playwright`, `typescript-eslint` and
   `typescript` so the job's `npm ci` installs them.

Keep assertions in the test body: `expect-expect` flags a test whose only `expect` sits in a
helper. The lint helps only while specs stay strict, so a pull request check that flags
weakened or deleted tests (CODEOWNERS on the spec directory, say) is worth adding.

## Each run has its own directory

As locally, everything a run produces goes under `testing/<feature>/runs/<run_id>/`:
`meta.json`, `spec-shas.json` (taken before the run), the Playwright report as `results.json` (the job sets
`PLAYWRIGHT_JSON_OUTPUT_NAME` to an absolute path, because Playwright resolves a bare name
against the config file's directory), traces under `test-results/`, fixture identities under
`fixtures/` (`QA_PILOT_FIXTURE_DIR`, with `QA_PILOT_FEATURE` for fixture projects; see
`/qa-pilot:run-tests`), and `report.json`.

## The write guard in CI

The job exports the feature's mutation policy from `cases.yaml` (after linting it) as
`QA_PILOT_MUTATION`, and the profile's `mutation` block as `QA_PILOT_MUTATION_CONFIG`, so
specs that import `test` from `write-guard.fixture.ts` run under the same guard as locally. A
feature with no `mutation` block runs `unrestricted`; a policy that cannot be read fails the
step.

## Evidence in CI

**Public repositories: the job uploads nothing.** Anyone can download a build artifact from a
public repository, and a trace can carry the test account's refresh token. An early step asks
GitHub whether the repository is private (`gh api "repos/$GITHUB_REPOSITORY" --jq .private`)
and sets `PRIVATE_REPO`; if the lookup fails the repository counts as public. The upload step
runs only when `PRIVATE_REPO` is `true`. Otherwise the step summary says the artifacts were
skipped and the run directory stays on the runner. Run the specs locally, or move the
workflow to a private repository.

**On a private repository the job uploads the run directory on every run**, pass or fail,
whatever the profile's `evidence_upload` says (`local` and `tracker: none` included). CI does
not run production, and a GitHub artifact is visible only to people with read access, for 14
days. Without the trace, a red CI build is a message with nothing behind it. Treat the
artifacts as credentials (the trace can hold a long-lived refresh token, see
[the profile schema](./schemas/qa-pilot.config.schema.md)) and keep the test account
restricted.

The job reads `evidence.capture` from the profile, passes the matching `--trace` mode to
Playwright (`always`, or `on-failure`) and records it in `meta.json`. For a regression job
`on-failure` is reasonable: failures still carry a full trace.

Playwright has no command-line flag for video, so **make your config's `use.video` match the
capture mode** (`retain-on-failure` under `on-failure`, `on` under `always`), as
`/qa-pilot:run-tests` describes. Otherwise every passing test still records a video, which
discards most of what `on-failure` saves.

## Pin the plugin

The workflow checks QA-Pilot out at a ref. Pin a tag or commit SHA, not a branch, or a change
to QA-Pilot can turn your build red overnight with nothing in your history to explain it.

The template pins `ref: v0.4.3` and needs 0.4.3 or newer: `select` takes `--cases` always
and `verdict` takes `--expect`, and an older `ci-gate.mjs` ignores flags it does not know, so
the job would go green on less than it claims. Upgrade the template and the pin together.

Moving from 0.4.2 resets every approval once, because the hash now covers each spec's imports
and its case's steps, expected outcomes, preconditions and fixture: CI skips every case until
QA re-approves it in `/qa-pilot:qa-review`, and fails with `REFUSED: no approved spec is runnable` until at least
one is. Disable the workflow until the ledger is re-recorded, then set `MAX_SKIPPED` empty while
the remaining cases are pending.

Moving the pin to v0.4.0 or later also applies the `test_account` rule to the whole profile:
a production environment without it makes the profile invalid, so every CI job fails,
including jobs against other environments, because the template validates the profile first.
Add `test_account` to each production environment before you move the pin.
