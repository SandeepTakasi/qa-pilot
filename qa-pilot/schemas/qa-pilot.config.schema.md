# `qa-pilot.config.yaml`: host profile schema

The host profile lives in the **consuming repo**, is written by `/qa-pilot:qa-init`, reviewed and owned by QA, and must be committed. Every other QA-Pilot skill refuses to run without a committed, schema-valid profile.

Enforced by `scripts/lib/profile.mjs`. Unknown top-level keys are an **error** (catches typos silently changing behavior).

```yaml
project: string                     # required, non-empty

apps:                               # required, >= 1 entry
  <app-name>:                       # e.g. storefront, admin
    framework: string               # required, e.g. vue3-vuetify-vuex, react-mui
    spec_dir: string                # required, repo-relative dir for committed specs
    repo: string                    # required, path or URL to that app's repo

environments:                       # required, >= 1 entry
  <env-name>:                       # e.g. qa, staging
    apps:                           # required; keys must be a subset of apps{}
      <app-name>: <http(s) URL>     # base URL of that app in this environment
    sha_source:                     # required: how the DEPLOYED build's SHA is read
      url: <http(s) URL>            # required, e.g. https://qa.example.com/api/version
      json_path: string             # exactly ONE of json_path | regex
      regex: string                 #   json_path: dot path, e.g. build.commit
                                    #   regex: must contain one capture group

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
```

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
