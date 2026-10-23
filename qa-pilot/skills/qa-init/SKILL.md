---
name: qa-init
description: Initialize QA-Pilot in a host repo. Scan the codebase, interview for what discovery cannot know, and emit a schema-valid qa-pilot.config.yaml host profile plus a gap report. Run this before any other QA-Pilot skill, since all refuse to run without a valid profile. Use when the user says "qa-init", "set up qa-pilot", "initialize QA-Pilot", or "onboard this repo to QA-Pilot".
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# qa-init: onboard a repo to QA-Pilot

You are generating the **host profile**, the one file carrying everything project-specific. Every other skill reads it. Discover what you can, ask about what you cannot, and never invent a value.

## 0. Preflight

Resolve the profile path: userConfig `profile_path`, default `qa-pilot.config.yaml`, relative to the repo root.

If a profile exists there, validate it with `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <path>`, then ask whether to **update** it (keep valid values, re-interview only gaps) or **abort**. Never silently overwrite it.

## 1. Discovery scan (read-only; do not ask about anything you can find)

Multi-app repos and sibling repos are the norm, so do not stop at the first app.

**Never open `.env*` files or a deployed runtime configuration (such as a served `runtime-config.js`), in this repo or any other.** They hold secrets; discovery needs only variable *names*, which the code that reads them shows. You may list which `.env*` files exist by name.

