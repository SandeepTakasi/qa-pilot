# Changelog

## 0.4.0 (2026-10-07)

### Upgrading from 0.3.1

One change will stop an existing setup working until you act on it; a second can leave a CI job
quietly doing the wrong thing.

1. **A production environment must declare `test_account`.** The field is a string of at least
   20 characters naming the account the runs use and how it is restricted. Without it the
   whole profile is invalid, so every command and every CI job fails, CI against `qa` or
   `staging` included: the template validates the profile first, and a profile with a
   production environment is invalid as a whole whichever environment a job targets. The
   error reads:

   ```
   environments.<env>.test_account: required on a production environment, at least 20 characters. Name the account the runs use and how it is restricted (its own tenant, no admin rights, no billing). The write guard is the second layer, not the boundary.
   ```

   An example value: `test_account: "qa-runner@example.com, own tenant, no admin rights, no billing"`.
   On `qa` and `staging` the field is optional, and when present it must also be at least 20
   characters.
2. **Move a CI pin to v0.4.0 once the account is in place.** A job pinned below 0.4.0 silently
   ignores `--priority`, since the older `ci-gate.mjs` only reads the flags it knows, and runs
   every approved spec: a job that sets `PRIORITY: P0` looks like a P0 job and is not. The
   template now pins `ref: v0.4.0`; re-copy it, and add `test_account` first or the pinned
   job fails on the profile.

Everything else in this release is backward compatible: `requirements` and `covers` are
optional, and a cases file without them lints, reports and scores exactly as under 0.3.1;
`PRIORITY` is empty by default, which runs every approved spec as before.

### Restricted accounts on production

The write guard is the second layer; the account is the boundary. A restricted account (its
own tenant, no admin rights, no billing) cannot change data however a click is judged, whereas a
signature list is only as complete as the host's inventory. `test_account` is an attestation:
nothing checks it against the login a profile saved, so QA owns keeping the account restricted.

### Requirement coverage

- **`requirements` and `covers` in `cases.yaml`.** A feature may declare its requirements, each
  with acceptance criteria, independently of its cases, and a case claims the criteria it tests
  with `covers: [<requirement id>/<criterion id>]`. Both keys are optional.
- **A lint.** `validate-cases.mjs` reports a malformed block, a dangling `covers` entry and
  `covers` with no `requirements` as errors, and a criterion that no case covers as a
  warning, since that is a design gap QA decides on, not a mistake.
- **Four states per criterion**, decided in this order: `uncovered` (no case covers it),
  `failing` (a covering case failed or was flaky), `proved` (a covering case passed and QA
  approved the verdict), and `unproved` (everything else, a blocked case included). A
  failure is never hidden by another case's pass.
- **`requirement_coverage` in the run summary**, in every publishing mode (`tracker`, `local`
  and `none`): the criterion counts per state plus `not_proved`, the ids of the requirements
  with a criterion not yet proved. Ids and counts only, never criterion text or requirement
  titles, so it is safe on production. It is absent when the cases file declares no
  requirements or its block is malformed.
- **The confidence score is unchanged.** Coverage is reported beside it and does not feed it.

### Priority runs

- **`ci-gate.mjs select --cases <cases.yaml> --priority <P0[,P1[,P2]]>`** keeps only the
  approved specs whose case has one of those priorities. Priority lives in `cases.yaml`, not
  in the approval ledger, so `--priority` without `--cases` is refused, as are an unknown
  priority, a missing cases file and an empty list element.
- **It refuses to go green on nothing.** If no approved spec at that priority is runnable,
  `select` exits 1 rather than letting the job report success having proved nothing.
- **The CI template gains a `PRIORITY` setting.** Empty runs everything approved; `P0` runs the
  P0 cases. The recommended split is P0 on every deploy and everything on the nightly
  schedule; promoting a case to P0 moves it into the deploy job with no workflow change. See
  `SETUP-CI.md`.

## 0.3.1 (2026-10-06)

### Fixes

- **The ClickUp guard now blocks only writes to QA-Pilot's own case tasks.** In 0.3.0 it
  blocked every ClickUp write in a repo that has a host profile, so ordinary work there
  (bug tickets, comments, attachments, status changes on unrelated tasks) needed the skills'
  write flag. It now blocks a write only when the tool input names a task ID recorded in one
  of the repo's `testing/*/clickup-map.json` files, wherever in the input the ID appears
  (`task_id`, `task_ids`, links, a task URL, `#id`). Creating tasks, editing lists and
  touching any other task always pass. The skills still open the guard with the write flag
  before changing their own tasks, so nothing about publishing or review changes.
  A missing or malformed case map owns nothing and is skipped.

