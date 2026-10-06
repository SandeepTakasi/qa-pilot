# `qa-pilot.config.yaml`: host profile schema

The host profile lives in the **consuming repo**, is written by `/qa-pilot:qa-init`, and is reviewed and owned by QA. Every other QA-Pilot skill refuses to run without a schema-valid profile, and warns (rather than refuses) when it is not committed, since a host trialling the pipeline may reasonably keep it local at first.

Enforced by `scripts/lib/profile.mjs`. Unknown top-level keys are an **error** (catches typos silently changing behavior).

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
    kind: qa | staging | production # REQUIRED. What this environment is. See "Environment kinds".
    apps:                           # required; keys must be a subset of apps{}
      <app-name>: <http(s) URL>     # base URL of that app in this environment
    evidence_upload: tracker | local  # optional. Where traces go. Default: local when kind is
                                    # production or tracker is none, tracker otherwise.
                                    # tracker on a production environment is an error.
    test_account: string            # REQUIRED when kind is production: at least 20 characters
                                    # after trimming. Optional on other kinds; when present the
                                    # same length rule applies, with its own error message.
                                    # See "Production test account".
    sha_source:                     # required: how the DEPLOYED build is identified
      url: <http(s) URL>            # required, e.g. https://qa.example.com/api/version
      json_path: string             # exactly ONE of json_path | regex
      regex: string                 #   json_path: dot path, e.g. build.commit
                                    #   regex: must contain one capture group
      format: commit | build-id     # optional, default commit. See below.

stabilization:                      # optional. See "Where specs stabilize".
  env: <env-name>                   # a registered environment whose kind is not production

auth:
  model: dev-handoff | role-accounts | mixed   # required
  playwright_min: "<semver>"        # required, must be >= 1.51.0 (indexedDB storageState).
                                    # QUOTE IT: unquoted, YAML reads 1.60 as the number 1.6.
  storage_state:
    dir: string                     # optional, default ".playwright/profiles"
    indexed_db: true                # REQUIRED to be true, since Firebase-style auth persists
                                    # tokens in IndexedDB; false silently breaks profiles

assertions:
  network_events: allowed | forbidden   # required
  style: ui-state | mixed               # required; must be ui-state when network_events: forbidden

evidence:
  extra: [console_log]              # optional list; allowed values: console_log
  capture: always | on-failure | off  # optional, default always. Must be always when any
                                    # environment has kind production. See below.

selectors:
  testid_attribute: string          # required, e.g. data-testid
  policy_doc: string                # optional repo-relative path (warn if missing on disk)

models:
  generation_approved:              # required, >= 1 model id
    - claude-fable-5                # only these models may author cases.yaml;
    - claude-opus-5                 # validate-cases.mjs fails on anything else

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

mutation:                           # optional; REQUIRED when any environment has kind production.
                                    # See "What counts as a write".
  deny_controls:                    # optional; ADDED to the generic defaults, never replacing them
    text: [<regex string>]          # matched case-insensitively against a control's label
    icons: [string]                 # icon class names, prefix match
  write_signatures:                 # required, >= 1 entry, when mutation is required
    - method: string                # GET | HEAD | POST | PUT | PATCH | DELETE | OPTIONS | *
      url: <regex string>           # matched against the request URL
      body?: <regex string>         # the key is `body`; `?` marks it optional. Matched
                                    # against the request body
      note: string                  # optional: why this is a write
  allow_signatures:                 # optional, same shape: requests a write signature matches
    - ...                           # that are really reads

cross_app:                          # required when apps has > 1 entry
  propagation_window_s: integer     # 1..600, ceiling for expect.poll on cross-app flows
  spec_home: <app-name>             # which app's spec_dir hosts cross-app specs

clickup:                            # required when tracker is clickup (the default);
                                    # optional and ignored when tracker is none
  plan_tier: free | unlimited | business | enterprise   # required (rate budget)
  space: string                     # required, ClickUp space name for QA
  bug_list: string                  # optional: the list confirmed defects are filed into
                                    # by /qa-pilot:qa-review. Unset is legal; bugs then
                                    # land in the feature list beside the case tasks.
  folder: string                    # optional but recommended: the folder inside that
                                    # space holding feature lists. Name it whenever the
                                    # space has more than one folder, or a feature list
                                    # can be created beside unrelated manual QA work.
  statuses:                         # optional; canonical names assumed if omitted.
                                    # Complete if present: all seven or none.
    case_review: string             # authored, awaiting QA design review
    approved_for_execution: string  # design approved, never yet run
    under_review: string            # executed, awaiting QA verdict review
    approved: string                # verdict accepted; counts toward confidence
    rejected: string                # the test itself is wrong
    retest: string                  # needs another run
    quarantined: string             # flaky; held out, still in the denominator