| Look for | How | Fills |
|---|---|---|
| Apps + frameworks | `package.json` at root and in workspace/app dirs; dependencies such as `vue`, `react`, `vuetify`, `@mui/material`, `next`, `svelte` | `apps.<name>.framework` |
| Playwright version | `@playwright/test` / `playwright` in devDependencies; `npx playwright --version` | `auth.playwright_min` |
| Existing spec dirs | `playwright.config.*`, `e2e/`, `tests/e2e/`, `cypress/` | `apps.<name>.spec_dir` |
| Sandbox / mock mode | variable **names** only: grep `vite.config.*`, `package.json` scripts and source for `import.meta.env.<NAME>` and `process.env.<NAME>` named like `API_MODE`, `VITE_API_MODE`, `MOCK`, `USE_MOCKS`; then ask the user for the value that selects mock mode | `sandbox.mode` |
| Documentation sources | design-system or product-model docs (`docs/`, a component library's docs), and any CLI or script that prints the model or API reference | `context.sources` candidates |
| Selector convention | count `data-testid`, `data-test`, `data-cy`: `grep -ro 'data-testid' --include=*.vue --include=*.tsx --include=*.jsx . \| wc -l` | `selectors.testid_attribute` |
| House rules / style docs | `CLAUDE.md`, `CONTRIBUTING.md`, `UI_GUIDELINES.md`, `docs/` | `selectors.policy_doc` |
| Sibling app repos | if a second frontend is mentioned, check sibling dirs for its `package.json` | second `apps` entry + `repo` |

**Adopt what exists, never replace it**: an existing Playwright config, spec directory or CI workflow is a fact about this host.

Show the scan results in a short table before asking questions.

## 2. Interview (only for what discovery cannot know)

Use `AskUserQuestion`. Ask in this order, batching related questions:

0. **Tracker**: ClickUp (`tracker: clickup`, the default) or local files with no tracker (`tracker: none`)? Under `none`, skip items 7 and 8, write no `clickup` block, and tell the user approvals live in `testing/<feature>/statuses.json` and all evidence stays local.
1. **Environments**: names (typically `qa`, `staging`), each app's base URL in each, and each one's `kind`: `qa`, `staging` or `production`. Ask `kind` explicitly for every environment, never infer it from the hostname. They must be **deployed**; localhost is not verdict-eligible.

   For each environment ask where evidence goes (`evidence_upload`; unset takes the default, `local` for production, `reference` otherwise):
   - `reference`: traces stay on the executor's machine; the tracker gets the same fields and failure text plus each trace's path and sha256.
   - `tracker`: traces attached to the tracker. Opt-in, only after Private Attachment Links is on and runs use a restricted account, because a trace carries the session and can carry a refresh token.
   - `local`: traces stay on the machine; the tracker gets no application data, only path and sha256.

   **If any environment is `production`**, say what that commits the host to before going further:
   - its evidence is `local` (`tracker` and `reference` are refused);
   - `evidence.capture` must be `always`;
   - it needs a `test_account`;
   - a `mutation` block with at least one write signature is required (item 9);
   - `testing/*/runs/` must be gitignored, which `/qa-pilot:run-tests` checks before every run whose evidence stays on the machine (step 5 below);
   - the CI template never runs against it.

   **For every `production` environment, ask for its `test_account`**: the account the runs sign in as and what restricts it (own tenant, no admin rights, no billing). Write it into that environment, at least 20 characters after trimming or the profile is invalid, e.g. `qa-runner@example.com, its own tenant, no admin rights, no billing`. Say it is an attestation nothing verifies against the saved login, and the write guard is a second layer under that account, never the boundary. If the host has no restricted account, put that in the gap report and leave the profile invalid. Never write a `test_account` the user did not give.
2. **Deploy-SHA source**: the URL that reports the running build's commit (e.g. `https://qa.example.com/api/version`) and how to extract it: a dot path into the JSON response (`build.commit`) or a regex with one capture group. **No such endpoint is a Phase-0 blocker**: record it in the gap report and leave the profile invalid, because without a readable SHA no run can be published.
3. **Auth model**: `dev-handoff` (each dev logs in once through a headed browser), `role-accounts` (dedicated per-role accounts) or `mixed` (both; the usual answer when permission cases are in scope).
4. **Assertions**: are application operations visible as requests in the browser Network tab? Engine-dispatched, worker-dispatched or WebSocket-multiplexed apps answer "no" → `network_events: forbidden` + `style: ui-state`. When forbidden, ask whether the app emits structured console logs usable as failure evidence → `evidence.extra: [console_log]`.
5. **Approved generation models**: which model IDs may author cases; default to the current strongest available. It is a warning, not a gate: `validate-cases.mjs` warns on cases stamped with any other model, and QA adds the model here once it trusts it.
6. **Cross-app propagation** (multi-app only): if a change in app A reaches app B only after a delay (polling bridge, queue, cache), ask for the worst-case window in seconds and set `propagation_window_s` to about 3x that, as a ceiling for `expect.poll`.
7. **ClickUp space and folder** (ClickUp only): read `references/clickup.md` and ask there. Record `clickup.space` and `clickup.folder`.
8. **Status names** (ClickUp only): in `references/clickup.md`; write `clickup.statuses`.
9. **What counts as a write** (`mutation`; required when any environment is production, recommended otherwise). Ask which browser requests change data and record each as a `write_signatures` entry `{ method, url, body?, note }`: an uppercase HTTP verb or `*`, a URL regex and, where one URL carries both reads and writes (GraphQL, RPC-style `POST`), a `body` regex telling them apart. Record read-only lookalikes as `allow_signatures`. Put host-specific labels and icon classes of write controls under `deny_controls`; the generic defaults (save, delete, publish, ...) stay in force. Confirm patterns against real requests in the Network tab: a missing signature is a write the guard cannot see.
10. **Stabilization environment**: can new specs earn their three green runs in the sandbox, or do some flows need a deployed environment? If so, which, as `stabilization.env`; never production.
11. **Documentation sources** (`context.sources`): confirm the scan candidates, each with a `name`, a `description` of what it holds and which features it covers, and exactly one of `path` (file, directory or glob; never `.env*`) or `command` (run from the repo root; its output is the context). Tell the user every `command` is shown and confirmed before its first run in a session.

## 3. Emit the profile

Write the profile to the resolved path, following `${CLAUDE_PLUGIN_ROOT}/schemas/qa-pilot.config.schema.md`. Add brief comments for values a reader would question (the propagation window, forbidden network assertions). Then loop until this passes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <path>
```

Fix every error; report every warning to the user rather than silencing it. A production environment without a `test_account` stays an error and goes in the gap report.

## 4. Gap report

Print it (do not write a file). For each gap, name the skill it blocks:

| Gap | Blocks |
|---|---|
| No deploy-SHA endpoint | `/run-tests` and `/publish-results`: every run, permanently |
| No test-id attributes in the codebase | spec durability; specs bind to fragile selectors |
| Playwright < 1.51 | `/setup-profiles`: IndexedDB-persisted auth (Firebase) will not restore |
| No sandbox/mock mode | spec stabilization competes for the shared deployed environment |
| No role accounts yet | permission-type cases in `/generate-tests` |
| Deployed builds strip console logs | failure evidence where console output is the required evidence |
| A production environment with `testing/*/runs/` not gitignored | `/run-tests` on production, which refuses until ignored |
| No restricted account for a production environment | the whole profile: `test_account` is required there |
| No write signatures confirmed against real requests | the write guard on production: at least one is required, and an incomplete list is a write it cannot see |

With `tracker: clickup`, read `references/clickup.md` for the extra gap rows and the ClickUp setup the user must do. Under `tracker: none` there is no ClickUp setup; tell the user QA approves cases by editing `testing/<feature>/statuses.json`.

## 5. Hand off

Recommend **committing the profile**: otherwise each developer tests against a different definition of the truth. Other skills warn rather than refuse when it is uncommitted, so a host trialling the pipeline can gitignore it; say it must be committed before the team relies on it.

Gitignoring QA artifacts is legitimate, but each entry turns off a capability. Say what it costs:

| Path | What stops working when ignored |
|---|---|
| `testing/<feature>/runs/` | nothing; ignore it. **Required** when any environment is production |
| `qa-pilot.config.yaml` | one shared definition of the truth |
| `<spec_dir>/` (the specs) | CI, and anyone else reproducing a verdict |
| `testing/<feature>/cases.yaml` | anyone else running the feature |
| `testing/<feature>/specs.json` | `spec_sha` recording, so approval never carries forward |
| `testing/<feature>/approved.json` | approval carry-forward; CI can select nothing |
| `testing/<feature>/bugs.json` | bug deduplication: every run refiles every open bug |

Nothing refuses to run because of these; the skills warn when it matters. Two modes:

- **Local-only**: ignore the specs and all of `testing/`. You keep approved cases and evidenced verdicts (and a ClickUp record under `tracker: clickup`) but lose CI, cross-machine reproduction and approval carry-forward, so every run returns the feature to review. Under `tracker: none` approvals also stay on one machine, so it suits a single reviewer.
- **Committed** (recommended): ignore only `testing/*/runs/`.

State what Local-only costs rather than arguing. Offer the entries either way:

```gitignore
# Committed mode (recommended)
testing/*/runs/
.playwright/
test-results/
playwright-report/

# Local-only mode adds:
# <spec_dir>/
# testing/
# qa-pilot.config.yaml
```

Whatever mode was chosen, check the run directories are ignored and say the result:

```bash
git check-ignore -q testing/x/runs/x && echo "runs are ignored" || echo "runs are NOT ignored"
```

If not ignored and any environment is production, this is not a suggestion: `/qa-pilot:run-tests` refuses every production run until they are.

Then state the next step: `/qa-pilot:setup-profiles` to save auth profiles, then `/qa-pilot:generate-tests <feature>` for the pilot feature.