## 0.3.0 (2026-10-01)

### Upgrading from 0.2.0

These changes will stop an existing setup working until you act on them. Each one closes a
gap, mostly around running against production safely.

1. **Every environment must declare `kind: qa | staging | production`.** The profile no
   longer guesses production from the hostname: the guess missed `app.<domain>.com`, the
   commonest production shape. A production-looking URL on a non-production kind is now a
   warning, never an error.
2. **`allow_production` is retired.** A profile that still sets it, to anything, fails with
   "retired in 0.3.0; declare kind: production".
3. **A production environment brings rules with it.** `evidence.capture` must be `always`;
   `evidence_upload: tracker` on it is refused, since its traces stay local; a `mutation`
   block with at least one `write_signatures` entry is required; and `/run-tests` refuses a
   production run unless `testing/*/runs/` is gitignored and the feature declares a
   `mutation.policy` other than `unrestricted`.
4. **`validate-report.mjs` now requires `--cases <cases.yaml>`, on every environment.** It
   is the only source of the feature's mutation policy and fixtures, and the gate takes
   neither from the report. A report with no `env_kind`, which every 0.2.0 run has, is
   refused: re-run with 0.3.0 rather than re-publishing an old run.
5. **The CI template exports `QA_PILOT_MUTATION`** from `testing/$FEATURE/cases.yaml`, plus
   `QA_PILOT_MUTATION_CONFIG` from the profile, reads `evidence.capture` from the profile
   instead of hard-coding `on-failure`, gives each run its own directory, and refuses an
   environment whose kind is `production`. Re-copy it rather than patching your copy.
6. **Node 20 or newer.** Node 18 is end-of-life.
7. **Move the reporters out of your Playwright config.** `/run-tests` now passes
   `--reporter=json,html` on the command line with per-run output paths
   (`PLAYWRIGHT_JSON_OUTPUT_NAME`, `PLAYWRIGHT_HTML_OUTPUT_DIR`, `--output`, all absolute), and
   a JSON `outputFile` in the config would override them and send every run to the same file.
   If you declare shared fixtures, scope the fixture projects' `testMatch` to
   `` `**/${process.env.QA_PILOT_FEATURE}/FIXTURE-*.setup.ts` `` (and `.teardown.ts`), as the
   run-tests skill shows: dependency and teardown projects ignore the command line's spec list,
   so unscoped they would run every feature's fixtures on every run.
8. **`parse-report.mjs` writes `report.json` into the run directory by default**, and the
   trace paths in it are relative to that directory. It no longer prints the report to
   stdout when `-o` is absent.

Nothing else requires action. Hosts that keep evidence local on any environment add three
text fields in ClickUp (`Run ID`, `Trace Path`, `Trace SHA256`; see `SETUP-CLICKUP.md`).

### Production, safely

- **The write guard.** A feature declares `mutation.policy`: `read-only`, `scoped-write`
  with a name prefix, or `unrestricted` (the default, so 0.2.0 case files stay valid off
  production). `templates/write-guard.fixture.ts` enforces it with no help from the specs:
  capture-phase listeners injected before any app script judge clicks, submits and
  Enter/Space in the page; the network route judges every request against the host's
  `write_signatures`, which can match the request body, so a GraphQL mutation is told
  apart from a query on the same URL. Specs' own route handlers are wrapped so the guard
  always decides first, and `unroute` / `unrouteAll` remove only the spec's own handlers.
  Under any policy but `unrestricted` every request path a spec would reach for is refused:
  the request fixture, `page.request` and `context.request`, `request.newContext()` from
  `@playwright/test`, Node's global `fetch()`, `browser.newContext()` and
  `browser.newPage()` (also from `beforeAll` and `beforeEach`), and every browser type's
  `launch` and `connect`. `newGuardedContext()` replaces `browser.newContext()` for
  cross-app specs. The page cannot widen the scoped-write scope or hide a blocked click.
  **What spec authors will notice:** every guarded test gets a browser context even if it
  never asks for a page, and a page made in `beforeAll` can no longer be shared across
  serial tests; use the per-test `page`. Node's `node:http`, `node:https` and `node:net`
  are not seen by the guard and must not be used from a guarded spec.
