---
name: setup-profiles
description: Create or refresh Playwright authentication profiles by handing a headed browser to the user for a one-time login per account. Use when the user says "setup profiles", "save my login", "authenticate for tests", or before the first test run in a repo.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# setup-profiles: save reusable login sessions

Any current model is fine; this is orchestration around a human login.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP and point at `/qa-pilot:qa-init`. You need `auth.playwright_min`, `auth.storage_state.dir`, and the environment URLs from it.

## 1. Check the Playwright version

```bash
npx playwright --version
```

Must be ≥ the profile's `auth.playwright_min` (never below 1.51). If lower, stop and tell the user to run `npm i -D @playwright/test@^1.51` in the host repo. Below 1.51 a profile omits IndexedDB and fails later inside a spec.

## 2. Decide which profiles to create

Ask the user which accounts they need:

- **Their own account**, per app in the profile's `apps`. This is the everyday executor identity and keeps the report's `executor` field truthful.
- **Role accounts**: one per role the permission cases exercise (viewer, member, admin, any cross-tenant account). Permission cases cannot run without them.
- **The CI account**, if setting up CI. No MFA; its credentials belong in CI secrets, never the repo.

Name profiles `<app>-<role>` (e.g. `storefront-viewer`, `admin-owner`). Record the set in `<storage_state.dir>/profiles.json` as `{ "<name>": { "app": "...", "role": "...", "url": "...", "saved_at": "..." } }` so a refresh knows what existed.

## 3. Capture each profile

**Do not run the capture command yourself.** It opens a headed browser and waits at a prompt for a human; your Bash tool has no interactive terminal, so it would hang (the script refuses immediately when it detects this).

**Give the user the exact command to paste into their own terminal**, one per profile, fully resolved: no `${CLAUDE_PLUGIN_ROOT}`, no placeholders, because those do not expand in their shell. Resolve the plugin root to an absolute path first:

```bash
cd <host repo root>
node <absolute path to plugin>/scripts/save-storage-state.mjs \
  --url <login URL for that app and environment> \
  --out <storage_state.dir>/<name>.json
```

It must run from the **host repo root** so Playwright resolves from the host at the pinned version.

Tell them: a browser opens, they sign in (including OAuth and 2FA), press Enter in that terminal once on a signed-in page, then say here that it is done.

**Never type credentials yourself, and never ask for them.** If a user offers a password, decline and point them back at their own terminal.

The script saves cookies, localStorage and IndexedDB. When the user reports back, read the output file: if an app you know uses Firebase Auth produced no IndexedDB entries, the login did not complete; have them re-run rather than accepting it.

## 4. Keep the profiles out of git

Saved profiles are live credentials. Confirm `<storage_state.dir>/` is gitignored; add it if not (e.g. `.playwright/profiles/`) and say so plainly.

## 5. Verify one profile before declaring success

**This part you do run.** Verification is headless: load the saved state, open an authenticated URL, and confirm a signed-in element renders rather than the login form.

```bash
npx playwright test --project=chromium <a one-off spec using test.use({ storageState })>
```

Specs consume profiles with `test.use({ storageState: '<path>' })` or per-project in the Playwright config; `/qa-pilot:run-tests` wires this automatically.

## 6. Refresh

Sessions expire. When a run fails with cases landing on a login page, the profile is stale, not the feature broken: re-run this skill for that profile. Record the run as `blocked`, not `fail`, since an expired session is an environment problem.
