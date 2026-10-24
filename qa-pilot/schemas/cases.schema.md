# `testing/<feature>/cases.yaml`: test case schema

Written by `/qa-pilot:generate-tests`, approved by QA in ClickUp (or in `testing/<feature>/statuses.json` under `tracker: none`), converted to Playwright specs by `/qa-pilot:run-tests`. Enforced by `scripts/validate-cases.mjs`.

```yaml
feature: string           # required, must match the containing directory name
model_version: string     # required; a model not in profile models.generation_approved draws a warning
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

**Cap**: more than 25 cases is an error; split the feature into sub-features.

**Scenario mix**: every type marked `covered` needs at least one matching case; a type with no case must be `{ n_a: reason }` with a non-empty reason. The `edge` case type satisfies the `boundary` slot.

**Assertion lint**: every case needs at least one `expected` entry that could become a Playwright assertion. Rejected:

- entries shorter than 10 characters
- vague-outcome phrasing with no observable subject: "works", "is correct", "looks right", "as expected", "successfully", "no issues", "behaves properly"
- when the profile sets `assertions.network_events: forbidden`: network phrasing such as request, response, API call, network, payload, endpoint, `status 2xx/4xx/5xx` (those assertions silently no-op on engine-dispatched hosts). Assert on rendered UI state.

**Model gate**: a `model_version` not in the profile's `models.generation_approved` is a warning, not an error; QA reviews those cases with the model in mind.

**Mutation and fixture lint**: each of these is an error.

- `mutation` present but not a mapping, `mutation.policy` missing or outside the enum, or any key under `mutation` other than `policy` and `prefix`
- `policy: scoped-write` with no `prefix`, or a `prefix` that does not match `/^[A-Za-z0-9_-]{3,}$/`
- a `prefix` under `read-only` or `unrestricted`
- `fixtures` present but not a list, an entry whose `name` is missing, duplicated or does not match `/^[a-z0-9-]+$/`, or whose `teardown` is not `keep` or `delete`
- any `fixtures` entry under `policy: read-only`: a fixture creates an entity, which a read-only feature cannot do
- a `cases[].fixture` that names no entry in `fixtures`

A declared fixture that no case names is a **warning**: its setup would run, and write, for nothing.

## May these tests write?

`mutation.policy` declares what this feature's specs may change on the environment they run against. The write guard (`templates/write-guard.fixture.ts`) enforces it in the browser and the publish gate refuses a run that broke it. What counts as a write control or request comes from the profile's `mutation` block.

| `policy` | A write control (save, delete, ...) | A request matching a write signature | Publishable when |
|---|---|---|---|
| `read-only` | blocked | aborted | the run recorded no blocked and no observed write |
| `scoped-write` | allowed only inside the scope (below), blocked elsewhere | allowed, recorded as observed | the run recorded no blocked write |
| `unrestricted` | allowed | allowed | always (never on production) |

**The scope** of a `scoped-write` feature: a write control is allowed when the page URL matches a scope URL the spec set with `setScope({ url })`, or when the control's **own** row (`tr`, `[role=row]`, `li`, `[role=listitem]`, `.v-list-item`) or its containing dialog (`[role=dialog]`) contains `prefix`, in its text or in an input inside it. An element containing more than one row or list item is never a control's own row. Entities a scoped-write feature creates must therefore carry `prefix` in their name, or their own controls are blocked. A request cannot be proved in scope, so write requests under `scoped-write` are recorded, not judged.

**The default is `unrestricted`.** It is refused on production: `/qa-pilot:run-tests` will not start a production run of an `unrestricted` feature and the publish gate refuses one that ran anyway. This lint cannot enforce that, since a cases file does not know its environment.

## Requirements and coverage

`requirements` declares what the feature must do, as requirements with acceptance criteria, independently of the cases. A case claims the criteria it tests with `covers`. Both keys are optional.

**Shape.** `requirements` is a list of `{ id, title, criteria }`; `criteria` is a list of `{ id, text }`. Every id is a string matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`; quote ids that look like numbers (`id: "1"`, `id: "1.10"`, since YAML reads `1.10` as `1.1`). A requirement id is at most 64 characters and unique in the file; a criterion id is unique within its requirement, so two requirements may each have an `AC-1`. A case's `covers` is a list of `<requirement id>/<criterion id>` references, each naming a declared criterion.

**Lint.** Each is an error printed as `<path>: <message>` (`<i>`, `<j>` are zero-based positions; `cases[<id>]` uses the case `id`, or its position when it has none), and an id gets at most one error. `validate-cases.mjs` prints the messages.

- `requirements` is present but not a non-empty list of mappings
- an entry or criterion has an unknown key (allowed: `id`, `title`, `criteria`; `id`, `text`), or is not a mapping
- an `id` is missing, null, not a string, fails the pattern, exceeds 64 characters (requirements only) or repeats
- a `title` or `text` is missing, null, not a string, or blank
- `criteria` is missing, not a list, or empty
- `covers` is present but not a list of strings (`null` included)
- a `covers` entry is not `<id>/<id>` with each part matching the pattern, or names no declared criterion
- `covers` is present (even `[]`) while the file has no `requirements` key

`null` counts as missing for `id`, `title` and `text`, and as present for `requirements` and `covers`. A `covers` entry resolves only when `requirements` is a non-empty list; in a list holding a non-string entry, the string entries are still checked and resolved.