- **The gate re-reads everything.** Each attempt leaves a `writes.json`; the publish gate
  rebuilds every case and fixture from the Playwright report and those records on disk,
  sweeps the run directory for records the report does not account for, and refuses any
  field that differs. A read-only run that recorded a write, a scoped-write run that was
  blocked, or a guarded run whose guard never reported in does not publish.
- **Local evidence.** `environments.<env>.evidence_upload: tracker | local`, `local` by
  default on production. Traces stay on the executor's machine and are pinned by sha256;
  the tracker receives only ids, verdicts, build, run and the trace's path and hash,
  computed by the new `scripts/publish-payload.mjs`, which the skill posts verbatim. Bugs
  from such a run carry no failure text.

### Also new

- **`tracker: none`.** The whole pipeline on local files: approvals in
  `testing/<feature>/statuses.json`, evidence local, bugs as markdown in the run directory.
- **Shared fixtures.** `cases.yaml` `fixtures` and `cases[].fixture`: one entity built by a
  `FIXTURE <name>` setup spec and worked inside by many cases, with an optional teardown.
- **Concurrent runs.** Every output lands under `testing/<feature>/runs/<run_id>/`, so two
  runs of the same feature no longer overwrite each other.
- **Documentation sources.** `context.sources` names docs or commands `/generate-tests`
  reads first; commands are confirmed with the user before their first run in a session.
  `/generate-tests` can author several features at once, one subagent each.
- **Stabilization off the sandbox.** `stabilization.env` names a non-production deployed
  environment where new specs may earn their three greens. Those runs are never published.
- **The ClickUp guard only acts in repos that use QA-Pilot.** Installed user-scope, it used
  to block ClickUp writes everywhere; it now acts only where a host profile exists.
- **`qa-init` never opens `.env*` files.** It finds variable names in the code that reads
  them and asks for the value.

### Fixes

- The bundled `yaml` is ISC licensed, not MIT; `THIRD_PARTY_NOTICES.md` carries its text.
- `spec-conventions.md` no longer claims the gate requires a separate console log (the
  trace satisfies it), and `run-tests` no longer contradicts its own capture table.

## 0.2.0 (2026-09-23)

### Upgrading from 0.1.0

Three changes will stop an existing setup working until you act on them. All three are
deliberate: each one closes a gate that could previously be walked past.

1. **`validate-report.mjs` now requires `--statuses`.** Pass the statuses file recorded at
   the start of the run. Without it the gate cannot tell an approved case from an
   unapproved one, and a gate that can be skipped by omitting a flag is not a gate.
2. **A profile registering a production-looking URL no longer validates.** Point the
   environment at QA or staging, or set `allow_production: true` on it to accept that runs
   will mutate real records and that traces carrying live session tokens will be uploaded
   to your tracker.
3. **The confidence score reads `Unknown` until you pass `--verdicts`.** Approval alone
   never meant the feature worked, and the old number said it did.

Nothing else requires action. `approved.json`, `specs.json` and `bugs.json` are new files
the skills write as you go.

### The defect path

A confirmed failure now becomes a bug. Previously the pipeline produced a fully evidenced
failure and dropped it: `qa-review` said "record it as such against the feature", which is
prose with no mechanism behind it.

- `scripts/bug-report.mjs` assembles each bug from `report.json` and `cases.yaml`. The
  failure text is Playwright's, verbatim. A model paraphrasing an error into a ticket
  reintroduces the unverifiable claim this pipeline exists to remove, and a developer who
  cannot trust the error in the ticket opens the trace instead, which buys nothing.
- Deduplicated through a `testing/<feature>/bugs.json` ledger, keyed by case ID
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
- `specs.json` moved from per-run to `testing/<feature>/specs.json`: the mapping does not
  vary per run, and CI reads it from the repo.
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

### Committing QA artifacts is a choice

Nothing is required to be committed, and no skill refuses over it. Keeping specs and
`testing/` out of a repo is a legitimate decision, so `/qa-pilot:qa-init` now prices each
file rather than forbidding it, and names the two coherent modes:

- **Local-only.** Approved cases, evidenced verdicts and the ClickUp record still work.
  CI, cross-machine reproduction and approval carry-forward do not.
- **Committed.** Ignore only `testing/*/runs/`, and everything works.

CI is the one part with a hard requirement, because it reads the specs and ledgers out of
the checkout and has no other source.

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
