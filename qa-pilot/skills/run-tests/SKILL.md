---
name: run-tests
description: Execute QA-approved test cases for a feature against a registered deployed environment, with committed Playwright specs, evidence, and the flake protocol. Use when the user says "run tests", "execute the cases", or "/run-tests <feature> --env <name>".
argument-hint: "<feature> --env <name>"
---

# run-tests: execute approved cases and produce evidence

Verdicts come only from committed Playwright specs run by this skill. An agentic browser session may help write or debug a spec but never adjudicates: "it looked fine" is unverifiable and leaves no script.

## 0. Profile and cases gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-cases.mjs" testing/<feature>/cases.yaml --profile <profile-path>
```

Nonzero exit from either → STOP and print the errors. A broken profile points at `/qa-pilot:qa-init`; a broken cases file at `/qa-pilot:generate-tests`. The cases lint also checks the `mutation` policy and `fixtures`, which this run enforces.

Then run `git ls-files --error-unmatch <profile-path>`. If the profile is not committed, **warn but continue** (fine for a solo pilot).

## 1. Check the environment is registered, and what kind it is

`--env <name>` must be a key in the profile's `environments`, otherwise **STOP**. Never substitute a localhost URL.

Take base URLs from `environments.<env>.apps`. Read `kind` and effective `evidence_upload` from the normalized profile the loader printed; never re-derive them.

**When `kind` is `production`**, each of these is a STOP, not a warning:

- **A restricted account signs in.** `test_account` in the profile names it. Confirm the saved login is that account; nothing checks it, and the write guard is not the boundary.
- **The run directory is gitignored**: `git check-ignore -q testing/<feature>/runs/x`. Nonzero → tell the user to ignore `testing/*/runs/` first.
- **The feature declares a mutation policy other than `unrestricted`.** No `mutation` block means `unrestricted`. Refuse here, before any writes happen.
- **Every spec and fixture spec imports `test` from the write guard** (step 5).

Say up front that production traces stay on this machine and QA reviews them here (`/qa-pilot:qa-review`).

**When the effective `evidence_upload` is `reference` (the default off production) or `local` (always on production)**, evidence stays on this machine on any environment. Run the same `git check-ignore` check; nonzero → STOP and tell the user to ignore `testing/*/runs/` first, or the traces leave through git. Under `reference` the tracker still gets case fields and failure text, never the trace; say that QA opens traces here by `trace_sha256` and `npx playwright show-trace <path>`.

## 2. Approval gate

With `tracker: clickup` (the default), read `references/clickup.md` here. Under `tracker: none`, read `testing/<feature>/statuses.json` (QA edits it by hand); if it is missing, STOP: nothing is approved.

Write what you read to `testing/<feature>/runs/statuses.json` as `{"<CASE-ID>": "<status>"}`, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml \
  --statuses testing/<feature>/runs/statuses.json \
  --profile <profile-path>
```

Always pass `--profile`; without it the canonical status names are assumed, which is wrong for any host that renamed them.

Run exactly the case IDs in `executable[]`. Report `held[]` with each reason and surface every warning. Do not decide eligibility from status names yourself. Nonzero exit means nothing is eligible: **STOP** and show `held[]`.

Approval persists across builds: `approved_for_execution`, `approved`, `retest` and `under_review` execute; `case_review` and `rejected` never do; `quarantined` is excluded unless you pass `--include-quarantined` (for verifying a hardening fix).

File `statuses.json` with the run in step 8; the publish gate uses it to enforce approval.

## 3. Sandbox, stabilization, or verdict run?

- **The sandbox** (`sandbox.mode`, e.g. `VITE_API_MODE=mocks`): a **stabilization run**. Stamp `api_mode` with the sandbox value; the gate refuses to publish it.
- **`stabilization.env`**, when the profile names one: a deployed non-production environment where a new spec may earn its greens. Also a stabilization run.
- **Anything else**: a verdict run.

Say which it is, up front. **A stabilization run is never handed to `/qa-pilot:publish-results`**, wherever it ran. The gate cannot spot a `stabilization.env` run, so this rests on you.