A declared criterion that no case covers is a **warning** (a design gap QA decides on), one line per criterion in declaration order on stderr, exit code unchanged:

```
warning: criterion <requirement id>/<criterion id> is covered by no case
```

It is computed only when the requirements block has no error.

**The requirements block** is every rule above except the `covers` rules; a `covers` error never makes the block invalid. `validate-cases.mjs` exports the lint as `lintRequirements(doc)` returning `{ errors, warnings }`; `case-status.mjs` imports it and treats the block as malformed when any error path starts with `requirements`.

**Coverage states.** At verdict time each declared criterion gets one state. Its covering cases are those whose `covers` resolves to it; a malformed `covers`, an unresolved entry, or a case with no string `id` covers nothing, so coverage never fails (the lint reports it). A case's verdict is the one `case-status.mjs` is given; none if absent. First match wins:

1. `uncovered`: no case covers the criterion.
2. `failing`: any covering case has a `fail` or `flaky` verdict.
3. `proved`: some covering case has a `pass` verdict **and** QA approved it (status maps to a key in `VERDICT_APPROVED_KEYS`, as in the confidence score).
4. `unproved`: everything else, including every covered criterion when no verdicts are supplied. A `blocked` verdict is not a failure.

**`case-status.mjs` output.** When the cases file declares `requirements` and the block has no lint error, the output gains a top-level `requirements` object next to `confidence`; otherwise the key is absent, and a malformed block adds this warning (stderr as `warning: <text>`): `requirements has lint errors, so requirement coverage is omitted; run validate-cases.mjs`. `--transitions` output never carries `requirements`.

| Field | Meaning |
|---|---|
| `criteria_total` | declared criteria; always `proved + failing + unproved + uncovered` |
| `proved`, `failing`, `unproved`, `uncovered` | criteria in each state |
| `by_requirement[]` | one per requirement, in declaration order: `id`, and `criteria[]` of `{ id, state, cases }` |
| `by_requirement[].criteria[].state` | `uncovered`, `failing`, `proved` or `unproved` |
| `by_requirement[].criteria[].cases` | ids of the covering cases, each once, in cases-file order; `[]` when `uncovered` |

The run summary carries a reduced form, `requirement_coverage` (the four counts, `criteria_total`, and `not_proved`, the ids of requirements with any criterion not `proved`); see "What the tracker receives" in `report.schema.md`. Coverage sits beside the confidence score and changes neither it nor readiness.

**Example.** Other case fields are omitted.

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

The lint passes with one warning (`ORDER-2/AC-1` is covered by no case). After a run where ORDER-PLACE-001 passed and QA approved it, ORDER-PLACE-002 failed, ORDER-PLACE-003 passed but is awaiting review, and ORDER-PLACE-004 was blocked, `case-status.mjs` outputs:

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

ORDER-1/AC-1 is `proved` although ORDER-PLACE-004 was blocked: a blocked case is not a failure and ORDER-PLACE-001 is an approved pass. The run summary's `requirement_coverage` has the same counts plus `"not_proved": ["ORDER-1", "ORDER-2"]`.

## Shared fixtures

A fixture is one entity that several cases work inside, created once instead of per case. A case opts in with `fixture: <name>`.

| File | Test title | Runs |
|---|---|---|
| `<spec_dir>/<feature>/FIXTURE-<name>.setup.ts` | `FIXTURE <name>` | once per run, before the feature's cases; every declared fixture runs, whichever cases are selected |
| `<spec_dir>/<feature>/FIXTURE-<name>.teardown.ts` | `FIXTURE <name> teardown` | once per run, after them; **only** when `teardown: delete` |

Both are Playwright projects: the setup project is a `dependencies` entry of the project running the dependent cases, and the teardown project is the setup project's `teardown`. Each needs an explicit `testMatch` scoped to the feature, `**/${process.env.QA_PILOT_FEATURE}/FIXTURE-*.setup.ts` and `...teardown.ts` (the default does not find them, and an unscoped pattern runs, and writes through, every feature's fixtures), and `retries: 0`. The full project block is in `/qa-pilot:run-tests` step 5. Setup and teardown specs import the write-guard fixture like case specs: they write too, and the gate requires their write record (report rule 2).

The setup writes the entity's identity (an id, URL or name) as JSON to `$QA_PILOT_FIXTURE_DIR/<name>.json` and dependents read it there. `/qa-pilot:run-tests` sets `QA_PILOT_FIXTURE_DIR` to `testing/<feature>/runs/<run_id>/fixtures/`; a setup or dependent that finds it unset throws.

`teardown: keep` leaves the entity in place after the run (for QA to inspect). `teardown: delete` removes it; a failed teardown is a publish **warning**, not a verdict problem. In CI it fails the job as an environment failure, because data left behind changes the next run. A setup that does not pass means every case naming that fixture must be `blocked` (Playwright skips dependents; the gate refuses a report where it did not).

## CLI

```bash
node qa-pilot/scripts/validate-cases.mjs testing/<feature>/cases.yaml --profile qa-pilot.config.yaml
```

Exit 0: `ok: N cases` on stdout. Exit 1: one error per line on stderr. Warnings print as `warning: <text>` on stderr without changing the exit code.
