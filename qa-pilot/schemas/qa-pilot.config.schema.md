# `qa-pilot.config.yaml`: host profile schema

The host profile lives in the **consuming repo**, is written by `/qa-pilot:qa-init`, and is owned by QA. Every other QA-Pilot skill refuses to run without a schema-valid profile, and warns (does not refuse) when it is not committed.

Enforced by `scripts/lib/profile.mjs`. Unknown top-level keys are an **error**.

```yaml
project: string                     # required, non-empty

tracker: clickup | none             # optional, default clickup. See "Working without a tracker".

apps:                               # required, >= 1 entry
  <app-name>:                       # one key per frontend, e.g. storefront, admin
    framework: string               # required, e.g. vue3-vuetify-vuex, react-mui
    spec_dir: string                # required, repo-relative dir for committed specs
    repo: string                    # required, path or URL to that app's repo

environments:                       # required, >= 1 entry
  <env-name>:                       # e.g. qa, staging, production
    kind: qa | staging | production # required. See "Environment kinds".
    apps:                           # required; keys must be a subset of apps{}
      <app-name>: <http(s) URL>     # base URL of that app in this environment
    evidence_upload: tracker | reference | local  # optional. See "Where evidence goes".
    test_account: string            # required when kind is production; optional otherwise.
                                    # At least 20 characters after trimming. See "Production test account".
    sha_source:                     # required: how the DEPLOYED build is identified
      url: <http(s) URL>            # required, e.g. https://qa.example.com/api/version
      json_path: string             # exactly ONE of json_path | regex
      regex: string                 #   json_path: dot path, e.g. build.commit
                                    #   regex: must contain one capture group
      format: commit | build-id     # optional, default commit. See "Identifying the deployed build".

stabilization:                      # optional. See "Where specs stabilize".
  env: <env-name>                   # a registered environment whose kind is not production

auth:
  model: dev-handoff | role-accounts | mixed   # required
  playwright_min: "<semver>"        # required, >= 1.51.0 (indexedDB storageState).
                                    # QUOTE IT: unquoted, YAML reads 1.60 as the number 1.6.
  storage_state:
    dir: string                     # optional, default ".playwright/profiles"
    indexed_db: true                # must be true (Firebase-style auth keeps tokens in IndexedDB)

assertions:
  network_events: allowed | forbidden   # required
  style: ui-state | mixed               # required; must be ui-state when network_events: forbidden

evidence:
  extra: [console_log]              # optional list; allowed values: console_log
  capture: always | on-failure | off  # optional, default always. See "How much evidence to capture".

selectors:
  testid_attribute: string          # required, e.g. data-testid
  policy_doc: string                # optional repo-relative path (warn if missing on disk)

models:
  generation_approved:              # required, >= 1 model id: the models QA trusts to author
    - claude-fable-5                # cases.yaml; validate-cases.mjs warns on any other
    - claude-opus-5

sandbox:                            # required: stabilization-only mode, never verdict-eligible
  mode:
    env_var: string                 # e.g. VITE_API_MODE
    value: string                   # e.g. mocks

context:                            # optional. See "Context sources".
  sources:
    - name: string                  # required, unique
      description: string           # required: what it holds and when to read it
      command: string               # exactly ONE of command | path
      path: string

mutation:                           # optional; required when any environment is production.
                                    # See "What counts as a write".
  deny_controls:                    # optional; ADDED to the generic defaults
    text: [<regex string>]          # matched case-insensitively against a control's label
    icons: [string]                 # icon class names, prefix match
  write_signatures:                 # >= 1 entry when mutation is required
    - method: string                # GET | HEAD | POST | PUT | PATCH | DELETE | OPTIONS | *
      url: <regex string>           # matched against the full request URL
      body: <regex string>          # optional; matched against the request body
      note: string                  # optional: why this is a write
  allow_signatures:                 # optional, same shape: reads that a write signature matches
    - ...

cross_app:                          # required when apps has > 1 entry
  propagation_window_s: integer     # 1..600, ceiling for expect.poll on cross-app flows
  spec_home: <app-name>             # which app's spec_dir hosts cross-app specs

clickup:                            # required when tracker is clickup; ignored when none
  plan_tier: free | unlimited | business | enterprise   # optional, read by nothing;
                                    # when present it must be one of these
  space: string                     # required, ClickUp space name for QA
  bug_list: string                  # optional: list that /qa-pilot:qa-review files bugs into.
                                    # Unset: bugs land in the feature list (the script warns).
  folder: string                    # optional, recommended: the folder holding feature lists.
                                    # Name it when the space has more than one folder.
  statuses:                         # optional, canonical names if omitted; all seven or none
    case_review: string             # authored, awaiting QA design review
    approved_for_execution: string  # design approved, never yet run
    under_review: string            # executed, awaiting QA verdict review
    approved: string                # verdict accepted; counts toward confidence
    rejected: string                # the test itself is wrong
    retest: string                  # needs another run
    quarantined: string             # flaky; held out, still in the denominator
```

