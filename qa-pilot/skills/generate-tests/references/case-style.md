# Case composition rules

## The ID grammar

`<FEATURE>-<SUBFEATURE>-<NNN>`, e.g. `AUTH-LOGIN-003`, `CHECKOUT-QTY-011`.

Feature and subfeature are uppercase, alphanumeric, stable. The number is zero-padded to three digits and **never reused**: a deleted case's number retires with it, so an ID in an old task or run report always means the same thing.

## Priorities

| | Meaning | Consequence |
|---|---|---|
| **P0** | The feature is broken without it. Core path, security, data integrity. | Any P0 that is not an approved pass makes the feature display "Not Ready" regardless of score. QA watches 100% of P0 evidence. |
| **P1** | Important, but the feature is usable if it regresses. | QA samples >=30% of P1 passes. |
| **P2** | Polish, rare paths, cosmetic states. | Approved in bulk at matrix level; QA samples >=10%. |

Be honest about P0: everything P0 makes the readiness gate meaningless, nothing P0 makes it toothless.

## The scenario mix

Every feature declares all five slots. Each is covered by at least one case or marked `n_a` with a reason a reviewer would accept (one that names why, not merely asserts it).

| Slot | What it is | Typical miss |
|---|---|---|
| **happy** | The intended path, end to end. | Testing only this. |
| **negative** | The user does something wrong, or the operation legitimately fails. | Asserting the error appears but not that the success state is *absent*. |
| **boundary** | Limits: zero, one, maximum, one past maximum, empty, longest allowed. | Testing the middle of the range. |
| **permission** | A different role, tenant or ownership relationship. | Assuming your own role is the only one. Needs a role account. |
| **data-validation** | Field-level rules: format, required, length, type. | Marking `n_a` when the form has free-text input. |

## Writing an expected outcome

An expected outcome is a **claim about observable state** that a Playwright assertion can check: what a person would see, precisely enough that two developers would write the same assertion.

| Rejected | Why | Write instead |
|---|---|---|
| "Order is placed successfully" | Names no observable thing. | "The order confirmation panel shows an order number." |
| "Page looks correct" | Nothing to assert. | "The heading reads 'Order complete' and the cart badge shows 0." |
| "The POST /orders call returns 201" | Invisible on engine-dispatched hosts; the wait no-ops and the test passes regardless. | "The order row appears at the top of the order history table." |
| "Error is shown" | Which error, where? | "An alert with text 'Your cart is empty' is visible." |
| "The button works" | An action, not an outcome. | "After clicking, the button shows a spinner and becomes disabled." |

**Assert absence too.** A negative case that only checks the error can pass while the action *also* went through. Pair "the error is visible" with "the confirmation panel is not rendered".

## Steps

Steps are what the executor does, in order, in the UI, at the level of user intent: "Set the quantity field to 11", not "click the input, select all, type 11". The spec converter fills in the mechanics; over-specified steps age badly and constrain selector strategy.

Preconditions carry state the steps assume: who is signed in, what data exists, which role. Several developers share one deployed environment, so cases must not assume they are alone in it.

## Cases that write

Decide `mutation.policy` from what the cases do, not where they will run (policies and fixtures: see the cases schema).

| The cases | Policy | Then |
|---|---|---|
| only read, list, open or filter | `read-only` | no step may save, delete, submit or upload |
| create and change their own entities | `scoped-write` with a `prefix` | every step naming a new entity starts the name with the prefix: "Create a project named `QA_TEST_<run>-alpha`" |
| touch shared data on purpose | `unrestricted` | never runnable on production |

When many cases work inside one entity, declare it once under `fixtures` and keep preconditions honest: "Inside the shared project fixture", not a restatement of how it was made.

## Linking cases to acceptance criteria

Declare stated acceptance criteria once under `requirements`; each case names what it tests with `covers` (id and quoting rules: see the cases schema).

```yaml
requirements:
  - id: ORDER-1
    title: A customer can place an order
    criteria:
      - id: AC-1
        text: Placing an order with one item shows an order number
      - id: AC-2
        text: An order with an empty cart cannot be placed
cases:
  - id: ORDER-PLACE-001
    covers: [ORDER-1/AC-1]
```

- **One claim per entry**: a requirement id, a slash, a criterion id.
- List only what the case's outcomes would actually catch: a criterion marked covered by a case that does not assert it is a false green.
- An uncovered criterion is a warning; QA decides whether to add the case or accept the gap.
- No stated criteria, no keys.

## What not to generate

- **Volume.** Twenty shallow cases are worse than eight sharp ones: they cost QA review time and dilute the confidence score.
- **Cases that restate the same assertion with different inputs**, unless the inputs are boundaries.
- **Cases for behavior the code does not have.** If the task describes something the code does not do yet, that is a question for the user, not a test that fails forever.
- **Anything you could not explain to QA in one sentence.** If it needs a paragraph, it is probably two cases or none.
