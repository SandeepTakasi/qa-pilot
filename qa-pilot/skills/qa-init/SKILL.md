---
name: qa-init
description: Initialize QA-Pilot in a host repo. Scan the codebase (frameworks, package versions, existing test infra, dev-mode scripts, selector conventions, house docs), interview for what discovery cannot know (tracker or none, deployed environments and their kinds, deploy-SHA source, where evidence goes, what counts as a write, documentation sources, ClickUp workspace and tier, sandbox mode), and emit a schema-valid qa-pilot.config.yaml host profile plus a gap report. Run this before any other QA-Pilot skill; all of them refuse to run without a schema-valid profile. Use when the user says "qa-init", "set up qa-pilot", "initialize QA-Pilot", or "onboard this repo to QA-Pilot".
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# qa-init: onboard a repo to QA-Pilot

You are generating the **host profile**: the one file that carries everything project-specific so the QA-Pilot plugin itself stays generic. Everything you write here is read by every other skill. Getting it wrong silently poisons every downstream verdict, so **discover what you can, ask about what you cannot, and never invent a value**.

Recommended model: any current model. This is discovery and interviewing, not judgment.

## 0. Preflight

Resolve the profile path: userConfig `profile_path`, default `qa-pilot.config.yaml`, relative to the repo root.

