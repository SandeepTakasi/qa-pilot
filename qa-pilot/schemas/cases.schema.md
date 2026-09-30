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

cases:                    # required, 1..25 entries, unique ids
  - id: AUTH-LOGIN-001    # required, /^[A-Z0-9]+-[A-Z0-9]+-\d{3}$/
    title: string         # required
    priority: P0 | P1 | P2                                    # required
    type: happy | negative | edge | permission | data-validation   # required
    preconditions: [string]   # optional list
    steps: [string]           # required, >= 1
    expected: [string]        # required, >= 1; see lint rules
    fixture: string           # optional; must name an entry in fixtures[]
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

## Shared fixtures

A fixture is one entity that several cases work inside, such as a project created once and then edited by ten cases, instead of each case creating and deleting its own. A case opts in with `fixture: <name>`.

| File | Test title | Runs |
|---|---|---|
| `<spec_dir>/<feature>/FIXTURE-<name>.setup.ts` | `FIXTURE <name>` | once per run, before every case that names the fixture |
| `<spec_dir>/<feature>/FIXTURE-<name>.teardown.ts` | `FIXTURE <name> teardown` | once per run, after them; **only** when `teardown: delete` |

Both are wired as Playwright projects: the setup project is a `dependencies` entry of the project that runs the dependent cases, and the teardown project is the setup project's `teardown`. Each project needs an explicit `testMatch` (`**/*.setup.ts`, `**/*.teardown.ts`), because the default `testMatch` does not find these files, and `retries: 0`, because a setup that only works on retry has already created a first entity.

The setup writes the entity's identity (whatever the dependents need to find it: an id, a URL, a name) as JSON to `$QA_PILOT_FIXTURE_DIR/<name>.json`, and dependents read it from there. `/qa-pilot:run-tests` sets `QA_PILOT_FIXTURE_DIR` to `testing/<feature>/runs/<run_id>/fixtures/`, so each run has its own identities and two runs never share one. A setup or dependent that finds `QA_PILOT_FIXTURE_DIR` unset throws rather than guessing a path.

`teardown: keep` leaves the entity in place after the run, deliberately, for example so QA can inspect it. `teardown: delete` removes it; a teardown that fails is a publish **warning** naming the fixture, since an entity was left behind, not a verdict problem. A setup that does not pass leaves nothing to test inside, so every case naming that fixture must be `blocked` (Playwright skips dependents of a failed dependency, and the gate refuses a report where it did not).

## CLI

```bash
node qa-pilot/scripts/validate-cases.mjs testing/<feature>/cases.yaml --profile qa-pilot.config.yaml
```

Exit 0 → `ok: N cases` on stdout. Exit 1 → one error per line on stderr.
