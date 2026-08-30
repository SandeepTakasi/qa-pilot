---
name: setup-profiles
description: Create or refresh Playwright authentication profiles by handing a headed browser to the user for a one-time login per account — capturing cookies, localStorage, and IndexedDB so Firebase-style sessions actually restore. Saves each session as a storageState file that specs reuse without further handoffs. Use when the user says "setup profiles", "save my login", "authenticate for tests", or before the first test run in a repo.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# setup-profiles — save reusable login sessions

Recommended model: any current model. This is orchestration around a human login.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP and point at `/qa-pilot:qa-init`. You need `auth.playwright_min`, `auth.storage_state.dir`, and the environment URLs from it.

## 1. Check the Playwright version

```bash
npx playwright --version
```

Must be ≥ the profile's `auth.playwright_min` (never below 1.51). If it is lower, stop and tell the user to upgrade the host repo: `npm i -D @playwright/test@^1.51`. Do not proceed — a profile captured below 1.51 omits IndexedDB and will fail at run time inside a spec, where it reads as a test failure rather than a setup problem.

## 2. Decide which profiles to create

Ask the user which accounts they need. Cover:

- **Their own account**, per app in the profile's `apps`. This is the everyday executor identity, and it is what makes the `executor` field on every report truthful.
- **Role accounts** — one per role the permission-type cases exercise (viewer, member, admin, and any cross-tenant account). A developer's personal account is one role in one tenant; permission cases cannot be executed without these.
- **The CI account**, if the user is setting up CI. It must have no MFA, and its credentials belong in CI secrets, never in the repo.

Name profiles `<app>-<role>` (e.g. `storefront-viewer`, `admin-owner`). Record the set in `<storage_state.dir>/profiles.json` as `{ "<name>": { "app": "...", "role": "...", "url": "...", "saved_at": "..." } }` so a later refresh knows what existed.

## 3. Capture each profile

**Do not run the capture command yourself.** It opens a headed browser and waits at a prompt for a human to finish signing in. Your Bash tool has no interactive terminal, so the prompt would never resolve: the browser would sit open, your call would time out, and nothing would be saved. The script detects this and refuses immediately rather than hanging — but the point is that this step belongs to the user, not to you.

Instead, **give the user the exact command to paste into their own terminal**, one per profile, with every value filled in — no `${CLAUDE_PLUGIN_ROOT}`, no placeholders, because those do not expand in their shell. Resolve the plugin root to a real absolute path first:

```bash
cd <host repo root>
node <absolute path to plugin>/scripts/save-storage-state.mjs \
  --url <login URL for that app and environment> \
  --out <storage_state.dir>/<name>.json
```

It must run from the **host repo root** so Playwright resolves from the host at the pinned version.

Tell them what to expect: a browser opens, they sign in — including OAuth and 2FA — and press Enter in that terminal once they are on a signed-in page. Then they come back here and say it is done.

**Never type credentials yourself, and never ask the user for them.** The entire reason this is a handoff is that credentials never pass through this session. If a user offers you a password, decline and point them back at their own terminal.

The script captures cookies, localStorage, **and IndexedDB** (`storageState({ indexedDB: true })`) and prints what it saved. When the user reports back, read the output file and check it yourself: if an app you know uses Firebase Auth produced no IndexedDB entries, the login did not complete — have them re-run rather than accepting the profile.

## 4. Keep the profiles out of git

Saved profiles are live credentials. Confirm `<storage_state.dir>/` is gitignored; add it if it is not, and say so plainly:

```
.playwright/profiles/
```

A committed storageState file is a leaked session for every account it holds.

## 5. Verify one profile before declaring success

**This part you do run.** Unlike the capture, verification is headless and needs no human: load the saved state, open an authenticated URL, and confirm a signed-in element renders rather than the login form.

```bash
npx playwright test --project=chromium <a one-off spec using test.use({ storageState })>
```

A profile that saved cleanly but does not restore is exactly the failure this step exists to catch, and it is worth catching now — otherwise it surfaces later inside a feature spec, where it reads as a test failure rather than a setup problem.

Specs consume profiles with `test.use({ storageState: '<path>' })`, or per-project in the Playwright config. `/qa-pilot:run-tests` wires this automatically.

## 6. Refresh

Sessions expire. When a run fails with cases landing on a login page, the profile is stale, not the feature broken — re-run this skill for that profile. Note in the report that the run was `blocked`, not `fail`: an expired session is an environment problem, and recording it as a failure pollutes the false-pass tracking that keeps the pipeline honest.
