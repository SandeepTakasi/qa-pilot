QA-Pilot can run a committed suite against a production deployment, under rules that are refusals, not advice: the profile validator, the run step, the write guard and the publish gate each stop the thing they are responsible for. This page follows the rules in the order a production run meets them, and ends with what they cannot prove.

## Declare what the environment is

Every environment in the host profile carries a `kind`. The tool does not guess from the hostname, because `https://app.example.com` reads as non-production to a hostname heuristic.

| `kind` | Means | Consequence |
|---|---|---|
| `qa` | A shared test deployment | Traces stay on the executor's machine by default (`evidence_upload: reference`); attaching them to the tracker is an opt-in. |
| `staging` | A pre-release deployment | The same as `qa`. |
| `production` | Real users and real data | Every rule on this page applies. |

A URL that looks like production on an environment whose kind is not `production` is a warning, not an error: the declared kind wins, and the warning is there to catch a mistyped kind. The old `allow_production` switch was retired in 0.3.0; a profile that still sets it fails with `retired in 0.3.0; declare kind: production`.

## A production profile

When any environment has `kind: production`, the profile is valid only if all four of these hold. Each is an error:

- that environment's `evidence_upload` is `local` (its default), not `tracker` or `reference`;
- `evidence.capture` is `always`;
- a `mutation` block is present with at least one `write_signatures` entry;
- that environment's `test_account` is a string of at least 20 characters after trimming.

The relevant part of a generic profile follows; the full contract is in the [host profile reference](../../qa-pilot/schemas/qa-pilot.config.schema.md).

```yaml
environments:
  production:
    kind: production
    test_account: qa-runner@example.com, its own tenant, no admin rights, no billing
    apps:
      storefront: https://app.example.com
    sha_source:
      url: https://app.example.com/version.json
      json_path: commit

evidence:
  capture: always

mutation:
  deny_controls:
    text: ['^place order$']
  write_signatures:
    - method: POST
      url: 'https://app\.example\.com/api/'
      note: every POST under /api is a write unless allowed below
    - method: DELETE
      url: 'https://app\.example\.com/api/'
  allow_signatures:
    - method: POST
      url: 'https://app\.example\.com/api/search$'
      note: search is a POST but only reads
```

`sha_source` identifies the deployed build. QA-Pilot reads it before the run and again after, and every verdict is stamped with that build. If the two reads differ, every case in the run is `blocked`.

## The restricted account

A production run signs in as a real account, and that account's own permissions are what actually bound the run: an account that cannot change data cannot be made to by a missed button. So the profile names the account and how it is restricted in `test_account`, required on every production environment. A missing, non-string or too-short value fails the whole profile, so every command refuses to run:

> `environments.<env>.test_account: required on a production environment, at least 20 characters. Name the account the runs use and how it is restricted (its own tenant, no admin rights, no billing). The write guard is the second layer, not the boundary.`

On `qa` and `staging` it is optional, with the same length rule when present. The write guard is a second layer under the account: it is only as complete as the host's signature inventory, and a write no signature matches is a write it does not see. `test_account` is an attestation. Nothing checks it against the saved login, so it records a claim that QA reviews, not a proven one.

## Evidence stays local

A Playwright trace records the session credential that authenticated the run, every request and response body the run touched, and DOM snapshots of every page state. The credential can include a long-lived refresh token: a Firebase refresh token stays valid until the account is disabled, deleted or changed, so whoever holds a leaked trace can keep minting sessions for that account long after the run. If a trace leaks, disable or rotate the test account; deleting the file does not un-leak it. On production that is live data, so a production trace stays on the machine that ran it:

