---
name: generate-tests
description: Author test cases for a feature by reading the host's documentation sources, its ClickUp task and the relevant code paths, produce a lint-clean testing/<feature>/cases.yaml (25-case cap, mandatory scenario mix, every case carrying a verifiable assertion, a declared mutation policy), create one ClickUp task per case in Case Review status (or seed a local statuses file without a tracker), and record the case-ID to task-ID mapping. Cases are not executable until QA approves them. Use when the user says "generate tests", "author test cases", "write QA cases for <feature>", or "/generate-tests <feature> [<feature> ...]".
argument-hint: "<feature> [<feature> ...]"
---

# generate-tests: author the case set for one feature

This is the highest-judgment step in the pipeline and the one place model reasoning genuinely earns its cost. Everything downstream is deterministic. A shallow case set here produces confident green runs on a broken feature, which is the exact failure this system exists to prevent.

**Recommended model: the strongest available.** The 25-case cap makes generation cheap, so there is never a reason to economize here, including on P2 cases.

## 0. Profile gate

Resolve the profile path (userConfig `profile_path`, default `qa-pilot.config.yaml`) and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → **STOP**. Print the errors verbatim and tell the user to run `/qa-pilot:qa-init`.

Then check whether the profile is committed (`git ls-files --error-unmatch <profile-path>`). If it is not, **warn but continue**: an uncommitted profile is fine for a solo pilot and must be committed before the team relies on it, because otherwise five developers test against five different definitions of the truth. Some hosts deliberately gitignore it while trialling the pipeline, which is a legitimate choice rather than an error.

Use the JSON on stdout as your source for every project-specific value. Do not re-read the YAML yourself. Note its `tracker` (`clickup` unless it says `none`), which decides step 4.

## Several features at once

When the user names more than one feature, author them in parallel: **one subagent per feature**, each given the profile JSON, its one feature name, and this skill's steps 1 to 3. Each returns its `cases.yaml`, and you run `validate-cases.mjs` on every one yourself; a subagent saying it validated is not evidence. Features are independent at this stage, so the fan-out is safe.

Tracker writes are not parallel. Run step 4 yourself, one feature after another, at the pace it states: several subagents writing at once would exhaust the per-token rate budget together and leave half-synced lists.

## 1. Gather feature context

Do all of this before writing a single case:

1. **Documentation sources first**, when the profile has `context.sources`. Pick the sources whose `description` covers this feature and read them before anything else: documented intent is what an assertion should pin, and code only shows what was built.
   - A `path` source: read the files it names. Never open a `.env*` file, whatever a directory or glob matches.
   - A `command` source: **show the user the exact command and wait for their confirmation before its first run in this session**, then run it from the repo root and use its stdout. A committed profile is not a reason to run arbitrary commands unseen. Once confirmed, the same command may run again in this session without asking.
2. **The tracker task** (`tracker: clickup`): find the feature's task (`clickup_search` / `clickup_get_task`). Read the description, acceptance criteria, and comments. If the user gave a task ID or URL, use it directly. Under `tracker: none` there is no task; ask the user for the acceptance criteria if the documentation and code do not settle them.
3. **Code**: locate the routes, components, and state modules the feature touches. Read them. You are looking for the branches a test must cover: role checks, validation rules, empty and error states, limits and boundaries, and which actions create, change or delete data.
4. **Existing cases**: if `testing/<feature>/cases.yaml` already exists, read it. You are updating a QA-approved artifact, not replacing it: preserve existing IDs and their wording wherever the behavior is unchanged.

If the sources are thin and the code does not settle a question, ask the user. A guessed acceptance criterion becomes a wrong assertion that outlives the guess.

## 2. Author the cases

Follow `references/case-style.md` for composition rules, and `${CLAUDE_PLUGIN_ROOT}/schemas/cases.schema.md` for the exact field contract.

The rules that matter most:

- **Every case needs at least one expected outcome a Playwright assertion could check.** Name the element, the text, the visible state. "Order succeeds" is not an outcome; "the order confirmation panel shows an order number" is.
- **When the profile sets `assertions.network_events: forbidden`, never write a network expectation.** On such hosts the operation never reaches the Network tab, so a network wait silently no-ops and the test passes regardless of whether the feature works. Assert on rendered UI state.
- **Cover the scenario mix**: happy, negative, boundary, permission, data-validation. Each is either represented by a case or explicitly marked `n_a` with a reason. A missing permission case on a role-aware feature is a hole, not an omission.
- **Stay under 25 cases.** If the feature needs more, it is more than one feature, so split it into sub-features with their own directories. Case count is an anti-metric; approved coverage and defects caught are the real ones.
- Stamp `model_version` with your own model ID and `generated_at` with the current UTC timestamp.

**Declare whether the specs may write**, as the `mutation` block (see "May these tests write?" in the cases schema):

- `read-only` when every case only looks: listing, opening, filtering, reading a report. This is the only policy a feature can run under on production if it must not create data there.
- `scoped-write` with a `prefix` (at least three of `A-Z a-z 0-9 _ -`, such as `QA_TEST_`) when the cases create, change or delete things, but only things the tests themselves made. Write every step that creates an entity so its name starts with the prefix, because the write guard only unlocks write controls in a row or dialog that shows it.
- `unrestricted` only off production, for a feature whose cases legitimately touch shared data. Leaving `mutation` out means `unrestricted`; on production that is refused, so for any feature that may ever run there, write the block.

