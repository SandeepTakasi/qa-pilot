# Changelog

## Unreleased

### The defect path

A confirmed failure now becomes a bug. Previously the pipeline produced a fully evidenced
failure and dropped it: `qa-review` said "record it as such against the feature", which is
prose with no mechanism behind it.

- `scripts/bug-report.mjs` assembles each bug from `report.json` and `cases.yaml`. The
  failure text is Playwright's, verbatim. A model paraphrasing an error into a ticket
  reintroduces the unverifiable claim this pipeline exists to remove, and a developer who
  cannot trust the error in the ticket opens the trace instead, which buys nothing.
- Deduplicated through a committed `testing/<feature>/bugs.json` ledger, keyed by case ID
  plus a normalized failure signature. Digits are stripped before hashing, because
  Playwright errors carry timeouts and element counts that vary run to run while naming
  one defect. Without this, a weekly regression run refiles every open bug every week.
- Bugs link to their case through a native ClickUp task relationship rather than a twelfth
  custom field: a bug's lifecycle belongs to the developers, not to QA-Pilot.
- `clickup.bug_list` is optional. Unset, bugs land in the feature list and the script says
  so, so a first pilot is not blocked on ClickUp admin.
- `flaky` verdicts can be filed too, tagged `intermittent`. An intermittent product bug is
  real, and a ticket that hides the intermittency costs the developer their first hour.
- Removed the `feature-actually-broken` rejection tag, which contradicted the rule beneath
  it. Rejection means the test was wrong; a real break is an approved verdict plus a bug.

### CI runs the approved suite

The committed specs were only ever run by a human typing `/run-tests`, so the claim that
regression coverage accumulates as a side effect of normal work had nothing behind it.

- `scripts/ci-gate.mjs select` decides what CI runs from `approved.json` alone. CI cannot
  reach ClickUp (the lifecycle is driven over MCP by a model, and a build runner is
  neither) and now does not need to: the ledger is committed, names every case QA
  accepted, and carries the hash of the spec they accepted.
- A spec that no longer matches its approved hash is excluded rather than run. A green CI
  run against an unreviewed spec claims a human stands behind something no human read.
- `select` exits nonzero when nothing is runnable. A suite that passes having executed
  zero tests is the most expensive kind of false confidence.
- `ci-gate.mjs verdict` separates a regression from a broken environment, since paging the
  feature team because the QA box is down burns the credibility of the whole signal.
  `flaky` fails the build, like everywhere else here.
- `templates/qa-pilot-ci.yml` plus `SETUP-CI.md`, which is explicit that CI does not
  publish, that this is a post-deploy and nightly check rather than a PR check, and that a
  non-interactive login is host-specific work the plugin cannot do for you.
- `specs.json` moved from per-run to `testing/<feature>/specs.json` and is committed: the
  mapping does not vary per run, and CI reads it from the repo.
- `read-env-sha.mjs --sha-only`, so a CI step stays one line.

### Gates measure what they claim to measure

- Confidence requires an approved **pass**, not just approval, and reads `Unknown` rather
  than a number when no verdicts are in hand.
- An unchanged spec that passes again keeps its approval, judged by a per-verdict spec
  hash and an `approved.json` ledger.
- The publish gate checks recorded status instead of case-map membership, and refuses
  outright without `--statuses`.
- The assertion lint no longer loses to padding, and no longer flags "request form".
- Production environments are refused unless `allow_production` is set.

## 0.1.0 (2026-08-30)

First build. Implements PRD v1.0.

- `qa-init`, `generate-tests`, `run-tests`, `publish-results`, `qa-review`, `setup-profiles` skills
- Deterministic validators: host profile, cases, deploy SHA, report parse, publish gate
- ClickUp write guard (PreToolUse hook), so the scripted path is the only write path
- No third-party code except `scripts/lib/yaml.mjs`, a bundled copy of yaml@2 (MIT)

Evidence is hosted in ClickUp as a single `trace.zip` per case per run, rather than a
video attachment plus a linked trace plus a console log. Verified by inspecting a real
Playwright trace: it contains the video byte-for-byte, the console output and the
screenshot film-strip, so the three-file scheme stored the same bytes twice and split one
investigation across three places. Reviewers open traces at trace.playwright.dev, which
runs client-side and uploads nothing.

Deviations from the PRD, each forced by a verified constraint:

- Scripts are zero-dependency Node ESM (`.mjs`), not TypeScript, because a plugin must not
  require a build step or an npm install in the host repo.
- **The qa-skills fork was dropped.** The PRD called for forking and vendoring
  neonwatty/qa-skills, on the assumption we would adopt its converters, generators,
  playwright-runner and CI scaffolding. All of those were skipped for good reasons, leaving
  only four reference documents: nothing referenced them, they were largely mobile and
  iOS guidance for a desktop-web pipeline, and they carried no network-assertion ban plus a
  hardcoded sync timeout that contradicts our profile-driven ceiling. Our own
  `spec-conventions.md` and `case-style.md` cover the relevant ground, profile-aware.
- `/setup-profiles` keeps the upstream *approach* (headed browser, human logs in once,
  session reused) but is written from scratch. Upstream captures via
  `playwright-cli state-save`, which omits IndexedDB and so loses Firebase auth. Replaced
  with `save-storage-state.mjs` using `storageState({ indexedDB: true })`.
  The capture is run by the **user**, in their own terminal, and the skill hands them a
  fully-resolved command rather than running it. An agent's Bash tool has no interactive
  terminal, so the sign-in prompt could never resolve; the script now detects that before
  launching a browser it would orphan, and exits with the command to run.
- `publish-clickup.ts` is not a script. ClickUp writes are driven by skill instructions
  over MCP, with the deterministic work (parse, validate) staying in scripts.
- The write guard scopes by flag file rather than by ClickUp space; checking the target
  space would require an authenticated API call from inside a hook.