If a profile already exists there:
1. Validate it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <path>`
2. Ask the user whether to **update** it (keep valid values, re-interview only gaps) or **abort**. Never silently overwrite a QA-owned file.

## 1. Discovery scan (read-only, so do not ask about anything you can find)

Run these and record what you learn. Do not stop at the first app: multi-app repos and sibling repos are the norm.

**Never open `.env*` files**, and never open a deployed runtime configuration (such as a served `runtime-config.js`), in this repo or any other. They hold secrets, and nothing in the profile needs a value from them: discovery only needs variable *names*, which the code that reads them already shows.

| Look for | How | Fills |
|---|---|---|
| Apps + frameworks | `package.json` at root and in any workspace/app dirs; check dependencies for `vue`, `react`, `vuetify`, `@mui/material`, `next`, `svelte` | `apps.<name>.framework` |
| Playwright version | `@playwright/test` / `playwright` in devDependencies; `npx playwright --version` | `auth.playwright_min` |
| Existing spec dirs | `playwright.config.*`, `e2e/`, `tests/e2e/`, `cypress/` | `apps.<name>.spec_dir` |
| Sandbox / mock mode | variable **names** only: grep `vite.config.*`, `package.json` scripts and source for `import.meta.env.<NAME>` and `process.env.<NAME>` where the name looks like `API_MODE`, `VITE_API_MODE`, `MOCK`, `USE_MOCKS`. You may list which `.env*` files exist (`ls -a`), by name, to mention them; never open one. Then ask the user for the value that selects the mock mode | `sandbox.mode` |
| Documentation sources | design-system or product-model docs (`docs/`, a component library's docs folder), and any CLI or script the repo already uses to print its model or API reference | `context.sources` candidates to confirm in the interview |
| Selector convention | count occurrences: `grep -ro 'data-testid' --include=*.vue --include=*.tsx --include=*.jsx . \| wc -l` and the same for `data-test`, `data-cy` | `selectors.testid_attribute` |
| House rules / style docs | `CLAUDE.md`, `CONTRIBUTING.md`, `UI_GUIDELINES.md`, `docs/` | `selectors.policy_doc` |
| Sibling app repos | if the user mentions a second frontend, check sibling dirs for its `package.json` | second `apps` entry + `repo` |

**Adopt what exists, never replace it.** An existing Playwright config, spec directory, or CI workflow is a fact about this host, not a thing to overwrite.

Report the scan results to the user in a short table before you start asking questions. They will correct you faster than they will answer from scratch.

## 2. Interview (only for what discovery cannot know)

Use `AskUserQuestion`. Ask in this order, batching related questions:

0. **Tracker**: does the team record QA in ClickUp (`tracker: clickup`, the default) or run the pipeline on local files with no tracker (`tracker: none`)? Under `none`, skip items 7 and 8, write no `clickup` block, and tell the user that approvals live in `testing/<feature>/statuses.json` and that all evidence stays local.
1. **Environments**: names (typically `qa`, `staging`), the base URL of each app in each, and **what each one is**: its `kind`, one of `qa`, `staging` or `production`. Ask it explicitly for every environment, never infer it from the hostname: `app.example.com` is usually production and looks like nothing in particular. These must be **deployed** environments; localhost is not verdict-eligible.

   For each environment ask where its evidence goes, `evidence_upload: tracker` (traces attached to the tracker) or `local` (traces stay on the executor's machine and the tracker gets only their path and sha256). Leave it unset to take the default: `local` for production, `tracker` otherwise.

   **If any environment is `production`**, say what that commits the host to, before going further:
   - its evidence is `local`; `tracker` there is refused, because a trace carries the session and every request body it touched;
   - `evidence.capture` must be `always`;
   - it needs a `test_account` (asked just below);
   - a `mutation` block with at least one write signature is required (item 9);
   - `testing/*/runs/` must be gitignored, which `/qa-pilot:run-tests` checks before every production run (step 5 below);
   - the CI template never runs against it.

   **Whenever an environment is `production`, ask for its `test_account`**: which account the runs sign in as and what restricts it (its own tenant, no admin rights, no billing). Write the answer into that environment as `test_account`, for example `qa-runner@example.com, its own tenant, no admin rights, no billing`; it must be at least 20 characters after trimming, or the whole profile is invalid. Say that it is an attestation nothing verifies against the saved login, and that the write guard is the second layer under that account, never the boundary. If the host has no restricted account, record that in the gap report and leave the profile invalid until one exists.
2. **Deploy-SHA source**: the URL that reports the running build's commit (e.g. `https://qa.example.com/api/version`) and how to extract it, either a dot path into the JSON response (`build.commit`) or a regex with one capture group. **If there is no such endpoint, say so plainly: this is a Phase-0 blocker, not a detail.** Record it in the gap report and leave the profile invalid until it exists, because a SHA that cannot be read means no run can ever be published.
3. **Auth model**: `dev-handoff` (each dev logs in once through a headed browser), `role-accounts` (dedicated per-role accounts), or `mixed` (both, which is the usual answer when permission cases are in scope).
4. **Assertions**: ask whether application operations are visible as network requests in the browser Network tab. Engine-dispatched, worker-dispatched, or WebSocket-multiplexed apps answer "no" → `network_events: forbidden` + `style: ui-state`. When forbidden, ask whether the app emits structured console logs that could serve as failure evidence → `evidence.extra: [console_log]`.
5. **Approved generation models**: which model IDs may author test cases. Default to the current strongest available model. This list is a gate: `validate-cases.mjs` rejects cases stamped with anything else, so a model upgrade cannot silently change case quality without QA adding it here.
6. **Cross-app propagation** (multi-app only): if a change in app A becomes visible in app B only after a delay (polling bridge, queue, cache), ask for the worst-case window in seconds, then set `propagation_window_s` to roughly 3× the observed window as a ceiling for `expect.poll`.
7. **ClickUp**: space name holding QA work, and the plan tier (sets the API rate budget: Free through Business = 100 requests/min per token). Also ask which **folder** inside that space holds the feature lists, and record it as `clickup.folder`. Most spaces already contain unrelated folders, and without this a feature list can be created beside someone's manual QA work. A dedicated folder for the automated pipeline is the usual answer, which keeps its statuses and fields off the manual lists.
8. **Status names.** The pipeline has seven lifecycle states; this host names them. Ask whether the QA space already has statuses and what they are called. Many teams already run manual QA in ClickUp and have their own vocabulary, so reusing it beats imposing new wording. Map their names onto the seven keys and write the result to `clickup.statuses`:

   | Key | What it means |
   |---|---|
   | `case_review` | authored, awaiting QA design review |
   | `approved_for_execution` | design approved, never yet run |
   | `under_review` | executed, awaiting QA verdict review |
   | `approved` | verdict accepted; counts toward confidence |
   | `rejected` | the test itself is wrong, which is different from the test failing |
   | `retest` | needs another run |
   | `quarantined` | flaky; held out, still in the denominator |

   Watch for one trap. A board whose statuses are `pass` and `fail` is recording a **verdict**, not a review state. QA-Pilot keeps the verdict in a custom field and uses status for approval, so `pass` is not the same thing as `approved`: a case can fail and QA can approve that the failure is real. If an existing vocabulary has no way to express approval, say so plainly and have them add statuses rather than forcing a bad mapping.

   **Write the block explicitly even when the canonical names fit**, so the profile documents the board a reader is actually looking at.
9. **What counts as a write** (`mutation`; required when any environment is production, recommended otherwise). Ask which browser requests change data on this host, and record each as a `write_signatures` entry `{ method, url, body?, note }`: an uppercase HTTP verb or `*`, a URL regex, and, where one URL carries both reads and writes (a GraphQL endpoint, an RPC-style `POST`), a `body` regex that tells them apart. Record requests that look like writes but are reads as `allow_signatures`. Add host-specific labels and icon classes of write controls under `deny_controls`; the plugin's generic defaults (save, delete, publish, ...) stay in force. Confirm the patterns against real requests in the browser's Network tab rather than guessing: a missing signature is a write the guard does not see.
10. **Stabilization environment**: can new specs earn their three green runs in the sandbox, or do some flows need a deployed environment? If so, which one, as `stabilization.env`. It must not be production.
11. **Documentation sources** (`context.sources`): confirm the candidates from the scan, each with a `name`, a `description` saying what it holds and which features it covers, and exactly one of a `path` (file, directory or glob; never an `.env*` file) or a `command` (run from the repo root; its output is the context). Tell the user that every `command` is shown to them and confirmed before its first run in a session.

## 3. Emit the profile

Write the profile to the resolved path, following `${CLAUDE_PLUGIN_ROOT}/schemas/qa-pilot.config.schema.md` exactly. Include brief comments for values a future reader would question (why the propagation window is what it is, why network assertions are forbidden).

Then validate and **loop until it passes**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <path>
```

Fix every error. Report every warning to the user rather than silencing it. Never write a test_account value the user did not give: a production environment without one stays an error and goes in the gap report, even though that leaves the profile invalid, because an invented account defeats the attestation.

## 4. Gap report

Print (do not write to a file) the prerequisites this host must close before the pipeline is trustworthy. For each gap, name the skill it blocks. Typical gaps:

| Gap | Blocks |
|---|---|
| No deploy-SHA endpoint | `/run-tests` and `/publish-results`: every run, permanently |
| No test-id attributes in the codebase | spec durability; specs will bind to fragile selectors and rot |
| Playwright < 1.51 | `/setup-profiles`: IndexedDB-persisted auth (Firebase) will not restore |
| No sandbox/mock mode | spec stabilization competes for the shared deployed environment |
| No role accounts yet | permission-type cases in `/generate-tests` |
| Deployed builds strip console logs | failure evidence on hosts where console output is the required evidence |
| A production environment with `testing/*/runs/` not gitignored | `/run-tests` on production: it refuses until the run directories are ignored |
| No restricted account for a production environment | the whole profile: `test_account` is required there, and the write guard is only the second layer, never the boundary |
| No write signatures confirmed against real requests | the write guard on production: the profile is invalid without at least one, and an incomplete list is a write the guard cannot see |

With `tracker: clickup` only, add these:

| Gap | Blocks |
|---|---|
| ClickUp space, statuses or custom fields not created | `/publish-results`: see below |
| Private Attachment Links not enabled in ClickUp | evidence privacy: attachment URLs are public, unauthenticated and non-expiring by default, and traces carry application state |
| All developers sharing one ClickUp API token | `/publish-results` under concurrency, because the 100 req/min budget is per token, so a shared token is shared by everyone publishing at once |
| `Run ID`, `Trace Path`, `Trace SHA256` fields not created in ClickUp | `/publish-results` for any environment whose evidence stays local |

Under `tracker: none` there is no ClickUp setup at all: skip the rest of this section, and tell the user instead that QA approves cases by editing `testing/<feature>/statuses.json`.

**With `tracker: clickup`, the plugin does not create the ClickUp structure. The user does, once.** Point them at
`${CLAUDE_PLUGIN_ROOT}/SETUP-CLICKUP.md`, which lists the exact statuses, the exact custom
fields and their dropdown options, and the two settings above. Names are matched literally
by `/publish-results`, so "roughly right" fails at publish time.

Two of the dropdowns (`Env`, `App`) and one option of `API Mode` are host-specific, so their
values come from the profile you just wrote. Tell the user the concrete values to create
rather than making them derive them: list the environment names, the app names, and the
sandbox value from this host's profile.

## 5. Hand off

Recommend **committing the profile**, because an uncommitted one means five developers end up testing against five different definitions of the truth. The other skills warn rather than refuse when it is uncommitted, so a host that deliberately gitignores it while trialling the pipeline still works. Say plainly that it must be committed before the team relies on it.

**Say what each file costs to gitignore.** Keeping QA artifacts out of the repo is a
legitimate choice, and some teams have good reasons for it: a trial they do not want in the
history, an app repo they keep free of test code, a policy about generated files. It is not
a mistake. But each one buys tidiness by turning off a specific capability, quietly, so the
trade should be made deliberately rather than discovered three months later.

| Path | Ignoring it still leaves you | What stops working |
|---|---|---|
| `testing/<feature>/runs/` | everything | nothing. Ignore this one: large, per-run, reproducible. **Required** when any environment is production, since production evidence must never reach git |
| `qa-pilot.config.yaml` | a working pipeline for whoever holds it | five developers can test against five definitions of the truth |
| `<spec_dir>/` (the specs) | local runs, evidence, publishing, review | CI, and anyone else reproducing a verdict |
| `testing/<feature>/cases.yaml` | runs by whoever holds the file | anyone else running the feature |
| `testing/<feature>/specs.json` | runs, evidence, publishing | `spec_sha` recording, so approval never carries forward |
| `testing/<feature>/approved.json` | runs, evidence, publishing, review | approval carry-forward, and CI can select nothing |
| `testing/<feature>/bugs.json` | filing bugs | deduplication, so every run refiles every open bug |

Nothing refuses to run because of any of these. The skills warn at the moment it matters and
carry on, which is the same treatment an uncommitted profile gets.

Two degraded modes are coherent enough to name, so a host can pick one on purpose:

- **Local-only.** Ignore the specs and all of `testing/`. You still get QA-approved cases and
  evidenced verdicts, plus a ClickUp record with `tracker: clickup`. You give up CI,
  cross-machine reproduction, and approval carry-forward, so every run returns the feature to
  review. Under `tracker: none` this mode also keeps the approvals themselves
  (`testing/<feature>/statuses.json`) on one machine, so it suits a single reviewer only.
- **Committed.** Ignore only `testing/*/runs/`. Everything works, and the repo carries the
  specs and three small JSON files per feature.

Recommend **Committed**, and say what Local-only costs rather than arguing. Offer the
precise entries either way:

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

Then check that the run directories really are ignored, whatever mode was chosen, and say the result:

```bash
git check-ignore -q testing/x/runs/x && echo "runs are ignored" || echo "runs are NOT ignored"
```

If they are not, and any environment is production, this is not a suggestion: `/qa-pilot:run-tests` will refuse every production run until they are.

Then state the next step: `/qa-pilot:setup-profiles` to save auth profiles, then `/qa-pilot:generate-tests <feature>` for the pilot feature.
