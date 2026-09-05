# `qa-pilot.config.yaml`: host profile schema

The host profile lives in the **consuming repo**, is written by `/qa-pilot:qa-init`, and is reviewed and owned by QA. Every other QA-Pilot skill refuses to run without a schema-valid profile, and warns (rather than refuses) when it is not committed, since a host trialling the pipeline may reasonably keep it local at first.

Enforced by `scripts/lib/profile.mjs`. Unknown top-level keys are an **error** (catches typos silently changing behavior).

```yaml
project: string                     # required, non-empty

apps:                               # required, >= 1 entry
  <app-name>:                       # one key per frontend, e.g. storefront, admin
    framework: string               # required, e.g. vue3-vuetify-vuex, react-mui
    spec_dir: string                # required, repo-relative dir for committed specs
    repo: string                    # required, path or URL to that app's repo

environments:                       # required, >= 1 entry
  <env-name>:                       # e.g. qa, staging
    apps:                           # required; keys must be a subset of apps{}
      <app-name>: <http(s) URL>     # base URL of that app in this environment
    allow_production: true          # optional. Required to register a production-looking
                                    # URL; see "Never point this at production" below.
    sha_source:                     # required: how the DEPLOYED build is identified
      url: <http(s) URL>            # required, e.g. https://qa.example.com/api/version
      json_path: string             # exactly ONE of json_path | regex
      regex: string                 #   json_path: dot path, e.g. build.commit
                                    #   regex: must contain one capture group
      format: commit | build-id     # optional, default commit. See below.

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
  capture: always | on-failure | off  # optional, default always. See below.

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

cross_app:                          # required when apps has > 1 entry
  propagation_window_s: integer     # 1..600, ceiling for expect.poll on cross-app flows
  spec_home: <app-name>             # which app's spec_dir hosts cross-app specs

clickup:
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
feature is new or where P0 cases are involved.

The gate enforces whichever mode the run recorded, so it can tell a deliberately
uncaptured pass from a lost artifact rather than guessing.

## Never point this at production

The validator refuses an environment whose URL looks like production (an apex domain, or a
`prod`/`production`/`live` hostname). Two reasons, both concrete:

- Specs create and mutate real records. A QA suite run weekly against production is a
  weekly stream of junk orders, junk users and junk payments in real data.
- Every run writes a trace containing the session credential that authenticated it, and
  that trace is uploaded to the tracker. See "What a trace contains" in `SETUP-CLICKUP.md`.

`qa`, `staging`, `dev`, `uat`, `sandbox`, `preview` and `localhost` hostnames pass. A host
that genuinely must target a production hostname sets `allow_production: true` on that
environment, which turns the refusal into a recorded warning. Use short-lived,
low-privilege test accounts if you do.

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
extra to create in ClickUp for this.

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

## CLI

```bash
node qa-pilot/scripts/lib/profile.mjs <path-to-qa-pilot.config.yaml>
```

Exit 0 → normalized profile JSON on stdout. Exit 1 → one error per line on stderr.
