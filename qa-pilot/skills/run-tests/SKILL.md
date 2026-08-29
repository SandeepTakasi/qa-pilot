---
name: run-tests
description: Execute QA-approved test cases for a feature against a registered deployed environment — verify approval in ClickUp, read the deploy SHA before and after the run, convert approved cases into committed Playwright specs, run them with video, trace and console evidence, and apply the flake protocol. Verdicts come only from these runs; agentic browser sessions may author and debug specs but never adjudicate. Use when the user says "run tests", "execute the cases", or "/run-tests <feature> --env <name>".
argument-hint: "<feature> --env <name>"
---

# run-tests — execute approved cases and produce evidence

The committed Playwright spec is the durable asset here. It produces the verdict today and regresses the feature forever in CI. An agentic browser session can help you *write* one, but "Claude clicked through it and it looked fine" is exactly the unverifiable claim this pipeline exists to eliminate — and it leaves no script behind.

Recommended model: Sonnet-class is enough for straightforward spec authoring. Reach for a stronger model on cross-app multi-context specs and on stubborn flake triage.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP, print errors, point at `/qa-pilot:qa-init`. Confirm it is committed (`git ls-files --error-unmatch`).

## 1. Check the environment is registered

`--env <name>` must be a key in the profile's `environments`. If it is not, **STOP**: verdicts are only valid against registered deployed environments. Never substitute a localhost URL — a local stack is not the build the users will get.

Identify which app(s) the feature's cases target, and take their base URLs from `environments.<env>.apps`.

## 2. Approval gate

Read `testing/<feature>/clickup-map.json`. For each case, fetch its ClickUp task and check the status:

- `Approved for Execution` → include it
- anything else → **exclude it** and list it in your output with its current status

If no case is approved, STOP. QA approval before execution is the gate that keeps hallucinated cases out of the record; running unapproved cases and publishing them defeats it.

If ClickUp is unreachable, STOP rather than assuming approval.

## 3. Sandbox or deployed?

If the run targets the profile's `sandbox.mode` (e.g. `VITE_API_MODE=mocks`), this is a **stabilization run**. Allowed and useful — mock backends are seeded and always succeed, which is what makes them a good place to shake out selectors without competing for the shared deployed environment. But say plainly, up front, that no verdict from this run is publishable, and stamp `api_mode` accordingly.

## 4. Read the deploy SHA — before

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/read-env-sha.mjs" <profile> <env> <app>
```

Failure → STOP. A run whose SHA cannot be read can never be published, so running it wastes the environment and the time.

## 5. Generate or update the specs

Specs live at `<apps.<app>.spec_dir>/<feature>/<CASE-ID>.spec.ts` and are **committed**. Follow `references/spec-conventions.md`. The rules that matter:

- One spec file per case; the case ID is the test title prefix so `parse-report.mjs` can map results back to cases.
- Selectors use the profile's `selectors.testid_attribute`. Where the app has no test IDs yet, add them to the app source as part of this work rather than binding to text or DOM structure — a spec that binds to markup is a spec that rots.
- **Assertions follow the profile.** When `assertions.network_events: forbidden`, never use `waitForResponse`, `waitForRequest`, or route interception: on such hosts the operation never reaches the network layer, the wait no-ops, and the test passes whether or not the feature works. Assert on rendered UI state.
- Capture console output when `evidence.extra` includes `console_log` — on hosts where operations bypass the network, the console *is* the network tab, and it is what makes a failure triageable.
- Cross-app cases live in `cross_app.spec_home`'s spec dir and use `expect.poll` with `cross_app.propagation_window_s` as the ceiling. Eventual consistency is architecture, not flakiness.
- **Never overwrite a hand-stabilized spec without asking.** If a spec file already exists and differs from what you would generate, show the difference and let the user decide. Someone probably fixed a selector by hand.

Playwright config for the run — `video: 'on'`, `trace: 'on'`, `retries: 1`, JSON and HTML reporters. Video and trace are not optional: `validate-report.mjs` refuses to publish any executed case without them.

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
  "executor": "<the developer running this>",
  "model_version": "<your model id>",
  "playwright_version": "...", "browser": "chromium-<version>",
  "started_at": "...", "finished_at": "..."
}
```

Copy the Playwright JSON report next to it. `/qa-pilot:publish-results` reads both.

## 9. Apply the flake protocol

- **A case that failed and passed on retry is `flaky`, never `pass`.** This is not negotiable and `parse-report.mjs` enforces it deterministically — do not report it as a pass in your summary either.
- Flaky cases are quarantined: they stay in the confidence denominator (lowering the score is the point) and get assigned for hardening.
- Cases crossing a declared propagation window are exempt from duration-based flake suspicion.
- **If more than 10% of cases are `blocked`, the run is halted.** Do not proceed to publish. Blocked means the environment failed, not the feature — fix the environment and re-run.

## 10. Report and hand off

Summarize: counts by verdict, the SHA and environment, anything excluded for lack of approval, and any spec that needed hand-fixing. Then point at `/qa-pilot:publish-results <feature>`.

Commit the specs. They are the asset — CI regression comes free from specs that accumulated as a side effect of normal testing, which is how this survives the crunch it was built for.
