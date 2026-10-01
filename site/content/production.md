QA-Pilot can run a committed suite against a production deployment. It does so under rules that are refusals, not advice: the profile validator, the run step, the write guard and the publish gate each stop the thing they are responsible for. This page walks through those rules in the order a production run meets them, and ends with what they cannot prove.

Everything here is enforced by code in the repository. Where a rule lives is named, so each claim can be checked against the schema or the script.

## Declare what the environment is

Every environment in the host profile carries a `kind`. The tool no longer guesses from the hostname, because the guess was wrong in the commonest case: `https://app.example.com` reads as non-production to a hostname heuristic.

| `kind` | Means | Consequence |
|---|---|---|
| `qa` | A shared test deployment | Traces upload to the tracker by default. |
| `staging` | A pre-release deployment | Traces upload to the tracker by default. |
| `production` | Real users and real data | Every rule on this page applies. |

A URL that looks like production on an environment whose kind is not `production` is a warning, never an error: the kind you declared wins, and the warning exists so a mistyped kind is noticed. The old `allow_production` switch was retired in 0.3.0. A profile that still sets it fails with `retired in 0.3.0; declare kind: production`.

## A production profile

When any environment has `kind: production`, the profile is valid only if all three of these hold. Each is an error, not a warning:

- that environment's `evidence_upload` is `local` (the default for it), and never `tracker`;
- `evidence.capture` is `always`;
- a `mutation` block is present with at least one `write_signatures` entry.

Here is the relevant part of a generic profile with a `qa`, a `staging` and a `production` environment. The rest of the file (`apps`, `auth`, `assertions`, `selectors`, `models`, `sandbox` and the tracker block) is omitted; the full contract is in the [host profile reference](../../qa-pilot/schemas/qa-pilot.config.schema.md).