## 4. Read the deploy SHA, before the run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/read-env-sha.mjs" <profile> <env> <app>
```

Failure → STOP (a run with an unreadable SHA can never be published).

The run ID is `<ISO timestamp>-<feature>-<short sha>`. All output goes under `testing/<feature>/runs/<run_id>/`, called `$RUN_DIR` below. Create it and `$RUN_DIR/fixtures/`.

## 5. Generate or update the specs

Specs live at `<apps.<app>.spec_dir>/<feature>/<CASE-ID>.spec.ts` and are **committed**. Follow `references/spec-conventions.md`. In short:

- One spec file per case; the case ID prefixes the test title so `parse-report.mjs` can map results back.
- Selectors use `selectors.testid_attribute`. Where the app has no test IDs, add them to the app source rather than binding to text or DOM structure.
- **When `assertions.network_events: forbidden`**, never assert through the network (no `waitForResponse`, `waitForRequest`, or route handler as a check): the wait no-ops and the test passes whether or not the feature works. Assert on rendered UI state. The write guard's own route is not an assertion and runs on every host.
- Capture console output when `evidence.extra` includes `console_log`.
- Cross-app cases live in `cross_app.spec_home`'s spec dir and use `expect.poll` with `cross_app.propagation_window_s` as the ceiling.
- **Never overwrite a hand-stabilized spec without asking.** If a spec exists and differs from what you would generate, show the difference and let the user decide.

**The write guard.** When the feature's policy is anything but `unrestricted`, or the environment is production, every spec and fixture spec imports `test` from the write guard. Copy both templates into the spec directory once and commit them:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/templates/write-guard.mjs" "${CLAUDE_PLUGIN_ROOT}/templates/write-guard.fixture.ts" <spec_dir>/
```

Specs then `import { test, expect } from '../write-guard.fixture'` (or a `fixtures.ts` that extends it; see `references/spec-conventions.md`). A spec that bypasses it leaves no write record and the publish gate refuses the run. Under `scoped-write`, every entity a spec creates carries `mutation.prefix` in its name, or its own controls are blocked.

**Lint the specs before the verdict run.** The host keeps `eslint.qa-pilot.config.mjs` at its repo root. If absent, copy it and write every app's `spec_dir` into its `files` globs as `<spec_dir>/**/*.spec.ts`:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/templates/eslint.qa-pilot.config.mjs" ./
npx eslint -c eslint.qa-pilot.config.mjs <spec_dir>/<feature>
```

It needs dev dependencies `eslint@9`, `eslint-plugin-playwright`, `typescript-eslint` and `typescript`; tell the user to add any that are missing. Fix every error without weakening or removing an assertion.

**Shared fixtures.** For each `fixtures[]` entry in `cases.yaml`, write `<spec_dir>/<feature>/FIXTURE-<name>.setup.ts` (test title `FIXTURE <name>`) and, only for `teardown: delete`, `FIXTURE-<name>.teardown.ts` (title `FIXTURE <name> teardown`). Wire them as Playwright projects, each with an explicit `testMatch` (the default does not find `*.setup.ts`) and `retries: 0`:

```js
// Scoped to this feature: a file filter on the command line does not apply to dependency or
// teardown projects, so without this every run would write through every feature's fixtures.
const feature = process.env.QA_PILOT_FEATURE ?? '__no_feature__';

projects: [
  { name: 'fixture-setup', testMatch: `**/${feature}/FIXTURE-*.setup.ts`, retries: 0, teardown: 'fixture-teardown' },
  { name: 'fixture-teardown', testMatch: `**/${feature}/FIXTURE-*.teardown.ts`, retries: 0 },
  { name: 'chromium', testMatch: '**/*.spec.ts', dependencies: ['fixture-setup'] },
],
```

Every declared fixture runs on each run, whichever cases are selected. Setup saves the entity identity with `saveFixture(name, identity)`; dependents read it with `loadFixture(name)`. Both use `QA_PILOT_FIXTURE_DIR`, set in step 7.

Playwright config, with `trace.mode` and `video` set together from the profile's `evidence.capture`:

| `evidence.capture` | `trace.mode` | `video` | Effect |
|---|---|---|---|
| `always` (default; required on production) | `'on'` | `'on'` | Every executed case is reviewable. |
| `on-failure` | `'retain-on-failure'` | `'retain-on-failure'` | A green run keeps nothing, so QA cannot sample passes. |
| `off` | `'off'` | `'off'` | Nothing can be published. For local spec iteration only. |

`video` must track the mode: `video: 'on'` under `on-failure` still records and keeps a `.webm` per pass.

```js
use: {
  trace: { mode: <from the table>, sources: false },
  video: <from the table>,
  screenshot: 'only-on-failure',
},
retries: 1,
// No reporter or JSON outputFile here: step 7 passes reporters on the command line so
// output lands in this run's directory.
```

**Record the mode in `meta.json` as `evidence_capture`** (step 8). If the host is on `on-failure`, say in your run summary that a false pass cannot be caught by review.

Do not turn off screenshots within the trace; use `evidence.capture`. `validate-report.mjs` refuses any executed case without a trace.

## 6. Stabilize new specs before they count

A spec that has never run needs **three consecutive green runs** on the sandbox, or on `stabilization.env` when the profile names one, before its first verdict run counts as evidence. `stabilization.env` is never production.

## 7. Run

Set the guard's inputs and this run's output paths, then run from the app's repo root:

```bash
export QA_PILOT_MUTATION='<{"policy": ..., "prefix": ...} from cases.yaml mutation; {"policy":"unrestricted"} when absent>'
export QA_PILOT_MUTATION_CONFIG='<the profile mutation block as JSON, or unset>'
export QA_PILOT_FIXTURE_DIR="$PWD/$RUN_DIR/fixtures"
export QA_PILOT_FEATURE='<feature>'
PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/$RUN_DIR/results.json" \
PLAYWRIGHT_HTML_OUTPUT_DIR="$PWD/$RUN_DIR/html" \
  npx playwright test <case spec paths> \
    --reporter=json,html --output="$PWD/$RUN_DIR/test-results"
