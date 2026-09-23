---
name: run-tests
description: Execute QA-approved test cases for a feature against a registered deployed environment. Verify approval in ClickUp, read the deploy SHA before and after the run, convert approved cases into committed Playwright specs, run them with video, trace and console evidence, and apply the flake protocol. Verdicts come only from these runs; agentic browser sessions may author and debug specs but never adjudicate. Use when the user says "run tests", "execute the cases", or "/run-tests <feature> --env <name>".
argument-hint: "<feature> --env <name>"
---

# run-tests: execute approved cases and produce evidence

The committed Playwright spec is the durable asset here. It produces the verdict today and regresses the feature forever in CI. An agentic browser session can help you *write* one, but "Claude clicked through it and it looked fine" is exactly the unverifiable claim this pipeline exists to eliminate, and it leaves no script behind.

Recommended model: Sonnet-class is enough for straightforward spec authoring. Reach for a stronger model on cross-app multi-context specs and on stubborn flake triage.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP, print errors, point at `/qa-pilot:qa-init`.

Then check whether the profile is committed (`git ls-files --error-unmatch <profile-path>`). If it is not, **warn but continue**: an uncommitted profile is fine for a solo pilot and must be committed before the team relies on it, because otherwise five developers test against five different definitions of the truth. Some hosts deliberately gitignore it while trialling the pipeline, which is a legitimate choice rather than an error.

## 1. Check the environment is registered

`--env <name>` must be a key in the profile's `environments`. If it is not, **STOP**: verdicts are only valid against registered deployed environments. Never substitute a localhost URL, because a local stack is not the build the users will get.

Identify which app(s) the feature's cases target, and take their base URLs from `environments.<env>.apps`.

## 2. Approval gate

Read `testing/<feature>/clickup-map.json` and fetch each mapped task's status over MCP. Write what you read to `testing/<feature>/runs/statuses.json` as `{"<CASE-ID>": "<status>"}`, since recording it makes the gate auditable instead of remembered, then ask the script what it means:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/case-status.mjs" \
  --cases testing/<feature>/cases.yaml \
  --statuses testing/<feature>/runs/statuses.json \
  --profile <profile-path>
```

Always pass `--profile`. Without it the script assumes the canonical status names, which are wrong for any host that renamed them.

Run exactly the case IDs in `executable[]`. Report `held[]` with each reason, and surface every warning. Do not decide eligibility yourself from the status names.

**Design approval persists across builds.** Four lifecycle states execute: `approved_for_execution`, `approved`, `retest`, and `under_review`. A case QA approved re-runs on the next build, which is what makes this a regression suite rather than a one-shot. `case_review` and `rejected` never execute, and `quarantined` is excluded unless you pass `--include-quarantined`, which is for verifying a hardening fix.

Those are lifecycle keys, not status names. What this host calls each one lives in the profile's `clickup.statuses`, so read them from there when you talk to the user; the script does the matching. Each executable entry comes back with its `state`, so you never have to map a name yourself.

Nonzero exit means nothing is eligible, so **STOP** and show `held[]`. Running unapproved cases and publishing them defeats the gate that keeps hallucinated cases out of the record.

**Keep `statuses.json`.** `/qa-pilot:publish-results` passes it to the publish gate, which is what actually enforces approval. This step is a courtesy that saves a wasted run; the gate is the enforcement, because a step written only in prose is one a hurried session skips.

If ClickUp is unreachable, STOP rather than assuming approval.

## 3. Sandbox or deployed?

If the run targets the profile's `sandbox.mode` (e.g. `VITE_API_MODE=mocks`), this is a **stabilization run**. Allowed and useful, because mock backends are seeded and always succeed, which is what makes them a good place to shake out selectors without competing for the shared deployed environment. But say plainly, up front, that no verdict from this run is publishable, and stamp `api_mode` accordingly.

## 4. Read the deploy SHA, before the run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/read-env-sha.mjs" <profile> <env> <app>
```

Failure → STOP. A run whose SHA cannot be read can never be published, so running it wastes both the environment and the time.

## 5. Generate or update the specs

Specs live at `<apps.<app>.spec_dir>/<feature>/<CASE-ID>.spec.ts` and are **committed**. Follow `references/spec-conventions.md`. The rules that matter:

- One spec file per case; the case ID is the test title prefix so `parse-report.mjs` can map results back to cases.
- Selectors use the profile's `selectors.testid_attribute`. Where the app has no test IDs yet, add them to the app source as part of this work rather than binding to text or DOM structure, because a spec that binds to markup is a spec that rots.
- **Assertions follow the profile.** When `assertions.network_events: forbidden`, never use `waitForResponse`, `waitForRequest`, or route interception: on such hosts the operation never reaches the network layer, the wait no-ops, and the test passes whether or not the feature works. Assert on rendered UI state.
- Capture console output when `evidence.extra` includes `console_log`. On hosts where operations bypass the network, the console *is* the network tab, and it is what makes a failure triageable.
- Cross-app cases live in `cross_app.spec_home`'s spec dir and use `expect.poll` with `cross_app.propagation_window_s` as the ceiling. Eventual consistency is architecture, not flakiness.
- **Never overwrite a hand-stabilized spec without asking.** If a spec file already exists and differs from what you would generate, show the difference and let the user decide. Someone probably fixed a selector by hand.

