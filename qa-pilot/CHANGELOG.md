# Changelog

## 0.1.0 — 2026-08-30

First build. Implements PRD v1.0.

- `qa-init`, `generate-tests`, `run-tests`, `publish-results`, `qa-review`, `setup-profiles` skills
- Deterministic validators: host profile, cases, deploy SHA, report parse, publish gate
- ClickUp write guard (PreToolUse hook) — the scripted path is the only write path
- No third-party code except `scripts/lib/yaml.mjs`, a bundled copy of yaml@2 (MIT)

Deviations from the PRD, each forced by a verified constraint:

- Scripts are zero-dependency Node ESM (`.mjs`), not TypeScript — a plugin must not require
  a build step or an npm install in the host repo.
- **The qa-skills fork was dropped.** The PRD called for forking and vendoring
  neonwatty/qa-skills, on the assumption we would adopt its converters, generators,
  playwright-runner and CI scaffolding. All of those were skipped for good reasons, leaving
  only four reference documents — which nothing referenced, which were largely mobile and
  iOS guidance for a desktop-web pipeline, and which carried no network-assertion ban and a
  hardcoded sync timeout that contradicts our profile-driven ceiling. Our own
  `spec-conventions.md` and `case-style.md` cover the relevant ground, profile-aware.
- `/setup-profiles` keeps the upstream *approach* — headed browser, human logs in once,
  session reused — but is written from scratch. Upstream captures via
  `playwright-cli state-save`, which omits IndexedDB and so loses Firebase auth. Replaced
  with `save-storage-state.mjs` using `storageState({ indexedDB: true })`.
- `publish-clickup.ts` is not a script. ClickUp writes are driven by skill instructions
  over MCP, with the deterministic work (parse, validate) staying in scripts.
- The write guard scopes by flag file rather than by ClickUp space; checking the target
  space would require an authenticated API call from inside a hook.
