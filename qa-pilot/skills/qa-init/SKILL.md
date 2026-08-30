---
name: qa-init
description: Initialize QA-Pilot in a host repo — scan the codebase (frameworks, package versions, existing test infra, dev-mode scripts, selector conventions, house docs), interview for what discovery cannot know (deployed environment URLs, deploy-SHA source, ClickUp workspace and tier, sandbox mode), and emit a schema-valid qa-pilot.config.yaml host profile plus a gap report. Run this before any other QA-Pilot skill; all of them refuse to run without a committed valid profile. Use when the user says "qa-init", "set up qa-pilot", "initialize QA-Pilot", or "onboard this repo to QA-Pilot".
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# qa-init — onboard a repo to QA-Pilot

You are generating the **host profile**: the one file that carries everything project-specific so the QA-Pilot plugin itself stays generic. Everything you write here is read by every other skill. Getting it wrong silently poisons every downstream verdict, so **discover what you can, ask about what you cannot, and never invent a value**.

Recommended model: any current model. This is discovery and interviewing, not judgment.

## 0. Preflight

Resolve the profile path: userConfig `profile_path`, default `qa-pilot.config.yaml`, relative to the repo root.

If a profile already exists there:
1. Validate it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <path>`
2. Ask the user whether to **update** it (keep valid values, re-interview only gaps) or **abort**. Never silently overwrite a QA-owned file.

## 1. Discovery scan (read-only — do not ask about anything you can find)

Run these and record what you learn. Do not stop at the first app: multi-app repos and sibling repos are the norm.

| Look for | How | Fills |
|---|---|---|
| Apps + frameworks | `package.json` at root and in any workspace/app dirs; check dependencies for `vue`, `react`, `vuetify`, `@mui/material`, `next`, `svelte` | `apps.<name>.framework` |
| Playwright version | `@playwright/test` / `playwright` in devDependencies; `npx playwright --version` | `auth.playwright_min` |
| Existing spec dirs | `playwright.config.*`, `e2e/`, `tests/e2e/`, `cypress/` | `apps.<name>.spec_dir` |
| Sandbox / mock mode | grep for `API_MODE`, `VITE_API_MODE`, `MOCK`, `USE_MOCKS` in `.env*`, `vite.config.*`, `package.json` scripts | `sandbox.mode` |
| Selector convention | count occurrences: `grep -ro 'data-testid' --include=*.vue --include=*.tsx --include=*.jsx . \| wc -l` and the same for `data-test`, `data-cy` | `selectors.testid_attribute` |
| House rules / style docs | `CLAUDE.md`, `CONTRIBUTING.md`, `UI_GUIDELINES.md`, `docs/` | `selectors.policy_doc` |
| Sibling app repos | if the user mentions a second frontend, check sibling dirs for its `package.json` | second `apps` entry + `repo` |

**Adopt what exists, never replace it.** An existing Playwright config, spec directory, or CI workflow is a fact about this host, not a thing to overwrite.

Report the scan results to the user in a short table before you start asking questions. They will correct you faster than they will answer from scratch.

## 2. Interview (only for what discovery cannot know)

Use `AskUserQuestion`. Ask in this order, batching related questions:

1. **Environments** — names (typically `qa`, `staging`), and the base URL of each app in each. These must be **deployed** environments; localhost is not verdict-eligible.
2. **Deploy-SHA source** — the URL that reports the running build's commit (e.g. `https://qa.example.com/api/version`) and how to extract it: a dot path into the JSON response (`build.commit`) or a regex with one capture group. **If there is no such endpoint, say so plainly: this is a Phase-0 blocker, not a detail.** Record it in the gap report and leave the profile invalid until it exists — a SHA that cannot be read means no run can ever be published.
3. **Auth model** — `dev-handoff` (each dev logs in once through a headed browser), `role-accounts` (dedicated per-role accounts), or `mixed` (both — the usual answer when permission cases are in scope).
4. **Assertions** — ask whether application operations are visible as network requests in the browser Network tab. Engine-dispatched, worker-dispatched, or WebSocket-multiplexed apps answer "no" → `network_events: forbidden` + `style: ui-state`. When forbidden, ask whether the app emits structured console logs that could serve as failure evidence → `evidence.extra: [console_log]`.
5. **Approved generation models** — which model IDs may author test cases. Default to the current strongest available model. This list is a gate: `validate-cases.mjs` rejects cases stamped with anything else, so a model upgrade cannot silently change case quality without QA adding it here.
6. **Cross-app propagation** (multi-app only) — if a change in app A becomes visible in app B only after a delay (polling bridge, queue, cache), ask for the worst-case window in seconds, then set `propagation_window_s` to roughly 3× the observed window as a ceiling for `expect.poll`.
7. **ClickUp** — space name holding QA work, and the plan tier (sets the API rate budget: Free–Business = 100 requests/min per token).

## 3. Emit the profile

Write the profile to the resolved path, following `${CLAUDE_PLUGIN_ROOT}/schemas/qa-pilot.config.schema.md` exactly. Include brief comments for values a future reader would question (why the propagation window is what it is, why network assertions are forbidden).

Then validate and **loop until it passes**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <path>
```

Fix every error. Report every warning to the user rather than silencing it.

## 4. Gap report

Print (do not write to a file) the prerequisites this host must close before the pipeline is trustworthy. For each gap, name the skill it blocks. Typical gaps:

| Gap | Blocks |
|---|---|
| No deploy-SHA endpoint | `/run-tests` and `/publish-results` — every run, permanently |
| No test-id attributes in the codebase | spec durability; specs will bind to fragile selectors and rot |
| Playwright < 1.51 | `/setup-profiles` — IndexedDB-persisted auth (Firebase) will not restore |
| No sandbox/mock mode | spec stabilization competes for the shared deployed environment |
| No role accounts yet | permission-type cases in `/generate-tests` |
| ClickUp space, statuses or custom fields not created | `/publish-results` — see below |
| Deployed builds strip console logs | failure evidence on hosts where console output is the required evidence |
| Private Attachment Links not enabled in ClickUp | evidence privacy — attachment URLs are public, unauthenticated and non-expiring by default, and traces carry application state |
| All developers sharing one ClickUp API token | `/publish-results` under concurrency — the 100 req/min budget is per token, so a shared token is shared by everyone publishing at once |

**The plugin does not create the ClickUp structure — the user does, once.** Point them at
`${CLAUDE_PLUGIN_ROOT}/SETUP-CLICKUP.md`, which lists the exact statuses, the exact custom
fields and their dropdown options, and the two settings above. Names are matched literally
by `/publish-results`, so "roughly right" fails at publish time.

Two of the dropdowns (`Env`, `App`) and one option of `API Mode` are host-specific — their
values come from the profile you just wrote. Tell the user the concrete values to create
rather than making them derive them: list the environment names, the app names, and the
sandbox value from this host's profile.

## 5. Hand off

Tell the user to **commit the profile** — the other skills verify it is committed (`git ls-files --error-unmatch`), because an uncommitted profile means five developers are testing against five different definitions of the truth.

Then state the next step: `/qa-pilot:setup-profiles` to save auth profiles, then `/qa-pilot:generate-tests <feature>` for the pilot feature.
