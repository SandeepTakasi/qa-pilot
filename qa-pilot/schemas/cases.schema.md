# `testing/<feature>/cases.yaml`: test case schema

Written by `/qa-pilot:generate-tests`, approved by QA in ClickUp, converted to Playwright specs by `/qa-pilot:run-tests`. Enforced by `scripts/validate-cases.mjs`.

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

cases:                    # required, 1..25 entries, unique ids
  - id: AUTH-LOGIN-001    # required, /^[A-Z0-9]+-[A-Z0-9]+-\d{3}$/
    title: string         # required
    priority: P0 | P1 | P2                                    # required
    type: happy | negative | edge | permission | data-validation   # required
    preconditions: [string]   # optional list
    steps: [string]           # required, >= 1
    expected: [string]        # required, >= 1; see lint rules
```

## Validation rules

**Cap**: more than 25 cases is an error. Split the feature into sub-features instead. Volume is an anti-metric: the count of generated cases measures nothing.

**Scenario mix cross-check**: every type marked `covered` must have at least one matching case; a type with no case must be `{ n_a: reason }` with a non-empty reason. The `edge` case type satisfies the `boundary` mix slot.

**Assertion lint (the important one)**: every case needs at least one `expected` entry that could become a Playwright assertion. Rejected:

- entries shorter than 10 characters
- vague-outcome phrasing with no observable subject: "works", "is correct", "looks right", "as expected", "successfully", "no issues", "behaves properly"
- when the host profile sets `assertions.network_events: forbidden`: network-flavored phrasing such as request, response, API call, network, payload, endpoint, `status 2xx/4xx/5xx`. On engine-dispatched hosts these assertions silently no-op, producing exactly the false green this pipeline exists to prevent. Assert on rendered UI state instead.

**Model gate**: `model_version` must appear in the profile's `models.generation_approved`. A model upgrade cannot silently change case quality; QA adds the new model to the list after a calibration pass.

## CLI

```bash
node qa-pilot/scripts/validate-cases.mjs testing/<feature>/cases.yaml --profile qa-pilot.config.yaml
```

Exit 0 → `ok: N cases` on stdout. Exit 1 → one error per line on stderr.