```

## Environment kinds

Every environment says what it is. The tool no longer guesses from the hostname, because the guess
was wrong in the commonest case: `https://app.example.com` read as non-production.

| `kind` | Means | Consequences |
|---|---|---|
| `qa` | A shared test deployment | Traces upload to the tracker by default. |
| `staging` | A pre-release deployment | Traces upload to the tracker by default. |
| `production` | Real users and real data | Every rule below applies. |

When any environment has `kind: production`, the profile is valid only if all of these hold. Each
is an **error**, not a warning:

- that environment's `evidence_upload` is `local` (the default for it). `tracker` is refused,
  because a trace carries the session credential that authenticated the run and every request
  body it touched (see "What a trace contains" in `SETUP-CLICKUP.md`).
- `evidence.capture` is `always`. On production a pass is the claim most worth checking, and
  `on-failure` keeps nothing for passes.
- a `mutation` block is present with at least one `write_signatures` entry, so the write guard
  knows what a write looks like on this host.
- that environment's `test_account` is present: a string of at least 20 characters after
  trimming. See "Production test account" below.

Production also changes how runs publish: the tracker record of a production run carries no
application data, and features must declare a mutation policy other than `unrestricted`. Those
rules live in the case and report schemas, where the data they govern lives.

## Production test account

A production run signs in as a real account, and the account's own permissions are the only thing
that can truly bound what the run does. So the profile names that account and how it is
restricted.

`environments.<env>.test_account` is a string of at least 20 characters after trimming (leading
and trailing whitespace does not count). It is **required** when `kind: production`. On `qa` and
`staging` it is optional, and when present the same length rule applies, so a value means the same
thing everywhere. The error depends on the kind.

On `production`, a missing, non-string or too-short value is an **error**:

> `environments.<env>.test_account: required on a production environment, at least 20 characters. Name the account the runs use and how it is restricted (its own tenant, no admin rights, no billing). The write guard is the second layer, not the boundary.`

On any other kind, a missing value is not an error. A present value that is not a string of at
least 20 characters after trimming is an **error** with its own message, so a staging error never
says "required on a production environment":

> `environments.<env>.test_account: at least 20 characters when present.`

Say which account the runs use and what restricts it, for example: `qa-runner@example.com, its own
tenant, no admin rights, no billing`. The value is an **attestation**. Nothing checks it against
the saved login, so it records a claim QA makes and reviews; it does not prove one.

**A URL that looks like production** (an apex domain, or a `prod`/`production`/`live` hostname) on
an environment whose kind is not `production` is a **warning**, never an error. The kind you
declared wins; the warning exists so a mistyped kind is noticed.

**`allow_production` was retired in 0.3.0.** A profile that still sets it on any environment is
an error: "retired in 0.3.0; declare kind: production". It used to turn the hostname guess off;
there is no guess left to turn off.

## Where evidence goes

`evidence_upload` decides whether a run's traces are attached to the tracker or stay on disk.

| Effective value | What happens |
|---|---|
| `tracker` | The trace is attached to the case's tracker task, as in 0.2.0. |
| `local` | Nothing is attached. The trace stays under `testing/<feature>/runs/<run_id>/`, and the tracker gets its run-relative path and sha256 so a reviewer can find the exact file and verify it. |

The effective value is resolved by the loader and written into the normalized profile, so no
skill or script re-derives it:

1. if `tracker` is `none`, it is `local` on every environment. An environment that sets
   `evidence_upload: tracker` anyway gets a **warning**,
   `environments.<env>.evidence_upload: tracker is ignored under tracker: none`, and is still `local`;
2. otherwise, if the environment sets `evidence_upload`, that value (and `tracker` on a
   `production` environment is an error);
3. otherwise `local` for `kind: production` and `tracker` for everything else.

## How much evidence to capture

Capturing full evidence costs about 700 KB per case and adds noticeable wall clock, so this
is a real trade rather than a free default. Storage is the reliably measurable part; timing
varies a lot with network latency to the environment under test.

| Mode | Kept | Cost | Consequence |
|---|---|---|---|
| `always` (default) | every executed case | ~700 KB per case, slower runs | QA can sample passes, which is the backstop against a false pass |
| `on-failure` | failures and flakes only | near zero on a green run | passing cases have no trace, so QA cannot sample them and a false pass is undetectable by review |
| `off` | nothing | none | no run can be published; for iterating on specs locally |

