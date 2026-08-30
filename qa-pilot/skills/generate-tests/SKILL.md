---
name: generate-tests
description: Author test cases for a feature — read its ClickUp task and the relevant code paths, produce a lint-clean testing/<feature>/cases.yaml (25-case cap, mandatory scenario mix, every case carrying a verifiable assertion), create one ClickUp task per case in Case Review status, and record the case-ID to task-ID mapping. Cases are not executable until QA approves them. Use when the user says "generate tests", "author test cases", "write QA cases for <feature>", or "/generate-tests <feature>".
argument-hint: "<feature>"
---

# generate-tests — author the case set for one feature

This is the highest-judgment step in the pipeline and the one place model reasoning genuinely earns its cost. Everything downstream is deterministic. A shallow case set here produces confident green runs on a broken feature — the exact failure this system exists to prevent.

**Recommended model: the strongest available.** The 25-case cap makes generation cheap, so there is never a reason to economize here — including on P2 cases.

## 0. Profile gate

Resolve the profile path (userConfig `profile_path`, default `qa-pilot.config.yaml`) and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → **STOP**. Print the errors verbatim and tell the user to run `/qa-pilot:qa-init`. Also confirm the profile is committed (`git ls-files --error-unmatch <profile-path>`); if it is not, stop and say so — an uncommitted profile means each developer is testing against a different definition of the truth.

Use the JSON on stdout as your source for every project-specific value. Do not re-read the YAML yourself.

## 1. Gather feature context

Do all of this before writing a single case:

1. **ClickUp** — find the feature's task (`clickup_search` / `clickup_get_task`). Read the description, acceptance criteria, and comments. If the user gave a task ID or URL, use it directly.
2. **Code** — locate the routes, components, and state modules the feature touches. Read them. You are looking for the branches a test must cover: role checks, validation rules, empty and error states, limits and boundaries.
3. **Existing cases** — if `testing/<feature>/cases.yaml` already exists, read it. You are updating a QA-approved artifact, not replacing it: preserve existing IDs and their wording wherever the behavior is unchanged.

If the ClickUp task is thin and the code does not settle a question, ask the user. A guessed acceptance criterion becomes a wrong assertion that outlives the guess.

## 2. Author the cases

Follow `references/case-style.md` for composition rules, and `${CLAUDE_PLUGIN_ROOT}/schemas/cases.schema.md` for the exact field contract.

The rules that matter most:

- **Every case needs at least one expected outcome a Playwright assertion could check.** Name the element, the text, the visible state. "Order succeeds" is not an outcome; "the order confirmation panel shows an order number" is.
- **When the profile sets `assertions.network_events: forbidden`, never write a network expectation.** On such hosts the operation never reaches the Network tab, so a network wait silently no-ops and the test passes regardless of whether the feature works. Assert on rendered UI state.
- **Cover the scenario mix**: happy, negative, boundary, permission, data-validation. Each is either represented by a case or explicitly marked `n_a` with a reason. A missing permission case on a role-aware feature is a hole, not an omission.
- **Stay under 25 cases.** If the feature needs more, it is more than one feature — split it into sub-features with their own directories. Case count is an anti-metric; approved coverage and defects caught are the real ones.
- Stamp `model_version` with your own model ID and `generated_at` with the current UTC timestamp.

## 3. Validate — loop until clean

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-cases.mjs" testing/<feature>/cases.yaml --profile <profile-path>
```

Fix every error and re-run. Do not proceed to ClickUp with a failing file, and never work around a lint error by weakening the case — if the assertion lint rejects an outcome, the outcome was not verifiable, and rewording it to slip past the check reintroduces exactly the problem the check exists to catch.

If `model_version` is rejected, your model is not on the profile's approved list. Stop and tell the user: QA adds a model to `models.generation_approved` after a calibration pass, not mid-run.

## 4. Create the ClickUp tasks

Skip this section entirely if the ClickUp MCP tools are unavailable — the validated `cases.yaml` still stands, and the user can re-run later to sync. Say clearly that sync was skipped.

1. Create the write flag the plugin's guard hook checks: `mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes` (it expires after 30 minutes, so a dead session cannot leave writes open)
2. Read `testing/<feature>/clickup-map.json` if it exists. **Every case already in the map is updated, never recreated** — this is what makes reruns idempotent. Never look tasks up by name.

   **If you changed an existing case's steps, expected outcomes, priority, or type, move it back to `Case Review`** and say which cases you reset and why. Design approval belongs to the case QA actually read; editing the assertions of an approved case and leaving it approved walks a changed test straight past the design gate. Pure wording or title tidying that leaves the behaviour identical does not need a reset — but when in doubt, reset: a re-approval costs QA a minute, an unnoticed change costs a false verdict.
3. For each unmapped case, create a task in the feature's list under the profile's `clickup.space`:
   - title: `<CASE-ID> <Title>`
   - description: preconditions, steps, and expected outcomes as written
   - status: `Case Review`
   - custom fields: Priority, Type, Model Version
4. Pace the calls: one request per second, sequential. Free through Business tiers allow 100 requests per minute per token, and a full 25-case feature plus retries gets close enough to matter.
5. Write the merged mapping back to `testing/<feature>/clickup-map.json` (`{"CASE-ID": "task-id"}`) and commit-worthy.
6. Remove the flag: `rm -f .qa-pilot/allow-clickup-writes`

## 5. Hand off

State plainly, every time: **these cases are not executable yet.** QA reviews the scenario matrix and every P0/P1 case individually, approves P2 in bulk at matrix level, and moves approved cases to `Approved for Execution`. `/qa-pilot:run-tests` refuses anything else.

Then tell the user the next command: `/qa-pilot:run-tests <feature> --env <name>` once approval lands.