When several cases need the same built-up entity (one project created once, then edited by many cases), declare it under `fixtures` with `teardown: keep` or `delete` and give each such case `fixture: <name>`, rather than having every case build its own. Fixtures are not allowed under `read-only`. Say in your hand-off which fixtures you declared, since each one is a setup spec `/qa-pilot:run-tests` will write.

**Link the cases to the acceptance criteria**, when step 1 turned up stated criteria for the feature (the task's, or the documentation's). Declare them in an optional top-level `requirements` block: one entry per requirement with its `title` and `criteria`, each criterion an `id` and the `text` as the task states it. Then give every case `covers: ["<requirement id>/<criterion id>", ...]` naming the criteria it tests (see "Requirements and coverage" in the cases schema).

- Quote an id that looks like a number (`id: "1"`, `id: "1.10"`): YAML reads an unquoted one as a number, and the lint refuses it. A requirement id is at most 64 characters.
- Copy the criteria; never invent one to give a case something to cover. A case that tests no stated criterion simply has no `covers`.
- A criterion no case covers is a **warning**, not an error: a design gap QA decides on. Either write the case that tests it, or leave the warning and name the criterion in your hand-off. Do not delete a criterion to silence it, and do not point `covers` at a case that does not test it.
- A feature with no stated criteria keeps working with neither key. Leave both out rather than writing criteria of your own.

## 3. Validate, and loop until clean

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-cases.mjs" testing/<feature>/cases.yaml --profile <profile-path>
```

Fix every error and re-run. Warnings print on stderr and do not fail the file; read each one (an uncovered criterion is a decision for QA, so list them in your hand-off). Do not proceed to ClickUp with a failing file, and never work around a lint error by weakening the case. If the assertion lint rejects an outcome, the outcome was not verifiable, and rewording it to slip past the check reintroduces exactly the problem the check exists to catch.

If the lint warns that `model_version` is not in `models.generation_approved`, the file still passes. Carry the warning into your hand-off so QA reviews these cases with that model in mind; QA adds the model to the list once they trust it. A missing `model_version` is still an error.

## 4. Register the cases for review

**Under `tracker: none`** there is nothing to create. Seed `testing/<feature>/statuses.json` with every case at `Case Review`, keeping the status of any case already in the file unless step 2 changed it (then reset it to `Case Review` and say so), and stop here:

```json
{ "CHECKOUT-ORDER-001": "Case Review", "CHECKOUT-ORDER-002": "Case Review" }
```

QA approves cases by editing that file to `Approved for Execution`. `/qa-pilot:run-tests` reads it instead of a tracker.

**With ClickUp** (`tracker: clickup`), create the tasks. Skip this entirely if the ClickUp MCP tools are unavailable: the validated `cases.yaml` still stands, and the user can re-run later to sync. Say clearly that sync was skipped.

1. Create the write flag the plugin's guard hook checks, at the repo root next to the profile: `mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes` (it expires after 30 minutes, so a dead session cannot leave writes open)
2. Read `testing/<feature>/clickup-map.json` if it exists. **Every case already in the map is updated, never recreated**, and this is what makes reruns idempotent. Never look tasks up by name.

   **If you changed an existing case's steps, expected outcomes, priority, or type, move it back to `case_review`** and say which cases you reset and why. Design approval belongs to the case QA actually read; editing the assertions of an approved case and leaving it approved walks a changed test straight past the design gate. Pure wording or title tidying that leaves the behaviour identical does not need a reset, but when in doubt, reset: a re-approval costs QA a minute, an unnoticed change costs a false verdict.
3. Locate the feature's list. It lives in the profile's `clickup.folder` inside `clickup.space`, and the list is named after the feature. **Resolve the folder first, then the list within it**: a space commonly holds several folders, and searching the space by list name alone can land on someone else's manual QA list. If the profile declares no folder, ask the user which one to use rather than guessing, and suggest they add `clickup.folder` so the next run does not have to ask.
4. For each unmapped case, create a task in that list:
   - title: `<CASE-ID> <Title>`
   - description: preconditions, steps, and expected outcomes as written
   - status: this host's name for `case_review`, from the profile's `clickup.statuses`
   - custom fields: Priority, Type, Model Version
5. Pace the calls: one request per second, sequential. Free through Business tiers allow 100 requests per minute per token, and a full 25-case feature plus retries gets close enough to matter.
6. Write the merged mapping back to `testing/<feature>/clickup-map.json` (`{"CASE-ID": "task-id"}`) and commit-worthy.
7. Remove the flag: `rm -f .qa-pilot/allow-clickup-writes`

## 5. Hand off

State plainly, every time: **these cases are not executable yet.** QA reviews the scenario matrix, the declared mutation policy, any uncovered criterion, and every P0/P1 case individually, approves P2 in bulk at matrix level, and moves approved cases into `approved_for_execution` (in ClickUp, or in `testing/<feature>/statuses.json` under `tracker: none`). `/qa-pilot:run-tests` refuses anything else.

Then tell the user the next command: `/qa-pilot:run-tests <feature> --env <name>` once approval lands.