The default is `always` because evidence for **passes** is the valuable kind. A failure
already evidences itself through its error message, whereas a pass is a claim that
something works, and the sampling rules in `/qa-pilot:qa-review` are what test that claim.

`on-failure` is a legitimate choice for a suite of mostly low-priority cases, or once a
feature is stable and you care mainly about catching regressions. Prefer `always` while a
feature is new or where P0 cases are involved. A profile with any production environment must
use `always`.

The gate enforces whichever mode the run recorded, so it can tell a deliberately
uncaptured pass from a lost artifact rather than guessing.

## Where specs stabilize

A new spec needs three consecutive green runs before its first verdict run counts, so a lucky
first pass is never published. By default those runs happen in the sandbox (`sandbox.mode`).

Some flows cannot run in a sandbox, because the mock backend does not model them. For those,
`stabilization.env` names a deployed environment where the three green runs may happen instead.
It must be a registered environment whose kind is not `production` (an **error** otherwise):
stabilizing a spec means running it before anyone trusts it, which is exactly what production
must not host. `/qa-pilot:run-tests` does not hand a stabilization run to
`/qa-pilot:publish-results`, wherever it ran. The publish gate cannot tell a stabilization run on
a deployed environment from a verdict run, so this rests on run-tests, not on the gate.

## Context sources

`/qa-pilot:generate-tests` reads the tracker task and the code before writing cases. A host
whose behaviour is documented somewhere else (a design system, a product model, an API reference)
names those places here, and they are read **first**, because documented intent is what an
assertion should pin, and code only shows what was built.

| Field | Rule |
|---|---|
| `name` | Required, non-empty string, unique across sources. |
| `description` | Required, non-empty string. Say what it holds and which features it covers, so the reader knows when to use it. |
| `command` | A non-empty string: a shell command run from the repo root; its stdout is the context. It is **shown to the user and confirmed before its first run in a session**, because a committed profile is not a reason to run arbitrary commands unseen. |
| `path` | A non-empty string: a repo-relative file, directory or glob. A `path` whose last path segment matches `.env*` is an **error**. Files named `.env*` are never read through any `path`, whatever a directory or glob matches. |

Exactly one of `command` or `path` per source, an **error** otherwise. When `context` is present,
`sources` must be a non-empty list.

## What counts as a write

A feature's cases declare whether their specs may change data (`mutation.policy` in
`cases.yaml`). The write guard enforces that declaration in the browser, and it needs two things
from the host: which controls are writes, and which network requests are writes.

**Controls.** The guard ships generic defaults: verbs such as save, delete, publish, submit,
upload, rename, and generic icon names such as delete, trash, pencil, share. `deny_controls.text`
(regex strings, matched case-insensitively) and `deny_controls.icons` (class names, prefix match)
are **added** to those defaults, never replacing them. Every regex must compile.

**Requests.** URL and method alone cannot always tell a write from a read: a GraphQL endpoint
takes queries and mutations on one URL, and RPC-style backends send every operation as a POST.
So a signature can also match the request body.

