# `testing/<feature>/cases.yaml`: test case schema

Written by `/qa-pilot:generate-tests`, approved by QA in ClickUp (or in `testing/<feature>/statuses.json` under `tracker: none`), converted to Playwright specs by `/qa-pilot:run-tests`. Enforced by `scripts/validate-cases.mjs`.

The schema exists to make three failure modes impossible rather than discouraged: assertion-free "green" cases, missing scenario categories, and slop volume.

```yaml
feature: string           # required, must match the containing directory name
model_version: string     # required, must be in profile models.generation_approved
generated_at: string      # required, ISO 8601 timestamp

scenario_mix:             # required: all five keys must be present
  happy: covered | { n_a: "<reason>" }
  negative: covered | { n_a: "<reason>" }
  boundary: covered | { n_a: "<reason>" }
  permission: covered | { n_a: "<reason>" }
  data-validation: covered | { n_a: "<reason>" }

mutation:                 # optional, default { policy: unrestricted }. See "May these tests write?"
  policy: read-only | scoped-write | unrestricted   # required when mutation is present
  prefix: string          # required when policy is scoped-write, forbidden otherwise;
                          # /^[A-Za-z0-9_-]{3,}$/

fixtures:                 # optional. See "Shared fixtures"
  - name: string          # required, /^[a-z0-9-]+$/, unique
    teardown: keep | delete   # required

requirements:             # optional. See "Requirements and coverage"
  - id: string            # required, a string, /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
                          # at most 64 characters, unique in the file
    title: string         # required, non-empty
    criteria:             # required, >= 1 entries
      - id: string        # required, a string, same pattern, unique within its requirement
        text: string      # required, non-empty

cases:                    # required, 1..25 entries, unique ids
  - id: AUTH-LOGIN-001    # required, /^[A-Z0-9]+-[A-Z0-9]+-\d{3}$/
    title: string         # required
    priority: P0 | P1 | P2                                    # required
    type: happy | negative | edge | permission | data-validation   # required
    preconditions: [string]   # optional list
    steps: [string]           # required, >= 1
    expected: [string]        # required, >= 1; see lint rules
    fixture: string           # optional; must name an entry in fixtures[]
    covers: [string]          # optional; "<requirement id>/<criterion id>" entries,
                              # each naming a declared criterion
```

## Validation rules

**Cap**: more than 25 cases is an error. Split the feature into sub-features instead. Volume is an anti-metric: the count of generated cases measures nothing.

**Scenario mix cross-check**: every type marked `covered` must have at least one matching case; a type with no case must be `{ n_a: reason }` with a non-empty reason. The `edge` case type satisfies the `boundary` mix slot.

**Assertion lint (the important one)**: every case needs at least one `expected` entry that could become a Playwright assertion. Rejected:

- entries shorter than 10 characters
- vague-outcome phrasing with no observable subject: "works", "is correct", "looks right", "as expected", "successfully", "no issues", "behaves properly"
- when the host profile sets `assertions.network_events: forbidden`: network-flavored phrasing such as request, response, API call, network, payload, endpoint, `status 2xx/4xx/5xx`. On engine-dispatched hosts these assertions silently no-op, producing exactly the false green this pipeline exists to prevent. Assert on rendered UI state instead.

**Model gate**: `model_version` must appear in the profile's `models.generation_approved`. A model upgrade cannot silently change case quality; QA adds the new model to the list after a calibration pass.

**Mutation and fixture lint**: each of these is an error.

- `mutation` present but not a mapping, `mutation.policy` missing or outside the enum, or any key under `mutation` other than `policy` and `prefix`
- `policy: scoped-write` with no `prefix`, or a `prefix` that does not match `/^[A-Za-z0-9_-]{3,}$/`
- a `prefix` under `read-only` or `unrestricted`
- `fixtures` present but not a list, an entry whose `name` is missing, duplicated or does not match `/^[a-z0-9-]+$/`, or whose `teardown` is not `keep` or `delete`
- any `fixtures` entry under `policy: read-only`: a fixture creates an entity, which a read-only feature cannot do
- a `cases[].fixture` that names no entry in `fixtures`

A declared fixture that no case names is a **warning**: its setup would run, and write, for nothing.

## May these tests write?

`mutation.policy` declares what this feature's specs may change on the environment they run against. The write guard (`templates/write-guard.fixture.ts`) enforces it in the browser, and the publish gate refuses a run that broke it. What counts as a write control or a write request comes from the host profile's `mutation` block.