- **The profile refuses to upload it.** `evidence_upload: tracker` or `reference` on a production environment is a profile error. The effective value defaults to `local`.
- **The run step refuses to commit it.** `/qa-pilot:run-tests` stops before anything runs unless the run directory is gitignored (`git check-ignore -q testing/<feature>/runs/x`), and tells you to ignore `testing/*/runs/` when it is not. The same check applies off production whenever evidence stays on the machine.
- **CI refuses to run it.** See [CI refuses production](#ci-refuses-production).
- **The tracker does not receive it.** See [What the tracker receives](#what-the-tracker-receives).

Because the trace stays on the executor's machine, it is pinned by hash. The gate requires a `trace_sha256` for every locally kept trace, re-hashes the file, and refuses a mismatch (rule 6). A reviewer finds the evidence at the path the tracker records and checks it against the hash. [Setting up ClickUp](../../qa-pilot/SETUP-CLICKUP.md) lists what a trace contains.

Off production the default is the same: `reference` sends the verdict fields, the failure text, and each trace's path and sha256, never the file. Attaching the trace (`tracker`) is an opt-in per environment, to make only after turning on ClickUp's Private Attachment Links (without it, attachment links are public and non-expiring) and only with a restricted test account.

## Full capture

`evidence.capture: always` keeps a trace for every executed case, and production requires it. A failure evidences itself through its error message; a pass is a claim that something works, and QA can only open a pass that has a trace. The gate reads the requirement from the profile, so a production report whose `evidence_capture` is not `always` is refused. Full capture costs roughly 700 KB per case and noticeable wall clock.

## The mutation policy

Each feature declares what its specs may change, in `testing/<feature>/cases.yaml`:

```yaml
mutation:
  policy: scoped-write
  prefix: qa-e2e-
```

| `policy` | A write control (save, delete, ...) | A request matching a write signature | Publishable when |
|---|---|---|---|
| `read-only` | blocked | aborted | the run recorded no blocked and no observed write |
| `scoped-write` | allowed only inside the scope, blocked elsewhere | allowed, recorded as observed | the run recorded no blocked write |
| `unrestricted` | allowed | allowed | always, but not on production |

A `cases.yaml` with no `mutation` block is `unrestricted`, which keeps 0.2.0 case files valid on `qa` and `staging`. On production it is refused twice: `/qa-pilot:run-tests` will not start it, and the publish gate refuses a report that ran one anyway (the run step refuses first because the gate only sees a run after its writes have happened).

Under `scoped-write`, a write control is allowed when the page URL matches a scope URL the spec set with `setScope({ url })`, or when the control's own row or dialog contains the feature's `prefix`, so entities the feature creates must carry the prefix in their name. A request cannot be proved in scope, so write requests are recorded, not judged. The rules are in the [cases file reference](../../qa-pilot/schemas/cases.schema.md).

## The write guard

The guard is a Playwright fixture, `write-guard.fixture.ts`, that specs import `test` from instead of `@playwright/test`. On production every spec and fixture spec must do so, and `/qa-pilot:run-tests` copies the two guard templates into the spec directory once so they can be committed.

Specs call an ordinary `locator.click()`; the guard decides in two places:

- **In the page.** Capture-phase listeners injected before any app script runs judge clicks, submits and Enter or Space key presses before the application sees them.
- **At the network layer.** A route judges every request against the host's `write_signatures`. A spec's own route handlers are wrapped so the guard decides first.

Under any policy but `unrestricted`, the request paths a spec would reach for outside the guarded page (the `request` fixture, `page.request`, `fetch()`, `browser.newContext()`, `launch` and so on) are refused. For cross-app specs, `newGuardedContext()` replaces `browser.newContext()`.

Each test attempt leaves a `writes.json` beside its trace: the guard's record, and what the gate reads. Its `installed` field is true once the page-side guard has reported in, and a worker that dies before teardown writes no record, which the gate reads as not installed. The fields are in the [report and gate reference](../../qa-pilot/schemas/report.schema.md); the Playwright behaviours the guard relies on are in [Write guard internals](../../docs/architecture.md).

## write_signatures

The guard needs two things from the host: which controls are writes, and which requests are writes. Controls come with generic defaults (verbs such as save, delete, publish, submit, upload and rename, plus generic icon names), and `deny_controls` adds to them without replacing them. Requests have no safe default, because URL and method alone cannot always tell a write from a read. A request is a write when it matches any `mutation.write_signatures` entry and no `allow_signatures` entry.

Each entry has a required `method` (an uppercase HTTP method, or `*`), a required `url` regex matched against the full request URL, an optional `body` regex (for GraphQL and RPC-style backends that put every operation on one URL) and an optional `note`. The field rules are in the [host profile reference](../../qa-pilot/schemas/qa-pilot.config.schema.md).

Write signatures are default-deny per channel ([decision 0001](../../docs/decisions/0001-write-signatures-default-deny.md)). For every channel where reads and writes share a method and host, write one signature that matches the whole channel and list the reads in `allow_signatures`. A new operation is then blocked and appears in `writes.json` instead of passing silently, and a read-only run that touches a new read is refused and names it. Anchor allow entries to their host, because an allow entry overrides every write signature.

Unknown keys under `mutation`, `deny_controls` or a signature are errors, and every regex must compile, so a misspelt `write_signature` cannot leave the guard with no signatures and no complaint.

## What the gate re-reads

`validate-report.mjs` does not take the report's word for the write record. It reads three things from the profile (the environment's `kind`, its effective `evidence_upload`, and its `mutation` block) and the feature's policy from `--cases`, not from the report. It then rebuilds each case and fixture from the Playwright `results.json` and the `writes.json` files on disk and refuses any field that differs. The rules that matter on production:

- **Rule 1.** The report's policy and prefix must equal the `cases.yaml` declaration, and `unrestricted` is refused on production.
- **Rule 1b.** Each write record must equal the aggregate recomputed from the files on disk, so a report cannot drop the attempt that wrote.
- **Rule 2.** The guard was live: every executed case has a record with `installed: true`, `routed_requests > 0`, and a `write_signatures` count equal to the profile's.
- **Rule 3.** A read-only run that recorded any write is refused, for example `rule 3: read-only run recorded 2 write(s) in cases[CHECKOUT-ORDER-003]`.
- **Rule 4.** A scoped-write run that was blocked outside its scope is refused.
- **Rule 6.** A trace kept on the machine needs a matching `trace_sha256` and a relative path inside the run directory.

Each refusal message starts with its rule number. When one fires, nothing is written to the tracker.

## What the tracker receives

A production run publishes with no application data. `scripts/publish-payload.mjs` computes everything a publish sends, and the skill posts what it prints. For an environment whose effective `evidence_upload` is `local`, each case task receives `case_id`, `verdict`, `target_status`, `env_name`, `build_id` (the `commit_sha`), `run_id`, and `trace_path` (relative to the run directory) with `trace_sha256`.

The run summary carries run id, environment name, build id, counts by verdict, blocked percentage, confidence score and readiness, plus `requirement_coverage` (counts and the ids of requirements not yet proved, not criterion text) when the cases file declares them and they are lint-clean. It carries no attachment, failure text, console text, absolute path or executor. A bug filed from such a run names the case id, run id, environment, build id, trace path and sha256, and no failure text.

Under `tracker: none`, nothing is sent anywhere; approvals, the run summary and bugs are local files.

## CI refuses production

The CI template reads the environment's `kind` from the profile and stops if it is `production`, because a CI job uploads build artifacts and a production trace carries a live session and every request body it touched. Production runs are made by a person, with evidence kept on their machine. See [Running in CI](../../qa-pilot/SETUP-CI.md).

## Reviewing production evidence

QA reviews production traces on the executor's machine, or at a location the host chooses, and checks each against its `trace_sha256`. Open one with `npx playwright show-trace <path>`, or at <https://trace.playwright.dev>, which runs in the browser and transmits nothing. Treat the trace as a credential wherever it is opened.

The sampling quotas cannot be met from the tracker alone, and `/qa-pilot:qa-review` records them as unmet when the reviewer cannot reach the machine. The quotas are in the [reviewing guide](../../qa-pilot/skills/qa-review/SKILL.md).

## How strong these gates actually are

Precision matters here, because "impossible" would be overselling it.

The checks above are deterministic scripts, so a rushed developer cannot skip them by accident, which is the failure mode this system is built for. What they verify is that a report is internally consistent and that its evidence exists on disk. They do not cryptographically bind a report to a Playwright run that actually happened.

So someone determined to fabricate a green result could hand-write the inputs, and nothing here stops that. QA-Pilot makes the evidenced path the path of least resistance, not the only conceivable one.

Sampling does not close that gap. It has QA open a share of passing evidence (100% of P0, at least 30% of P1, at least 10% of P2) plus every failure, which checks that the recorded evidence shows what the case claims. A pass that rests on a weak assertion looks green in its trace, so the guard against false passes is the spec lint (no assertion, no fixed sleeps, no skipped tests) and QA's review of the cases, not sampling.

Specific ceilings, each stated in the code or the schemas:

- **The environment name is taken on trust.** `env_name` comes from the report, as the deploy SHA does, because nothing in the run directory identifies the environment independently. A report relabelled to another registered environment is a known ceiling. The planned fix is for the guard to record the request origins it saw and for the gate to match them against the registered app URLs.
- **The restricted account is an attestation.** QA owns keeping the account restricted.
- **The guard is only as good as the signatures.** This is why decision 0001 asks for a replay check next to the profile that judges every live operation name against the guard's own functions.
- **Some actions are not seen.** Among them: drag-and-drop, pointer handlers that act before click, keyboard activation other than Enter or Space, WebSocket frames, `routeFromHAR`, popups outside the guarded context, and Node's own `node:http` and `node:net`. Deliberate subversion of the guard is left to review. The full list is in the header of [`write-guard.fixture.ts`](../../qa-pilot/templates/write-guard.fixture.ts).
- **An agentic session has nothing to publish with.** It cannot produce a trace or a machine-readable result, so "Claude clicked through it and it looked fine" does not reach the record by the normal route. That is a practical barrier, not a mathematical one.

For the wider list of what the plugin requires of a host, and what swapping each piece would cost, see [What it enforces](../../qa-pilot/DECISIONS.md).