## Environment kinds

Every environment declares what it is; nothing is guessed from the hostname.

| `kind` | Means |
|---|---|
| `qa` | A shared test deployment. |
| `staging` | A pre-release deployment. |
| `production` | Real users and real data. |

When any environment has `kind: production`, each of these is an **error**:

- its `evidence_upload` is `tracker` or `reference` (the error names the value; a trace carries the session credential and every request body)
- `evidence.capture` is not `always` (on production a pass is the claim most worth checking)
- no `mutation` block, or no `mutation.write_signatures` entry
- `test_account` is missing or too short

Production also changes publishing (no application data reaches the tracker) and requires every feature to declare a mutation policy other than `unrestricted`; those rules live in the case and report schemas.

A URL that looks like production (an apex domain, or a `prod`/`production`/`live` hostname) on a non-production kind is a **warning**: the declared kind wins. `allow_production` is rejected as an error; declare `kind: production`.

## Production test account

A production run signs in as a real account, and that account's own permissions are the only real bound on what the run does. `test_account` names the account and how it is restricted, for example `qa-runner@example.com, its own tenant, no admin rights, no billing`.

- Required when `kind: production`; otherwise optional. When present it must be a string of at least 20 characters after trimming, else an **error**. A `null` (empty `test_account:`) counts as present.
- The value is an **attestation**: nothing checks it against the saved login. QA owns keeping it true.

## Where evidence goes

`evidence_upload` decides whether a run's traces are attached to the tracker. A trace carries the session and can carry a long-lived refresh token, and ClickUp attachment links are public unless Private Attachment Links is on, so the default keeps traces off the tracker.

| Value | What happens |
|---|---|
| `tracker` | Opt-in per environment. The trace is attached to the case task. Turn on Private Attachment Links and use a restricted account first. |
| `reference` | Default off production. The tracker gets the same per-case fields and run summary as `tracker`, never the trace file, plus the case's `run_id`, `trace_path` and `trace_sha256`. The trace stays on the executor's machine, verified by sha256 and opened with `npx playwright show-trace <path>`. |
| `local` | Default on production. Nothing is attached and no application data reaches the tracker, which gets only the run-relative path and sha256. |

For `reference` and `local`, `/qa-pilot:run-tests` requires `testing/*/runs/` to be gitignored. The tracker needs Run ID, Trace Path and Trace SHA256 fields by default, since `reference` fills them on every case.

**When QA reviews on their own machine**, which is the usual setup for a team, `reference` leaves the traces where QA cannot open them. Verdicts and approvals travel through git either way (each publish commits `testing/<feature>/verdicts/<run_id>.json`), but traces do not. Set `evidence_upload: tracker` on the QA environment, after turning on Private Attachment Links and with a restricted account, or agree a shared location outside the tracker. Production stays `local` whatever you choose.

The loader resolves the effective value into the normalized profile, in this order:

1. `tracker: none` makes it `local` everywhere; an explicit non-`local` value is a **warning** (`environments.<env>.evidence_upload: <v> is ignored under tracker: none; evidence stays local`).
2. Otherwise the environment's own value (`tracker` or `reference` on production is an error).
3. Otherwise `local` for `kind: production`, else `reference`.

## How much evidence to capture

| `evidence.capture` | Kept | Consequence |
|---|---|---|
| `always` (default) | every executed case, about 700 KB each | QA can sample passes |
| `on-failure` | failures and flakes only | passes have no trace, so a false pass is undetectable by review |
| `off` | nothing | no run can be published; for iterating on specs locally |

Prefer `always` for new features and P0 cases. Any production environment requires `always`. The publish gate enforces whichever mode the run recorded.

## Where specs stabilize

A new spec needs three consecutive green runs before its first verdict run counts. By default those run in the sandbox (`sandbox.mode`). For flows the mock backend cannot model, `stabilization.env` names a deployed environment instead; it must be registered and not `production` (an **error** otherwise). `/qa-pilot:run-tests` never hands a stabilization run to `/qa-pilot:publish-results`; the publish gate cannot tell one from a verdict run, so this rests on run-tests.

## Context sources

`/qa-pilot:generate-tests` reads `context.sources` **first**, before the tracker task and the code, because documented intent is what an assertion should pin.

| Field | Rule |
|---|---|
| `name` | Required, non-empty, unique. |
| `description` | Required, non-empty. Say what it holds and which features it covers. |
| `command` | Non-empty shell command run from the repo root; its stdout is the context. Shown to the user and confirmed before its first run in a session. |
| `path` | Non-empty repo-relative file, directory or glob. A last segment matching `.env*` is an **error**; `.env*` files are never read through any `path`. |