| `policy` | A write control (save, delete, ...) | A request matching a write signature | Publishable when |
|---|---|---|---|
| `read-only` | blocked | aborted | the run recorded no blocked and no observed write |
| `scoped-write` | allowed only inside the scope (below), blocked elsewhere | allowed, recorded as observed | the run recorded no blocked write |
| `unrestricted` | allowed | allowed | always, as in 0.2.0 (never on production) |

**The scope** of a `scoped-write` feature: a write control is allowed when the page URL matches a scope URL the spec set with `setScope({ url })`, or when the control's **own** row (`tr`, `[role=row]`, `li`, `[role=listitem]`, `.v-list-item`) or the dialog containing it (`[role=dialog]`) contains `prefix`, in its text or in an input inside that element. An element that itself contains more than one row or list item never counts as the control's own row, so a toolbar above a list is not unlocked by one matching row in it. Entities a scoped-write feature creates must therefore carry `prefix` in their name, or their own controls are blocked. A request cannot be proved in scope, which is why write requests under `scoped-write` are recorded rather than judged.

**The default is `unrestricted`** so that 0.2.0 case files stay valid on `qa` and `staging` environments. It is refused on production: `/qa-pilot:run-tests` will not start a production run of an `unrestricted` feature, and the publish gate refuses one that ran anyway. This lint cannot enforce that itself, because a cases file does not know which environment it will run against.

## Requirements and coverage

`requirements` declares what the feature must do, as requirements broken into acceptance criteria, independently of the cases that test them. A case claims the criteria it tests with `covers`. Both keys are optional: a cases file with neither validates and reports exactly as before.

**Shape.** `requirements` is a list of `{ id, title, criteria }`, and `criteria` a list of `{ id, text }`. Every requirement id and criterion id is a string matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. YAML reads an unquoted `id: 1` as a number and `id: 1.10` as the number `1.1`, so quote any id that looks like a number: `id: "1"`, `id: "1.10"`. A requirement id is at most 64 characters, since it can reach a tracker record through `not_proved`. A requirement id is unique in the file; a criterion id is unique within its requirement, so two requirements may each have an `AC-1`. A case's `covers` is a list of references of the form `<requirement id>/<criterion id>`, each naming one declared criterion.

**Lint.** Each of these is an error, printed as `<path>: <message>` like every other `validate-cases.mjs` error. `<i>` and `<j>` are zero-based list positions. In `cases[<id>]`, `<id>` is the case's `id`, or its zero-based position when it has none, as in the other case errors. Regexes print without slashes.

A key set to `null` counts as missing for `id`, `title` and `text`, and as present for `requirements` and `covers` (the same `!== undefined` presence test the mutation lint uses), so `requirements: null` and `covers: null` are errors, not absent keys. An id gets at most one error: the first of its rows below that holds, in table order.

| Rule | Error |
|---|---|
| `requirements` present but not a list, or an empty list (`requirements: []`) | `requirements: must be a non-empty list of { id, title, criteria }` |
| an entry that is not a mapping | `requirements[<i>]: must be a mapping of id, title and criteria` |
| an entry key other than `id`, `title`, `criteria` | `requirements[<i>].<key>: unknown key (allowed: id, title, criteria)` |
| an entry with no `id`, or `id: null` | `requirements[<i>].id: required` |
| an entry `id` that is present but not a string (a number, a boolean, a list, a mapping) | `requirements[<i>].id: must be a string; quote it, e.g. id: "1"` |
| an entry `id` that is a string not matching the id pattern | `requirements[<i>].id: "<id>" must match ^[A-Za-z0-9][A-Za-z0-9._-]*$` |
| an entry `id` longer than 64 characters | `requirements[<i>].id: "<id>" must be at most 64 characters` |
| an entry `id` already used by an earlier entry | `requirements[<i>].id: "<id>" is declared twice` |
| a `title` missing, `null`, not a string, or empty or only whitespace | `requirements[<i>].title: required, non-empty string` |
| `criteria` missing, not a list, or empty | `requirements[<i>].criteria: required, at least one criterion` |
| a criterion that is not a mapping | `requirements[<i>].criteria[<j>]: must be a mapping of id and text` |
| a criterion key other than `id`, `text` | `requirements[<i>].criteria[<j>].<key>: unknown key (allowed: id, text)` |
| a criterion with no `id`, or `id: null` | `requirements[<i>].criteria[<j>].id: required` |
| a criterion `id` that is present but not a string | `requirements[<i>].criteria[<j>].id: must be a string; quote it, e.g. id: "1"` |
| a criterion `id` that is a string not matching the id pattern | `requirements[<i>].criteria[<j>].id: "<id>" must match ^[A-Za-z0-9][A-Za-z0-9._-]*$` |
| a criterion `id` already used earlier in the same requirement | `requirements[<i>].criteria[<j>].id: "<id>" is declared twice in requirements[<i>]` |
| a `text` missing, `null`, not a string, or empty or only whitespace | `requirements[<i>].criteria[<j>].text: required, non-empty string` |
| `covers` present (`null` included) but not a list, or a list with a non-string entry | `cases[<id>].covers: must be a list of strings` |
| a `covers` entry that is not two ids joined by one `/`, each matching the id pattern | `cases[<id>].covers: "<entry>" must have the form <requirement id>/<criterion id>` |
| a well-formed `covers` entry that names no declared criterion | `cases[<id>].covers: "<entry>" names no declared criterion` |
| `covers` present (even as an empty list) while the file has no `requirements` key | `cases[<id>].covers: used, but no requirements are declared` |

