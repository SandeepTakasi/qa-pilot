---
name: run-tests
description: Execute QA-approved test cases for a feature against a registered deployed environment. Verify approval in ClickUp (or a local statuses file without a tracker), read the deploy SHA before and after the run, convert approved cases into committed Playwright specs, run them with video, trace and console evidence, and apply the flake protocol. Verdicts come only from these runs; agentic browser sessions may author and debug specs but never adjudicate. Use when the user says "run tests", "execute the cases", or "/run-tests <feature> --env <name>".
argument-hint: "<feature> --env <name>"
---

# run-tests: execute approved cases and produce evidence

The committed Playwright spec is the durable asset here. It produces the verdict today and regresses the feature forever in CI. An agentic browser session can help you *write* one, but "Claude clicked through it and it looked fine" is exactly the unverifiable claim this pipeline exists to eliminate, and it leaves no script behind.

Recommended model: Sonnet-class is enough for straightforward spec authoring. Reach for a stronger model on cross-app multi-context specs and on stubborn flake triage.

## 0. Profile and cases gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-cases.mjs" testing/<feature>/cases.yaml --profile <profile-path>
```

Nonzero exit from either → STOP and print the errors. A broken profile points at `/qa-pilot:qa-init`; a broken cases file at `/qa-pilot:generate-tests`. The cases lint also checks the feature's `mutation` policy and `fixtures`, which this run enforces.

Then check whether the profile is committed (`git ls-files --error-unmatch <profile-path>`). If it is not, **warn but continue**: an uncommitted profile is fine for a solo pilot and must be committed before the team relies on it, because otherwise five developers test against five different definitions of the truth. Some hosts deliberately gitignore it while trialling the pipeline, which is a legitimate choice rather than an error.

## 1. Check the environment is registered, and what kind it is

`--env <name>` must be a key in the profile's `environments`. If it is not, **STOP**: verdicts are only valid against registered deployed environments. Never substitute a localhost URL, because a local stack is not the build the users will get.

Identify which app(s) the feature's cases target, and take their base URLs from `environments.<env>.apps`. Read the environment's `kind` and its effective `evidence_upload` from the normalized profile the loader printed; never re-derive them.

**When `kind` is `production`**, all of these must hold before anything runs. Each is a STOP, not a warning:

- **The run directory is gitignored.** Production evidence never reaches git:

  ```bash
  git check-ignore -q testing/<feature>/runs/x
  ```

  Nonzero → STOP and tell the user to ignore `testing/*/runs/` first.
- **The feature declares a mutation policy other than `unrestricted`.** A `cases.yaml` with no `mutation` block is `unrestricted`. Refusing here, before the run, is the point: the publish gate refuses it too, but only after the writes have happened.
- **Every spec and fixture spec imports `test` from the write guard** (step 5).

Production traces stay on this machine. Say so up front, and say that QA will review them here (`/qa-pilot:qa-review`), since nothing is attached to the tracker.

## 2. Approval gate

Find each case's current status:

- **With a tracker** (`tracker: clickup`, the default): read `testing/<feature>/clickup-map.json` and fetch each mapped task's status over MCP. If ClickUp is unreachable, STOP rather than assuming approval.
- **Under `tracker: none`**: read `testing/<feature>/statuses.json`, which QA edits by hand. There is no ClickUp fetch. If the file is missing, STOP: nothing has been approved.

Write what you read to `testing/<feature>/runs/statuses.json` as `{"<CASE-ID>": "<status>"}`, since recording it makes the gate auditable instead of remembered, then ask the script what it means:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml \
  --statuses testing/<feature>/runs/statuses.json \
  --profile <profile-path>
```

Always pass `--profile`. Without it the script assumes the canonical status names, which are wrong for any host that renamed them (under `tracker: none` the canonical names are the right ones, and the profile says so).

Run exactly the case IDs in `executable[]`. Report `held[]` with each reason, and surface every warning. Do not decide eligibility yourself from the status names.

**Design approval persists across builds.** Four lifecycle states execute: `approved_for_execution`, `approved`, `retest`, and `under_review`. A case QA approved re-runs on the next build, which is what makes this a regression suite rather than a one-shot. `case_review` and `rejected` never execute, and `quarantined` is excluded unless you pass `--include-quarantined`, which is for verifying a hardening fix.

Those are lifecycle keys, not status names. What this host calls each one lives in the profile's `clickup.statuses`, so read them from there when you talk to the user; the script does the matching. Each executable entry comes back with its `state`, so you never have to map a name yourself.

Nonzero exit means nothing is eligible, so **STOP** and show `held[]`. Running unapproved cases and publishing them defeats the gate that keeps hallucinated cases out of the record.

**Keep `statuses.json`, and file it with the run in step 8.** `/qa-pilot:publish-results` passes it to the publish gate, which is what actually enforces approval. This step is a courtesy that saves a wasted run; the gate is the enforcement, because a step written only in prose is one a hurried session skips.

## 3. Sandbox, stabilization, or verdict run?

- **The sandbox** (`sandbox.mode`, e.g. `VITE_API_MODE=mocks`): a **stabilization run**. Mock backends are seeded and always succeed, which makes them a good place to shake out selectors without competing for the shared deployed environment. Stamp `api_mode` with the sandbox value; the gate refuses to publish it.
- **`stabilization.env`**, when the profile names one: a deployed, non-production environment where a new spec may earn its greens when the sandbox cannot model the flow. These runs are stabilization runs too.
- **Anything else**: a verdict run.

Say which it is, up front. **A stabilization run is never handed to `/qa-pilot:publish-results`**, wherever it ran. On the sandbox the gate would refuse it anyway; on `stabilization.env` it cannot tell, so this rests on you.

## 4. Read the deploy SHA, before the run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/read-env-sha.mjs" <profile> <env> <app>
```

Failure → STOP. A run whose SHA cannot be read can never be published, so running it wastes both the environment and the time.

The run ID is now known: `<ISO timestamp>-<feature>-<short sha>`. Every output of this run goes under one directory, `testing/<feature>/runs/<run_id>/`, called `$RUN_DIR` below. Create it, and `$RUN_DIR/fixtures/`.

## 5. Generate or update the specs

Specs live at `<apps.<app>.spec_dir>/<feature>/<CASE-ID>.spec.ts` and are **committed**. Follow `references/spec-conventions.md`. The rules that matter:

- One spec file per case; the case ID is the test title prefix so `parse-report.mjs` can map results back to cases.
- Selectors use the profile's `selectors.testid_attribute`. Where the app has no test IDs yet, add them to the app source as part of this work rather than binding to text or DOM structure, because a spec that binds to markup is a spec that rots.
- **Assertions follow the profile.** When `assertions.network_events: forbidden`, never assert through the network: no `waitForResponse`, no `waitForRequest`, no route handler used to check that a call happened. On such hosts the operation never reaches the network layer, the wait no-ops, and the test passes whether or not the feature works. Assert on rendered UI state. (The write guard's own route is not an assertion; it is how writes are stopped, and it runs on every host.)
- Capture console output when `evidence.extra` includes `console_log`. On hosts where operations bypass the network, the console *is* the network tab, and it is what makes a failure triageable.
- Cross-app cases live in `cross_app.spec_home`'s spec dir and use `expect.poll` with `cross_app.propagation_window_s` as the ceiling. Eventual consistency is architecture, not flakiness.
- **Never overwrite a hand-stabilized spec without asking.** If a spec file already exists and differs from what you would generate, show the difference and let the user decide. Someone probably fixed a selector by hand.

**The write guard.** When the feature's policy is anything but `unrestricted`, or the environment is production, every spec and every fixture spec imports `test` from the write guard. Copy both templates into the spec directory once, and commit them:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/templates/write-guard.mjs" "${CLAUDE_PLUGIN_ROOT}/templates/write-guard.fixture.ts" <spec_dir>/
```

Specs then `import { test, expect } from '../write-guard.fixture'` (or from a `fixtures.ts` that extends it, see `references/spec-conventions.md`). A spec that bypasses it leaves no write record, and the publish gate refuses the run. Under `scoped-write`, every entity a spec creates carries the feature's `mutation.prefix` in its name, or its own controls are blocked.

**Shared fixtures.** For each `fixtures[]` entry in `cases.yaml`, write `<spec_dir>/<feature>/FIXTURE-<name>.setup.ts` (test title `FIXTURE <name>`) and, only for `teardown: delete`, `FIXTURE-<name>.teardown.ts` (title `FIXTURE <name> teardown`). Wire them as Playwright projects. Each needs an explicit `testMatch`, because the default `testMatch` does not find `*.setup.ts` or `*.teardown.ts` files, and `retries: 0`, because a setup that only works on retry has already created a first entity:

```js
projects: [
  { name: 'fixture-setup', testMatch: '**/*.setup.ts', retries: 0, teardown: 'fixture-teardown' },
  { name: 'fixture-teardown', testMatch: '**/*.teardown.ts', retries: 0 },
  { name: 'chromium', testMatch: '**/*.spec.ts', dependencies: ['fixture-setup'] },
],
```

The setup saves the entity's identity with `saveFixture(name, identity)` from the guard fixture, and dependents read it with `loadFixture(name)`; both use `QA_PILOT_FIXTURE_DIR`, which step 7 sets to `$RUN_DIR/fixtures/`.

Playwright config for the run, with `trace.mode` set from the profile's `evidence.capture`:

| `evidence.capture` | `trace.mode` | `video` | Effect |
|---|---|---|---|
| `always` (default; required on production) | `'on'` | `'on'` | Every executed case is reviewable. Costs roughly 700 KB per case and noticeable wall clock. |
| `on-failure` | `'retain-on-failure'` | `'retain-on-failure'` | A green run keeps nothing. Passing cases have no trace, so QA cannot sample them. |
| `off` | `'off'` | `'off'` | Fastest, and nothing can be published. For iterating on specs locally. |

**`video` must track the mode.** Playwright records and keeps videos according to its own setting regardless of `trace.mode`, so leaving `video: 'on'` under `on-failure` still records every case and still writes a `.webm` per pass, which throws away most of the saving. Measured on a 3-case run: 50 KB kept with `video: 'on'`, 0 KB with both set to `retain-on-failure`. The trace embeds the recording only when video is being captured, so under `always` keep both on; the standalone `.webm` is never uploaded anywhere, because the trace supersedes it.

```js
use: {
  trace: { mode: <from the table>, sources: false },  // sources: false trims ~22%
  video: <from the table>,
  screenshot: 'only-on-failure',
},
retries: 1,
// No reporter here: step 7 passes reporters on the command line, so their output paths
// come from the environment and land in this run's directory. A JSON outputFile in the
// config would override that and send every run to the same file.
```

**Record the mode in `meta.json` as `evidence_capture`.** The publish gate needs it to tell a deliberately uncaptured pass from a lost artifact, and it refuses the run outright when the mode was `off`.

If the host is on `on-failure`, say so in your run summary: a false pass in that run cannot be caught by review, because there is nothing for QA to open.

Do not turn off `screenshots` within the trace to save space. It is roughly 95% of the file size and it is exactly what a reviewer scrubs through. Reach for `evidence.capture` instead, which is the knob designed for this trade.

**The trace is the evidence.** `validate-report.mjs` refuses to publish any executed case without one, because a trace carries the video byte-for-byte, the console output, the screenshot film-strip, the DOM snapshots and the network log in a single file.

## 6. Stabilize new specs before they count

A spec that has never run gets **three consecutive green runs** on the sandbox, or on `stabilization.env` when the profile names one, before its first verdict run is treated as evidence. Track this in `testing/<feature>/run-log.json`. This is cheap insurance against publishing a verdict from a spec that was simply lucky. `stabilization.env` is never production; the profile loader refuses that.

## 7. Run

Set the guard's inputs and this run's output paths, then run from the app's repo root:

```bash
export QA_PILOT_MUTATION='<{"policy": ..., "prefix": ...} from cases.yaml mutation; {"policy":"unrestricted"} when absent>'
export QA_PILOT_MUTATION_CONFIG='<the profile mutation block as JSON, or unset>'
export QA_PILOT_FIXTURE_DIR="$PWD/$RUN_DIR/fixtures"
PLAYWRIGHT_JSON_OUTPUT_NAME="$RUN_DIR/results.json" \
PLAYWRIGHT_HTML_OUTPUT_DIR="$RUN_DIR/html" \
  npx playwright test <case spec paths> <FIXTURE-*.setup.ts and .teardown.ts of every fixture they name> \
    --reporter=json,html --output="$RUN_DIR/test-results"