| Field | Rule |
|---|---|
| `method` | Required. One of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` (uppercase), or `*` for any. |
| `url` | Required. A regex string, matched against the full request URL. |
| `body` | Optional (written `body?` above). A regex string, matched against the request body. A signature with a body pattern matches only requests whose body matches; a request with no body never matches it. |
| `note` | Optional string. Why this request is a write. |

`url` and `body` must compile without flags: they are compiled with `new RegExp(pattern)` and
matched case-sensitively. `deny_controls.text` patterns are the exception, compiled with the `i`
flag, since control labels vary in case.

**The write guard is the second layer, not the boundary.** On production the boundary is the
restricted account named by `test_account`: an account that cannot change data cannot be made to
by a missed button. The guard sits under it. A signature list is only as complete as the host's
inventory, and a write that no signature matches is a write the guard does not see and lets
through (see the QA-Pilot repository's `docs/decisions/0001-write-signatures-default-deny.md` for
why lists are written default-deny per channel). `test_account` is itself an attestation nothing
verifies, so neither layer is proof alone; QA owns keeping the account restricted and the signature list complete.

**Unknown keys** under `mutation`, `deny_controls`, a signature entry, `stabilization`, `context`
or a `sources` entry are **errors**, as unknown top-level keys are: a misspelt `write_signature`
would otherwise leave the guard with no signatures and no complaint.

A request is a **write** when it matches any `write_signatures` entry and no `allow_signatures`
entry. `allow_signatures` has the same shape and exists for reads that look like writes, such as
a streaming read that uses POST.

`mutation` is optional on a profile with no production environment, and **required, with at least
one `write_signatures` entry**, when any environment has `kind: production`. Keep host-specific
words and patterns here, in the host's profile; the plugin's defaults stay generic.

## Working without a tracker

`tracker: clickup` (the default): the `clickup` block is required and validated by the rules in
this document, which are unchanged from 0.2.0.

`tracker: none` runs the whole pipeline on local files:

- the `clickup` block is optional; if present it is ignored, a **warning** says so, and it is
  removed from the normalized profile, so no script reads a status name from it;
- status names are the canonical seven (`Case Review`, `Approved for Execution`, `Under Review`,
  `Approved`, `Rejected`, `Retest`, `Quarantined`; matched case-insensitively);
- QA records design and verdict decisions by editing `testing/<feature>/statuses.json`
  (`{"<CASE-ID>": "<status>"}`). `/qa-pilot:run-tests` reads it in place of the ClickUp fetch
  and copies it into the run directory as that run's approval record, the copy the publish
  gate's `--statuses` then reads;
- effective `evidence_upload` is `local` on every environment, since there is nowhere to upload to;
- confirmed bugs are written as markdown files inside the run directory.

## Identifying the deployed build

Every verdict is stamped with what was running when it was proved, and a run is blocked if
that changes mid-flight. There are two ways to express it.

**`commit` (default, preferred).** A git SHA, so a verdict names the exact source it was
proved against. Requires the environment to serve its commit, typically a small
`/version.json` written at image build time.

```yaml
sha_source:
  url: https://qa.example.com/version.json
  json_path: commit
```

**`build-id` (for a host that cannot serve a commit yet).** Any stable per-build
fingerprint the app already serves. A bundler's content hash works, and needs no change to
the application:

```yaml
sha_source:
  url: https://qa.example.com/index.html
  regex: 'assets/index-([A-Za-z0-9_-]+)\.js'
  format: build-id
```

What you keep: mid-run deploy detection, which is the property that stops half a run
testing one build and half another. What you give up: traceability. A build id names the
bundle, not the commit, so tracing a report back to source means correlating through your
release records by time or version. The profile validator warns about this, and the report
records `sha_format` so nobody later mistakes a bundle hash for a commit.

One blind spot worth knowing: with code splitting, a deploy that changes only a lazily
loaded chunk may leave the entry hash untouched, so such a deploy would not be detected
mid-run. Prefer `commit` once the environment can serve one.

## Where bugs go

When QA confirms a failure is a real defect rather than a broken test,
`/qa-pilot:qa-review` files a bug and links it to the case task. `clickup.bug_list` names
the list those go into.

Leaving it unset is legal, so a first pilot is not blocked on ClickUp admin, but bugs then
land in the feature list next to the case tasks and the script warns each time. Point it at
whatever list your developers already work from: a bug has its own lifecycle, owned by
them, and QA-Pilot deliberately does not try to own it.

The link is a native ClickUp task relationship, not a custom field, so there is nothing
extra to create in ClickUp for this. Under `tracker: none`, bugs are local markdown files instead.

## Status names are per-host

The seven **keys** are the pipeline's lifecycle and never change. The **names** are whatever your ClickUp already calls them, because every team has its own QA vocabulary: one board's `Under Review` is another's `ready for review`.

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

Matching is case-insensitive and trimmed. Two lifecycle states may not share one status name, since the pipeline could not tell them apart. Declaring only some keys is an error rather than a partial default: a half-applied map matches some states and silently misses others.

## Warnings (non-fatal, printed to stderr)

- `selectors.policy_doc` set but the file does not exist on disk
- only one environment registered (no staging/QA split)
- `evidence.extra` empty on a profile with `assertions.network_events: forbidden`
  (no network evidence *and* no console evidence leaves failures video-only)
- a URL that looks like production on an environment whose kind is not `production`
- a `clickup` block present while `tracker: none`
- `environments.<env>.evidence_upload: tracker` while `tracker: none` (ignored; the value is `local`)

## CLI

```bash
node qa-pilot/scripts/lib/profile.mjs <path-to-qa-pilot.config.yaml>
```

Exit 0 → normalized profile JSON on stdout. Exit 1 → one error per line on stderr.