Playwright config for the run, with `trace.mode` set from the profile's `evidence.capture`:

| `evidence.capture` | `trace.mode` | `video` | Effect |
|---|---|---|---|
| `always` (default) | `'on'` | `'on'` | Every executed case is reviewable. Costs roughly 700 KB per case and noticeable wall clock. |
| `on-failure` | `'retain-on-failure'` | `'retain-on-failure'` | A green run keeps nothing. Passing cases have no trace, so QA cannot sample them. |
| `off` | `'off'` | `'off'` | Fastest, and nothing can be published. For iterating on specs locally. |

**`video` must track the mode, not be left on `'on'`.** Playwright records and keeps videos
according to its own setting regardless of `trace.mode`, so leaving `video: 'on'` under
`on-failure` still records every case and still writes a `.webm` per pass, which throws away
most of the saving. Measured on a 3-case run: 50 KB kept with `video: 'on'`, 0 KB with both
set to `retain-on-failure`.

```js
use: {
  trace: { mode: <from the table>, sources: false },  // sources: false trims ~22%
  video: <from the table>,         // embedded in the trace; never uploaded separately
  screenshot: 'only-on-failure',
},
retries: 1,
reporter: [['json', { outputFile: 'results.json' }], ['html', { open: 'never' }]],
```

**Record the mode in `meta.json` as `evidence_capture`.** The publish gate needs it to tell a deliberately uncaptured pass from a lost artifact, and it refuses the run outright when the mode was `off`.

If the host is on `on-failure`, say so in your run summary: a false pass in that run cannot be caught by review, because there is nothing for QA to open.

Do not turn off `screenshots` within the trace to save space. It is roughly 95% of the file size and it is exactly what a reviewer scrubs through. Reach for `evidence.capture` instead, which is the knob designed for this trade.

**The trace is the evidence.** `validate-report.mjs` refuses to publish any executed case without one, because a trace carries the video byte-for-byte, the console output, the screenshot film-strip, the DOM snapshots and the network log in a single file. Keep `video: 'on'`, because the trace embeds the recording only when video is being captured, but the standalone `.webm` is never uploaded anywhere; the trace supersedes it.

## 6. Stabilize new specs before they count

A spec that has never run gets **three consecutive green runs in the sandbox** before its first deployed-environment run is treated as evidence. Track this in `testing/<feature>/run-log.json`. This is cheap insurance against publishing a verdict from a spec that was simply lucky.

## 7. Run

```bash
npx playwright test <spec paths> --reporter=json,html
```

Run from the app's repo root. Then read the deploy SHA **again**.

**If the SHA changed, every case in the run is `blocked`.** Half the cases tested one build and half another; no verdict from that run is trustworthy. Say so, and tell the user to re-run once the deploy settles.

## 8. Record the run

Write `testing/<feature>/runs/<run_id>/meta.json`:

```json
{
  "run_id": "<ISO timestamp>-<feature>-<short sha>",
  "feature": "...", "app": "...", "env_name": "...", "env_url": "...",
  "api_mode": "server | mocks",
  "sha_before": "...", "sha_after": "...", "sha_source": "<url>",
  "sha_format": "commit | build-id",   // copy read-env-sha's `format` verbatim
  "evidence_capture": "always | on-failure | off",   // from the profile's evidence.capture
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

**It has to be tracked by git**, and a host that gitignores `testing/` will silently lose it:

```bash
git ls-files --error-unmatch testing/<feature>/specs.json
```

If that fails, warn the user directly. Without this file, `parse-report.mjs` records no `spec_sha`, so every passing case goes back for review on every run and CI can run nothing at all. It fails quietly, which is why it is worth checking rather than assuming.

`parse-report.mjs` hashes those files so each verdict records the spec that produced it. That hash is what lets an approved case keep its approval when it passes again unchanged, what sends it back for review when someone edited the spec, and what CI uses to run only what QA actually approved.

Copy the Playwright JSON report next to `meta.json`. `/qa-pilot:publish-results` reads them together.

## 9. Apply the flake protocol

- **A case that failed and passed on retry is `flaky`, never `pass`.** This is not negotiable and `parse-report.mjs` enforces it deterministically. Do not report it as a pass in your summary either.
- Flaky cases are quarantined: they stay in the confidence denominator (lowering the score is the point) and get assigned for hardening.
- Cases crossing a declared propagation window are exempt from duration-based flake suspicion.
- **If more than 10% of cases are `blocked`, the run is halted.** Do not proceed to publish. Blocked means the environment failed, not the feature, so fix the environment and re-run.

## 10. Report and hand off

Summarize: counts by verdict, the SHA and environment, anything excluded for lack of approval, and any spec that needed hand-fixing. Then point at `/qa-pilot:publish-results <feature>`.

Commit the specs. They are the asset: CI regression comes free from specs that accumulated as a side effect of normal testing, which is how this survives the crunch it was built for.
