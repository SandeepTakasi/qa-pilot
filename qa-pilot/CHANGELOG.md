# Changelog

## 0.1.0 — 2026-08-30

First build. Implements PRD v1.0.

- `qa-init`, `generate-tests`, `run-tests`, `publish-results`, `qa-review`, `setup-profiles` skills
- Deterministic validators: host profile, cases, deploy SHA, report parse, publish gate
- ClickUp write guard (PreToolUse hook) — the scripted path is the only write path
- Vendored references from neonwatty/qa-skills at `bec03b91`, MIT

Deviations from the PRD, each forced by a verified constraint:

- Scripts are zero-dependency Node ESM (`.mjs`), not TypeScript — a plugin must not require
  a build step or an npm install in the host repo.
- `/setup-profiles` could not be adopted from upstream as-is: it captures via
  `playwright-cli state-save`, which omits IndexedDB and so loses Firebase auth.
  Replaced with `save-storage-state.mjs` using `storageState({ indexedDB: true })`.
- `publish-clickup.ts` is not a script. ClickUp writes are driven by skill instructions
  over MCP, with the deterministic work (parse, validate) staying in scripts.
- The write guard scopes by flag file rather than by ClickUp space; checking the target
  space would require an authenticated API call from inside a hook.