"Must match" applies only to an id that is a string, so a message never prints a value that matches the pattern it names. The 64-character cap applies to requirement ids only; criterion ids reach `case-status.mjs` output but never the run summary.

A `covers` entry is resolved only when `requirements` is a non-empty list, against the entries and criteria whose ids are strings; with no `requirements` key the last error replaces the per-entry check, so one mistake is reported once.

A declared criterion that no case covers is a **warning**, not an error: it is a design gap QA decides on, where a dangling reference is a mistake. One line per criterion, in declaration order, printed to stderr without changing the exit code:

```
warning: criterion <requirement id>/<criterion id> is covered by no case
```

**The requirements block** means the rows above whose error path starts with `requirements`: every row except the four `cases[<id>].covers` rows. A `covers` error never makes the block invalid; it is a mistake in a case, not in the declared requirements. `validate-cases.mjs` exports this lint as `lintRequirements(doc)`, returning `{ errors, warnings }` and folded into `validateCases` like the mutation lint. It is the one definition of a valid block: `case-status.mjs` imports `lintRequirements` rather than checking the block itself, and treats the block as malformed when any returned error starts with `requirements`.

The warning is computed only when the requirements block has no error, and only `covers` entries that resolve count toward it.

**Coverage states.** At verdict time each declared criterion gets exactly one state. Its covering cases are the cases with a `covers` entry that resolves to it; entries that resolve to nothing are ignored. A case's verdict is the one `case-status.mjs` is given for it from the run; a case with no verdict has none. The rules are evaluated in this order, and the first that holds wins:

