---
name: generate-tests
description: Author test cases for a feature from the host's documentation sources, its tracker task and the relevant code, producing a lint-clean testing/<feature>/cases.yaml and registering each case for QA review. Cases are not executable until QA approves them. Use when the user says "generate tests", "author test cases", "write QA cases for <feature>", or "/generate-tests <feature> [<feature> ...]".
argument-hint: "<feature> [<feature> ...]"
---

# generate-tests: author the case set for one feature

This is the highest-judgment step in the pipeline; everything downstream is deterministic. A shallow case set here produces confident green runs on a broken feature. **Use the strongest available model**; the 25-case cap makes generation cheap, so do not economize, even on P2.

## 0. Profile gate

Resolve the profile path (userConfig `profile_path`, default `qa-pilot.config.yaml`) and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → **STOP**. Print the errors verbatim and tell the user to run `/qa-pilot:qa-init`.

Then check the profile is committed (`git ls-files --error-unmatch <profile-path>`). If not, **warn but continue**: fine for a solo pilot, must be committed before the team relies on it.

Use the JSON on stdout for every project-specific value; do not re-read the YAML. Note its `tracker` (`clickup` unless `none`), which decides step 4. When it is `clickup`, read `references/clickup.md` too.

## Several features at once

Author them in parallel: **one subagent per feature**, each given the profile JSON, its one feature name, steps 1 to 3, and `${CLAUDE_PLUGIN_ROOT}/skills/generate-tests/references/clickup.md` when the tracker is clickup. Run `validate-cases.mjs` on every returned `cases.yaml` yourself; a subagent saying it validated is not evidence.

Tracker writes are not parallel. Run step 4 yourself, one feature after another, at the pace in `references/clickup.md`, so the rate budget is not exhausted and no list is left half-synced.

## 1. Gather feature context

Do all of this before writing a case:

1. **Documentation sources first**, when the profile has `context.sources`. Read the sources whose `description` covers this feature: documented intent is what an assertion should pin, and code only shows what was built.
   - `path` source: read the files it names. Never open a `.env*` file, whatever a directory or glob matches.
   - `command` source: **show the user the exact command and wait for confirmation before its first run in this session**, then run it from the repo root and use its stdout. Once confirmed, it may run again this session without asking.
2. **The tracker task** (`tracker: clickup`): see `references/clickup.md`. Under `tracker: none` there is no task; ask the user for the acceptance criteria if the documentation and code do not settle them.
3. **Code**: read the routes, components and state modules the feature touches, looking for the branches a test must cover: role checks, validation rules, empty and error states, limits and boundaries, and which actions create, change or delete data.
4. **Existing cases**: if `testing/<feature>/cases.yaml` exists, read it. It is a QA-approved artifact: preserve existing IDs and their wording wherever behaviour is unchanged.

If the sources are thin and the code does not settle a question, ask the user; a guessed acceptance criterion becomes a wrong assertion.

## 2. Author the cases

Follow `references/case-style.md` for composition and `${CLAUDE_PLUGIN_ROOT}/schemas/cases.schema.md` for the field contract. The rules that matter most:

- **Every case needs at least one expected outcome a Playwright assertion could check.** Name the element, text or visible state. "Order succeeds" is not an outcome; "the order confirmation panel shows an order number" is.
- **When the profile sets `assertions.network_events: forbidden`, never write a network expectation**: the wait silently no-ops and the test passes regardless. Assert on rendered UI state.
- **Cover the scenario mix**: happy, negative, boundary, permission, data-validation. Each is represented by a case or marked `n_a` with a reason. A missing permission case on a role-aware feature is a hole.
- **Stay under 25 cases.** If the feature needs more, split it into sub-features with their own directories.
- Stamp `model_version` with your own model ID and `generated_at` with the current UTC timestamp.

**Declare whether the specs may write**, as the `mutation` block (see "May these tests write?" in the cases schema):

- `read-only`: every case only looks (list, open, filter, read a report). The only policy a feature can run under on production if it must not create data there.
- `scoped-write` with a `prefix` (at least three of `A-Z a-z 0-9 _ -`, such as `QA_TEST_`): cases create, change or delete only things the tests made. Every step that creates an entity must name it with the prefix, because the write guard only unlocks write controls in a row or dialog that shows it. Data a case creates outlives the run and is shared with every other run on that environment, so write expected outcomes about the entity the case created, never about counts or empty states ("the list shows 3 items" fails from the second run on), and end each case by deleting what it made, or use a `teardown: delete` fixture.
- `unrestricted`: only off production. Leaving `mutation` out means `unrestricted`, which production refuses, so write the block for any feature that may ever run there.

When several cases need the same built-up entity, declare it under `fixtures` with `teardown: keep` or `delete` and give each such case `fixture: <name>`, instead of each case building its own. Fixtures are not allowed under `read-only`. Name the declared fixtures in your hand-off: each is a setup spec `/qa-pilot:run-tests` will write.

**Link cases to acceptance criteria** when step 1 found stated criteria (the task's or the documentation's). Declare an optional top-level `requirements` block (each entry a `title` and `criteria`, each criterion an `id` and its `text` as stated), and give every case `covers: ["<requirement id>/<criterion id>", ...]` (see "Requirements and coverage" in the cases schema).

- Copy criteria; never invent one for a case to cover. A case testing no stated criterion has no `covers`.
- An uncovered criterion is a **warning**, a design gap QA decides on: write the case, or leave the warning and name the criterion in your hand-off. Never delete a criterion to silence it, and never point `covers` at a case that does not test it.
- No stated criteria: leave both keys out.

## 3. Validate, and loop until clean

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-cases.mjs" testing/<feature>/cases.yaml --profile <profile-path>
```

Fix every error and re-run. Read each warning (they print on stderr and do not fail the file); list uncovered criteria in your hand-off. Do not proceed to step 4 with a failing file, and never work around a lint error by weakening the case: if the assertion lint rejects an outcome, it was not verifiable, and rewording it to slip past reintroduces the problem.

If the lint warns that `model_version` is not in `models.generation_approved`, carry the warning into your hand-off so QA reviews with that model in mind. A missing `model_version` is an error.

## 4. Register the cases for review

**Under `tracker: none`**, seed `testing/<feature>/statuses.json` with every case at `Case Review`, keeping the status of any case already in the file unless step 2 changed it (then reset it to `Case Review` and say so), and stop:

```json
{ "CHECKOUT-ORDER-001": "Case Review", "CHECKOUT-ORDER-002": "Case Review" }
```

QA approves by editing that file to `Approved for Execution`; `/qa-pilot:run-tests` reads it instead of a tracker.

**Under `tracker: clickup`**, follow `references/clickup.md` to create the tasks.

## 5. Hand off

State plainly, every time: **these cases are not executable yet.** QA reviews the scenario matrix, the declared mutation policy, any uncovered criterion and every P0/P1 case individually, approves P2 in bulk at matrix level, and moves approved cases into `approved_for_execution` (in ClickUp, or in `testing/<feature>/statuses.json` under `tracker: none`). `/qa-pilot:run-tests` refuses anything else.

Then give the next command: `/qa-pilot:run-tests <feature> --env <name>` once approval lands.