Exactly one of `command` or `path` per source (an **error** otherwise). When `context` is present, `sources` must be a non-empty list.

## What counts as a write

A feature's cases declare whether specs may change data (`mutation.policy` in `cases.yaml`). The write guard enforces it in the browser and needs from the host which controls and which requests are writes.

**Controls.** The guard ships generic defaults (verbs such as save, delete, publish, submit, upload, rename; icons such as delete, trash, pencil, share). `deny_controls.text` and `deny_controls.icons` are added to them. Every regex must compile.

**Requests.** A GraphQL or RPC-style backend sends reads and writes to one URL, so a signature can also match the request body.

| Field | Rule |
|---|---|
| `method` | Required. Uppercase `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `*`. |
| `url` | Required regex, matched against the full request URL. |
| `body` | Optional regex, matched against the request body. A signature with `body` never matches a request with no body. |
| `note` | Optional string: why this is a write. |

`url` and `body` compile with `new RegExp(pattern)` (case-sensitive); `deny_controls.text` compiles with the `i` flag.

A request is a **write** when it matches any `write_signatures` entry and no `allow_signatures` entry (for reads that look like writes, such as a streaming read over POST).

**The write guard is the second layer, not the boundary.** On production the boundary is the restricted `test_account`. A write that no signature matches is a write the guard lets through (see `docs/decisions/0001-write-signatures-default-deny.md` in the QA-Pilot repository), and `test_account` is an unverified attestation, so QA owns keeping the account restricted and the signature list complete.

Unknown keys under `mutation`, `deny_controls`, a signature entry, `stabilization`, `context` or a `sources` entry are **errors**: a misspelt `write_signature` would otherwise leave the guard with no signatures. Keep host-specific patterns here, never in the plugin.

## Working without a tracker

`tracker: clickup` (default): the `clickup` block is required and validated.

`tracker: none` runs the pipeline on local files:

- the `clickup` block is optional; if present it is ignored with a **warning** and dropped from the normalized profile
- status names are the canonical seven (`Case Review`, `Approved for Execution`, `Under Review`, `Approved`, `Rejected`, `Retest`, `Quarantined`; case-insensitive)
- QA records decisions in `testing/<feature>/statuses.json` (`{"<CASE-ID>": "<status>"}`). `/qa-pilot:run-tests` reads it in place of the ClickUp fetch and copies it into the run directory as that run's approval record, which the publish gate's `--statuses` reads
- effective `evidence_upload` is `local` everywhere
- confirmed bugs are markdown files in the run directory

## Identifying the deployed build

Every verdict is stamped with the running build, and a run is blocked if it changes mid-flight.

**`commit` (default, preferred).** A git SHA. The environment must serve it, typically a `/version.json` written at image build time.

```yaml
sha_source:
  url: https://qa.example.com/version.json
  json_path: commit
```

**`build-id`.** Any stable per-build fingerprint the app already serves, such as a bundler content hash:

```yaml
sha_source:
  url: https://qa.example.com/index.html
  regex: 'assets/index-([A-Za-z0-9_-]+)\.js'
  format: build-id
```

`build-id` keeps mid-run deploy detection but names the bundle, not the commit, so tracing back to source needs your release records. The validator warns, and the report records `sha_format`. With code splitting, a deploy that changes only a lazy chunk may leave the entry hash unchanged and go undetected.

## Status names are per-host

The seven **keys** are the pipeline's lifecycle; the **names** are whatever your ClickUp calls them:

```yaml
clickup:
  statuses:
    case_review: to do
    approved_for_execution: ready to run
    under_review: ready for review
    approved: accepted
    rejected: rejected
    retest: retest
    quarantined: skip
```

Matching is case-insensitive and trimmed. Two keys may not share a name. Declaring only some keys is an error.

## Warnings (non-fatal, stderr)

- `selectors.policy_doc` set but missing on disk
- only one environment registered
- `evidence.extra` empty with `assertions.network_events: forbidden` (failures are video-only)
- a production-looking URL on a non-production kind
- a `clickup` block while `tracker: none`
- a non-`local` `evidence_upload` while `tracker: none`
- `sha_source.format: build-id`
- `evidence.capture: on-failure` (passes carry no trace to sample) or `off` (nothing can be published)
- `clickup.statuses` not declared (the canonical names are assumed)

## CLI

```bash
node qa-pilot/scripts/lib/profile.mjs <path-to-qa-pilot.config.yaml>
```

Exit 0: normalized profile JSON on stdout. Exit 1: one error per line on stderr.