1. `uncovered`: no case covers the criterion.
2. `failing`: any covering case has a `fail` or `flaky` verdict.
3. `proved`: some covering case has a `pass` verdict **and** QA approved that verdict (its status maps to a key in `VERDICT_APPROVED_KEYS`, the same rule as the confidence score's numerator).
4. `unproved`: everything else, including every covered criterion when no verdicts are supplied at all.

`failing` comes before `proved` so that a known failure is never hidden by another case's pass. A `blocked` verdict is not a failure: a criterion whose only covering case is blocked is `unproved`.

**What `case-status.mjs` outputs.** When the cases file declares `requirements` and the block has no lint error, the output gains a top-level `requirements` object next to `confidence`; when `requirements` is absent or malformed, the key is absent. A malformed block is never dropped silently: the output's `warnings` gains this line, printed to stderr as `warning: <text>` like the other `case-status.mjs` warnings:

```
requirements has lint errors, so requirement coverage is omitted; run validate-cases.mjs
```

`case-status.mjs --transitions` output (the status transitions and the approval ledger) never carries `requirements`, whatever the cases file declares. Every field:

| Field | Meaning |
|---|---|
| `criteria_total` | number of declared criteria; always `proved + failing + unproved + uncovered` |
| `proved`, `failing`, `unproved`, `uncovered` | number of criteria in each state |
| `by_requirement` | one entry per requirement, in declaration order |
| `by_requirement[].id` | the requirement id |
| `by_requirement[].criteria` | one entry per criterion, in declaration order |
| `by_requirement[].criteria[].id` | the criterion id |
| `by_requirement[].criteria[].state` | `uncovered`, `failing`, `proved` or `unproved` |
| `by_requirement[].criteria[].cases` | ids of the covering cases, each once, in cases-file order; `[]` when `uncovered` |

The run summary carries a reduced form, `requirement_coverage`, with the four counts, `criteria_total` and `not_proved`: the ids of every requirement with at least one criterion that is not `proved` (uncovered included), in declaration order. It never carries criterion text or requirement titles. See "What the tracker receives" in `report.schema.md`. Coverage sits beside the confidence score and changes neither the score nor readiness.

**Example: an order feature.** Other case fields are omitted.

```yaml
requirements:
  - id: ORDER-1
    title: A customer can place an order
    criteria:
      - id: AC-1
        text: Placing an order with one item shows an order number
      - id: AC-2
        text: An order with an empty cart cannot be placed
      - id: AC-3
        text: The order total equals the sum of its item prices
  - id: ORDER-2
    title: A customer can cancel an order
    criteria:
      - id: AC-1
        text: Cancelling a pending order marks it as cancelled

cases:
  - id: ORDER-PLACE-001
    covers: [ORDER-1/AC-1]
  - id: ORDER-PLACE-002
    covers: [ORDER-1/AC-2]
  - id: ORDER-PLACE-003
    covers: [ORDER-1/AC-3]
  - id: ORDER-PLACE-004
    covers: [ORDER-1/AC-1]
```

The lint passes with one warning:

```
warning: criterion ORDER-2/AC-1 is covered by no case
```

After a run where ORDER-PLACE-001 passed and QA approved it, ORDER-PLACE-002 failed, ORDER-PLACE-003 passed but is still awaiting review, and ORDER-PLACE-004 was blocked, `case-status.mjs` outputs:

```json
"requirements": {
  "criteria_total": 4,
  "proved": 1,
  "failing": 1,
  "unproved": 1,
  "uncovered": 1,
  "by_requirement": [
    { "id": "ORDER-1", "criteria": [
      { "id": "AC-1", "state": "proved", "cases": ["ORDER-PLACE-001", "ORDER-PLACE-004"] },
      { "id": "AC-2", "state": "failing", "cases": ["ORDER-PLACE-002"] },
      { "id": "AC-3", "state": "unproved", "cases": ["ORDER-PLACE-003"] }
    ] },
    { "id": "ORDER-2", "criteria": [
      { "id": "AC-1", "state": "uncovered", "cases": [] }
    ] }
  ]
}
```

and the run summary carries:

```json
"requirement_coverage": {
  "criteria_total": 4,
  "proved": 1,
  "failing": 1,
  "unproved": 1,
  "uncovered": 1,
  "not_proved": ["ORDER-1", "ORDER-2"]
}
```

ORDER-1/AC-1 is `proved` although ORDER-PLACE-004 was blocked, because a blocked case is not a failure and ORDER-PLACE-001 is an approved pass.

## Shared fixtures

A fixture is one entity that several cases work inside, such as a project created once and then edited by ten cases, instead of each case creating and deleting its own. A case opts in with `fixture: <name>`.

| File | Test title | Runs |
|---|---|---|
| `<spec_dir>/<feature>/FIXTURE-<name>.setup.ts` | `FIXTURE <name>` | once per run, before every case that names the fixture |
| `<spec_dir>/<feature>/FIXTURE-<name>.teardown.ts` | `FIXTURE <name> teardown` | once per run, after them; **only** when `teardown: delete` |

Both are wired as Playwright projects: the setup project is a `dependencies` entry of the project that runs the dependent cases, and the teardown project is the setup project's `teardown`. Each project needs an explicit `testMatch` (`**/*.setup.ts`, `**/*.teardown.ts`), because the default `testMatch` does not find these files, and `retries: 0`, because a setup that only works on retry has already created a first entity. Setup and teardown specs import the write-guard fixture like case specs do: they write too, and the publish gate requires their write record (report rule 2).

The setup writes the entity's identity (whatever the dependents need to find it: an id, a URL, a name) as JSON to `$QA_PILOT_FIXTURE_DIR/<name>.json`, and dependents read it from there. `/qa-pilot:run-tests` sets `QA_PILOT_FIXTURE_DIR` to `testing/<feature>/runs/<run_id>/fixtures/`, so each run has its own identities and two runs never share one. A setup or dependent that finds `QA_PILOT_FIXTURE_DIR` unset throws rather than guessing a path.

`teardown: keep` leaves the entity in place after the run, deliberately, for example so QA can inspect it. `teardown: delete` removes it; a teardown that fails is a publish **warning** naming the fixture, since an entity was left behind, not a verdict problem. A setup that does not pass leaves nothing to test inside, so every case naming that fixture must be `blocked` (Playwright skips dependents of a failed dependency, and the gate refuses a report where it did not).

## CLI

```bash
node qa-pilot/scripts/validate-cases.mjs testing/<feature>/cases.yaml --profile qa-pilot.config.yaml
```

Exit 0 → `ok: N cases` on stdout. Exit 1 → one error per line on stderr. A criterion covered by no case prints `warning: <text>` on stderr and does not change the exit code.