```yaml
environments:
  qa:
    kind: qa
    apps:
      storefront: https://qa.example.com
    sha_source:
      url: https://qa.example.com/version.json
      json_path: commit
  staging:
    kind: staging
    apps:
      storefront: https://staging.example.com
    sha_source:
      url: https://staging.example.com/version.json
      json_path: commit
  production:
    kind: production
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

`sha_source` is how the deployed build is identified. QA-Pilot reads it before the run and again after it, and every verdict is stamped with that build. If the two reads differ, every case in the run is `blocked`.

## Evidence stays local

A Playwright trace records the session credential that authenticated the run, every request and response body the run touched, and DOM snapshots of every page state. On production that is live data, so a production trace never leaves the machine that ran it:

- **The profile refuses to upload it.** `evidence_upload: tracker` on a production environment is a profile error. The effective value defaults to `local`.
- **The run step refuses to commit it.** `/qa-pilot:run-tests` stops before anything runs unless the run directory is gitignored. It checks with `git check-ignore -q testing/<feature>/runs/x` and tells you to ignore `testing/*/runs/` when that fails.
- **CI refuses to run it.** See [CI refuses production](#ci-refuses-production).
- **The tracker never receives it.** See [What the tracker receives](#what-the-tracker-receives).

Because the trace stays on the executor's machine, it is pinned by hash. The gate requires a `trace_sha256` for every locally kept trace, re-hashes the file, and refuses a mismatch (rule 6). A reviewer finds the evidence at the path the tracker records and checks it against the hash. The [Setting up ClickUp](../../qa-pilot/SETUP-CLICKUP.md) guide lists what a trace contains.

## Full capture

`evidence.capture: always` keeps a trace for every executed case. On production this is required, not recommended. A failure already evidences itself through its error message; a pass is a claim that something works, and the sampling rules in `/qa-pilot:qa-review` are what test that claim. With `on-failure`, passing cases have no trace, so QA cannot sample them and a false pass is undetectable by review.

The gate enforces this independently of the report. On a production environment a report whose `evidence_capture` is not `always` is refused, because the profile requires `always` there and the report is not the source. Full capture costs roughly 700 KB per case and noticeable wall clock.

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
| `unrestricted` | allowed | allowed | always, but never on production |

A `cases.yaml` with no `mutation` block is `unrestricted`. That default keeps 0.2.0 case files valid on `qa` and `staging`, and it is refused on production twice: `/qa-pilot:run-tests` will not start a production run of an `unrestricted` feature, and the publish gate refuses a report that ran one anyway. The run step refuses first because the gate only sees a run after its writes have happened.

Under `scoped-write`, a write control is allowed when the page URL matches a scope URL the spec set with `setScope({ url })`, or when the control's own row or dialog contains the feature's `prefix`. Entities a scoped-write feature creates must therefore carry the prefix in their name, or their own controls are blocked. A request cannot be proved in scope, which is why write requests under `scoped-write` are recorded rather than judged. The exact rules are in the [cases file reference](../../qa-pilot/schemas/cases.schema.md).

## The write guard

The guard is a Playwright fixture, `write-guard.fixture.ts`, that specs import `test` from instead of `@playwright/test`. On production every spec and every fixture spec must do so, and `/qa-pilot:run-tests` copies the two guard templates into the spec directory once so they can be committed.

It enforces the policy without the specs' cooperation. Specs call an ordinary `locator.click()`; the guard decides in two places:

- **In the page.** Capture-phase listeners injected before any app script runs judge clicks, submits and Enter or Space key presses before the application sees them. The page cannot widen the scoped-write scope or hide a blocked click.
- **At the network layer.** A route judges every request against the host's `write_signatures`. A spec's own route handlers are wrapped so the guard always decides first.

Under any policy but `unrestricted`, the request paths a spec would reach for are refused: the `request` fixture, `page.request`, `context.request`, `request.newContext()`, Node's global `fetch()`, `browser.newContext()`, `browser.newPage()`, and every browser type's `launch` and `connect`. For cross-app specs, `newGuardedContext()` replaces `browser.newContext()`.

Each test attempt leaves a `writes.json` beside its trace. It is the guard's record, and it is what the gate reads:

```json
{
  "installed": true,
  "policy": "read-only",
  "prefix": null,
  "scope_urls": [],
  "write_signatures": 2,
  "routed_requests": 38,
  "blocked": 1,
  "observed": 0,
  "events": [
    {
      "kind": "control",
      "action": "block",
      "reason": "\"Delete\" matches a deny word; policy read-only",
      "label": "Delete",
      "at": "2026-10-01T09:23:41.208Z"
    }
  ]
}
```

`installed` is true once the page-side guard has reported in. `blocked` and `observed` equal the number of events with that `action`, and the gate checks this. A worker that dies before the fixture's teardown writes no record, and the gate reads that attempt as not installed. The full field list is in the [report and gate reference](../../qa-pilot/schemas/report.schema.md), and the Playwright behaviours the guard relies on are in [Write guard internals](../../docs/architecture.md).

## write_signatures

The guard needs two things from the host: which controls are writes, and which requests are writes. Controls come with generic defaults (verbs such as save, delete, publish, submit, upload and rename, plus generic icon names), and `deny_controls` in the profile adds to them without replacing them. Requests have no safe default, because URL and method alone cannot always tell a write from a read.

That is what `mutation.write_signatures` is for. A request is a write when it matches any `write_signatures` entry and no `allow_signatures` entry.

| Field | Rule |
|---|---|
| `method` | Required. An uppercase HTTP method, or `*` for any. |
| `url` | Required. A regex, matched against the full request URL. |
| `body` | Optional. A regex matched against the request body. A request with no body never matches a signature that has one. |
| `note` | Optional. Why this request is a write. |

The `body` pattern exists because a GraphQL endpoint takes queries and mutations on one URL, and RPC-style backends send every operation as a POST. A signature with a `body` pattern tells them apart.

Write signatures are default-deny per channel ([decision 0001](../../docs/decisions/0001-write-signatures-default-deny.md)). For every channel where reads and writes share a method and host, write one signature that matches the whole channel and list the reads in `allow_signatures`. A new operation is then blocked and appears in `writes.json`, instead of passing silently. The safe direction is that a new read is blocked until someone adds it; a read-only run that touches it is refused and names it. Anchor allow entries to their host, because an allow entry overrides every write signature.

Unknown keys under `mutation`, `deny_controls` or a signature are errors, so a misspelt `write_signature` cannot leave the guard with no signatures and no complaint. Every regex must compile.

## What the gate re-reads

`validate-report.mjs` does not take the report's word for the write record. It reads three things from the profile (the environment's `kind`, its effective `evidence_upload`, and its `mutation` block) and the feature's policy from `--cases`, never from the report. Then it rebuilds each case and fixture from the Playwright `results.json` and the `writes.json` files on disk and refuses any field that differs. The rules that matter on production:

- **Rule 1.** The report's policy and prefix must equal the `cases.yaml` declaration, and an effective policy of `unrestricted` is refused on production.
- **Rule 1b.** Each write record must equal the aggregate recomputed from the files on disk. A `writes.json` that no listed file accounts for means the report dropped the attempt that wrote it, and is refused.
- **Rule 2.** The guard was live. Every executed case needs a record with `installed: true` and `routed_requests > 0`, and its `write_signatures` count must equal the number in the profile.
- **Rule 3.** A read-only run that recorded any write is refused, for example `rule 3: read-only run recorded 2 write(s) in cases[CHECKOUT-ORDER-003]`.
- **Rule 4.** A scoped-write run that was blocked outside its scope is refused.
- **Rule 6.** A locally kept trace needs a matching `trace_sha256`, and a relative path that stays inside the run directory.

Each refusal message starts with its rule number, so a test or a reviewer can tell which rule refused. Nothing is written to the tracker when any of them fires.

## What the tracker receives

A production run publishes with no application data. `scripts/publish-payload.mjs` computes everything a publish sends, and the skill posts only what it prints. For an environment whose effective `evidence_upload` is `local`, that is exactly:

| Field | From |
|---|---|
| `case_id` | `cases[].id` |
| `verdict` | `cases[].verdict` |
| `target_status` | the status transition for that verdict |
| `env_name` | the report's `env_name` |
| `build_id` | `commit_sha` |
| `run_id` | `run_id` |
| `trace_path` | `cases[].trace`, relative to the run directory |
| `trace_sha256` | `cases[].trace_sha256` |

The run summary carries exactly: run id, environment name, build id, counts by verdict, blocked percentage, confidence score and readiness. Nothing else is sent: no attachment, no failure text, no console text, no absolute path, no executor. A bug filed from such a run names the case id, run id, environment, build id, trace path and sha256, and no failure text.

Under `tracker: none`, nothing is sent anywhere. Approvals, the run summary and bugs are local files, and the bug file in the run directory keeps the failure text because it never leaves the machine.

## CI refuses production

The CI template reads the environment's `kind` from the profile and stops if it is `production`. A CI job uploads build artifacts, and a production trace carries a live session and every request body it touched. Production runs are made by a person, with evidence kept on their machine. The reasoning, and what CI does instead, are in [Running in CI](../../qa-pilot/SETUP-CI.md).

## Reviewing production evidence

Nothing is attached to the tracker, so QA reviews production traces on the executor's machine, or at a location the host chooses, and checks each against its `trace_sha256`. A trace opens by drag-and-drop at <https://trace.playwright.dev>, which runs entirely in the browser and transmits nothing, or locally with `npx playwright show-trace`. Treat the trace as a credential wherever it is opened.

The sampling quotas cannot be met from the tracker alone. A reviewer with no access to the executor's machine cannot meet them, and `/qa-pilot:qa-review` records them as unmet rather than reviewing the tracker record as if it were evidence. The quotas themselves are in the [reviewing guide](../../qa-pilot/skills/qa-review/SKILL.md).

## How strong these gates actually are

Precision matters here, because "impossible" would be overselling it.

The checks above are deterministic scripts, so a rushed developer cannot skip them by accident, and that is the failure mode this system is built for. What they verify is that a report is internally consistent and that its evidence exists on disk. They do not cryptographically bind a report to a Playwright run that actually happened.

So someone determined to fabricate a green result could hand-write the inputs. Nothing here stops that. QA-Pilot makes the evidenced path the path of least resistance, not the only conceivable one. The backstop for deliberate fabrication is QA's sampling: 100% of P0 passes, at least 30% of P1 passes, at least 10% of P2 passes, and every failure. A fake trace does not survive being opened.

Specific ceilings, each stated in the code or the schemas:

- **The environment name is taken on trust.** `env_name` comes from the report, as the deploy SHA does, because nothing in the run directory identifies the environment independently. A report relabelled to another registered environment is a known ceiling. The planned fix is for the guard to record the request origins it saw and for the gate to match them against the registered app URLs.
- **The guard is only as good as the signatures.** Requests are only as well classified as the host's `write_signatures`. This is why decision 0001 asks for a replay check next to the profile that judges every live operation name against the guard's own functions.
- **Some actions are not seen.** The guard does not see drag-and-drop, pointer or mouse handlers that act before click, keyboard activation other than Enter or Space, WebSocket frames, `routeFromHAR`, popups opened outside the guarded context, or frames other than each page's main frame for `setScope`. Node's own `node:http`, `node:https` and `node:net` are not refused either, and neither is calling a route method off the prototype to get past the guard. The last two are deliberate subversion rather than ordinary spec code, and review catches them. The list lives in the header of [`write-guard.fixture.ts`](../../qa-pilot/templates/write-guard.fixture.ts).
- **An agentic session has nothing to publish with.** It cannot produce a trace or a machine-readable result, so "Claude clicked through it and it looked fine" never reaches the record by the normal route. That is a strong practical barrier, not a mathematical one.

For the wider list of what the plugin requires of a host, and what swapping each piece would cost, see [What it enforces](../../qa-pilot/DECISIONS.md).
