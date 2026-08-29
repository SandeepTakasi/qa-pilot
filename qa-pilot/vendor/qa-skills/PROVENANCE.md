# Vendored from neonwatty/qa-skills

| | |
|---|---|
| Upstream | https://github.com/neonwatty/qa-skills |
| License | MIT (see `LICENSE` in this directory) |
| Pinned commit | `bec03b91fe257b56f024a4f44a14c130c1abf5fd` |
| Upstream last push | 2026-05-03 |
| Vendored on | 2026-08-30 |

Upstream is functionally dormant — 27 stars, no commits in roughly four months. We treat this as **code we own from day one**, not a dependency: files here are copied at a pinned commit, and there is no runtime dependency on the upstream project. Do not add an update mechanism; if upstream revives and something is worth taking, copy it deliberately and re-run the audit below.

## Vendored verbatim

| File | Used by |
|---|---|
| `references/action-mapping.md` | `run-tests` — workflow phrasing to Playwright calls |
| `references/selector-discovery.md` | `run-tests` — selector strategy when test IDs are absent |
| `references/automation-limitations.md` | `generate-tests` — what cannot be automated, so cases do not promise it |
| `references/multi-context-patterns.md` | `run-tests` — multi-context specs for cross-app flows |

These files are **not edited**. Corrections belong in our own skill references, which cite them.

## Adapted, not vendored

**`commands/setup-profiles.md` → `skills/setup-profiles/SKILL.md`.** The upstream flow is sound — headed browser, human logs in, session saved, reused across runs — but its capture step uses `playwright-cli state-save`, which persists cookies and localStorage (plus a hand-merged sessionStorage) and **not IndexedDB**. Firebase Auth stores its tokens in IndexedDB, so a profile captured the upstream way restores as signed-out and fails inside a spec, where it reads as a test failure rather than a setup problem.

Our `scripts/save-storage-state.mjs` replaces that step with `context.storageState({ path, indexedDB: true })`, which requires Playwright ≥ 1.51. That version floor is enforced twice: in the host profile schema (`auth.playwright_min`) and in the script itself.

Also dropped from the adaptation: upstream's test-fixture-upload section (Step 6.5) — no upload workflows in scope for v1.

**`skills/use-profiles`** — folded into `skills/run-tests/references/spec-conventions.md` as `test.use({ storageState })`. Committed specs load state declaratively; they do not shell out to a CLI to load it.

**CI scaffolding** from the workflow-to-playwright skills — reduced to guidance in `run-tests`. We do not generate a self-contained CI project, because our specs live in the host repo's own spec dir and its own CI, adopted rather than replaced.

## Deliberately not taken

| Upstream component | Why not |
|---|---|
| workflow generators (`desktop-`, `mobile-`, `multi-user-workflow-generator`) | `cases.yaml` plus QA approval replaces free-form workflow markdown, and the approval gate is the point |
| `playwright-runner` | An interactive workflow executor formalizes exactly the agentic-run-as-evidence path we forbid; verdicts come from `npx playwright test` |
| `commands/run-qa.md` | superseded by `/qa-pilot:run-tests` with its approval and environment gates |
| audit skills and `agents/*` (adversarial-breaker, ux-auditor, security-auditor, performance-profiler, …) | useful for exploratory passes, but their outputs are observations, never verdicts. Out of v1 scope; revisit in Phase 4 |
| `submit-learnings` / `review-learnings` | phones home to the upstream project |
| `skills/multi-user-workflow-to-playwright/examples/api-helpers.md` | **built on network-visible API calls.** Invalid on hosts where `assertions.network_events: forbidden`, which is the first host we onboard. Taking it would have imported the exact false-green pattern this pipeline exists to prevent |
| husky / commitlint / release tooling, `scripts/validate-*.sh` | `claude plugin validate` and `node --test` cover our needs |

## First-fork audit: fetch-visible-traffic assumptions

Upstream targets apps whose operations are ordinary `fetch` calls. On engine-dispatched, worker-dispatched, or socket-multiplexed hosts, operations never surface as network events — so any guidance built on observing traffic silently no-ops and produces passing tests on broken features.

Audit run 2026-08-30 against the vendored set, grepping for `waitForResponse`, `waitForRequest`, `page.route`, `networkidle`, `waitForLoadState`, and assertions on requests, responses, or status codes.

**Result: clean.** Three matches in `automation-limitations.md`, all benign — network *throttling* as a browser condition (line 42–44) and network timeouts as a retry class (line 157). Neither asserts on traffic. The vendored files use web-first assertions on UI state throughout, which is what our profiles require.

`api-helpers.md` was the one real offender and was excluded rather than annotated.

**Re-run this audit whenever a file is added here.**