```

`prefix` goes into `QA_PILOT_MUTATION` only under `scoped-write`. Unset, the guard runs `read-only`, never `unrestricted`. Pass the fixture specs explicitly: a file filter applies to every project, so a setup file left off the command line does not run, and every case that needs it is blocked.

Then read the deploy SHA **again**.

**If the SHA changed, every case in the run is `blocked`.** Half the cases tested one build and half another; no verdict from that run is trustworthy. Say so, and tell the user to re-run once the deploy settles.

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

Also update `testing/<feature>/specs.json`, mapping each case ID to the spec file that ran, and **commit it**:

```json
{ "CHECKOUT-ORDER-001": "e2e/checkout/CHECKOUT-ORDER-001.spec.ts" }
```

It lives at the feature level rather than under the run, because the mapping does not change from run to run and CI reads it from the repo. Merge into it rather than replacing it: a run of three cases must not drop the other twenty.

Check whether it is tracked, the same way you checked the profile:

```bash
git ls-files --error-unmatch testing/<feature>/specs.json
```

If it is not, **say so once and continue**. A host running in local-only mode has ignored `testing/` on purpose, which is a legitimate choice. What it costs is worth stating plainly rather than assuming they know: without this file `parse-report.mjs` records no `spec_sha`, so approval never carries forward and every passing case returns to review on the next run. Do not nag about it on every run.

`parse-report.mjs` hashes those files so each verdict records the spec that produced it. That hash is what lets an approved case keep its approval when it passes again unchanged, what sends it back for review when someone edited the spec, and what CI uses to run only what QA actually approved.

Copy `testing/<feature>/runs/statuses.json` from step 2 into `$RUN_DIR/`, so the run carries the approval state it actually ran under. The run directory then holds everything `/qa-pilot:publish-results` and the gate read: `meta.json`, `results.json`, `statuses.json`, `test-results/` with each attempt's trace and `writes.json`, and `fixtures/`. A statuses file left only at `testing/<feature>/runs/statuses.json` is overwritten by the next run, so a report published later would be gated against approvals that did not exist when it ran.

## 9. Apply the flake protocol

- **A case that failed and passed on retry is `flaky`, never `pass`.** This is not negotiable and `parse-report.mjs` enforces it deterministically. Do not report it as a pass in your summary either.
- Flaky cases are quarantined: they stay in the confidence denominator (lowering the score is the point) and get assigned for hardening.
- Cases crossing a declared propagation window are exempt from duration-based flake suspicion.
- **If more than 10% of cases are `blocked`, the run is halted.** Do not proceed to publish. Blocked means the environment failed, not the feature, so fix the environment and re-run.

## 10. Report and hand off

Summarize: counts by verdict, the SHA and environment, anything excluded for lack of approval, any spec that needed hand-fixing, and, for a guarded run, any write the guard blocked (each `writes.json` lists them). A read-only run with a blocked write cannot publish; say which spec tried and what it clicked. Then point at `/qa-pilot:publish-results <feature>` for a verdict run, or say plainly that a stabilization run is not published.

Commit the specs and the two write-guard templates. They are the asset: CI regression comes free from specs that accumulated as a side effect of normal testing, which is how this survives the crunch it was built for. Never commit `testing/*/runs/`, and on production it must already be ignored.