```

`prefix` goes into `QA_PILOT_MUTATION` only under `scoped-write`. If `QA_PILOT_MUTATION` is unset the guard runs `read-only`, never `unrestricted`. Do not list fixture specs yourself; `QA_PILOT_FEATURE` selects them. Keep every output path absolute: Playwright resolves `PLAYWRIGHT_JSON_OUTPUT_NAME` against the config file's directory.

Then read the deploy SHA **again**. **If it changed, every case in the run is `blocked`**: say so and tell the user to re-run once the deploy settles.

## 8. Record the run

Write `$RUN_DIR/meta.json`:

```json
{
  "run_id": "<ISO timestamp>-<feature>-<short sha>",
  "feature": "...", "app": "...", "env_name": "...", "env_url": "...",
  "env_kind": "qa | staging | production",       // the environment's kind from the profile
  "api_mode": "server | mocks",
  "sha_before": "...", "sha_after": "...", "sha_source": "<url>",
  "sha_format": "commit | build-id",   // copy read-env-sha's `format` verbatim
  "evidence_capture": "always | on-failure | off",   // from the profile's evidence.capture
  "mutation_policy": "read-only | scoped-write | unrestricted",  // cases.yaml; unrestricted when absent
  "mutation_prefix": "<prefix> | null",           // only under scoped-write
  "executor": "<the developer running this>",
  "model_version": "<your model id>",
  "playwright_version": "...", "browser": "chromium-<version>",
  "started_at": "...", "finished_at": "..."
}
```

Also update `testing/<feature>/specs.json`, mapping each case ID to the spec file that ran, and **commit it**. Merge into it; a run of three cases must not drop the other twenty.

```json
{ "CHECKOUT-ORDER-001": "e2e/checkout/CHECKOUT-ORDER-001.spec.ts" }
```

Check `git ls-files --error-unmatch testing/<feature>/specs.json`. If untracked, **say so once and continue** (a local-only host ignores `testing/` on purpose), and state the cost: without it `parse-report.mjs` records no `spec_sha`, so approval never carries forward and every passing case returns to review next run.

Copy `testing/<feature>/runs/statuses.json` into `$RUN_DIR/`, so the run carries the approvals it ran under. The run directory then holds what `/qa-pilot:publish-results` and the gate read: `meta.json`, `results.json`, `statuses.json`, `test-results/` (each attempt's trace and `writes.json`), and `fixtures/`.

## 9. Apply the flake protocol

- **A case that failed and passed on retry is `flaky`, never `pass`.** Do not report it as a pass in your summary either (`parse-report.mjs` enforces the verdict).
- Flaky cases are quarantined: they stay in the confidence denominator and get assigned for hardening.
- Cases crossing a declared propagation window are exempt from duration-based flake suspicion.
- **If more than 10% of cases are `blocked`, the run is halted.** Do not publish. Fix the environment and re-run.

## 10. Report and hand off

Summarize: counts by verdict, the SHA and environment, anything excluded for lack of approval, any spec that needed hand-fixing, for each new spec that it had three consecutive green runs, and for a guarded run any write the guard blocked (each `writes.json` lists them). A read-only run with a blocked write cannot publish; say which spec tried and what it clicked. Then point at `/qa-pilot:publish-results <feature>` for a verdict run, or say plainly that a stabilization run is not published.

Commit the specs and the two write-guard templates. CI runs only committed specs that QA has approved (`${CLAUDE_PLUGIN_ROOT}/SETUP-CI.md`), and every spec edit needs QA re-approval first. Never commit `testing/*/runs/`; wherever evidence stays on this machine (`reference` or `local`, including all of production) it must already be ignored.
