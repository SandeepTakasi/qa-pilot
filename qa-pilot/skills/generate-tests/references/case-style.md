# Case composition rules

## The ID grammar

`<FEATURE>-<SUBFEATURE>-<NNN>`, e.g. `AUTH-LOGIN-003`, `CHECKOUT-QTY-011`.

Feature and subfeature are uppercase, alphanumeric, stable. The number is zero-padded to three digits and **never reused**: when a case is deleted, its number retires with it, so a case ID in an old ClickUp task or run report always means the same thing.

## Priorities

| | Meaning | Consequence |
|---|---|---|
| **P0** | The feature is broken without it. Core path, security, data integrity. | Any P0 not Approved makes the whole feature display "Not Ready" regardless of score. QA watches 100% of P0 evidence. |
| **P1** | Important behavior, but the feature is still usable if it regresses. | QA samples ≥30% of P1 passes. |
| **P2** | Polish, rare paths, cosmetic states. | Approved in bulk at matrix level; QA samples ≥10%. |

Be honest about P0. Marking everything P0 makes the readiness gate meaningless; marking nothing P0 makes it toothless.

## The scenario mix

Every feature declares all five slots. Each is covered by at least one case or marked `n_a` with a reason a reviewer would accept.

| Slot | What it is | Typical miss |
|---|---|---|
| **happy** | The intended path, end to end. | Testing only this. |
| **negative** | The user does something wrong, or the operation legitimately fails. | Asserting the error appears but not that the success state is *absent*. |
| **boundary** | Limits: zero, one, maximum, one past maximum, empty, longest allowed. | Testing the middle of the range, where nothing breaks. |
| **permission** | A different role, tenant, or ownership relationship. | Assuming your own account's role is the only one. Needs a role account. |
| **data-validation** | Field-level rules: format, required, length, type. | Marking `n_a` when the form does have free-text input. |

`n_a` is legitimate, since a read-only dashboard has no data-validation surface, but the reason must name why, not merely assert it.

## Writing an expected outcome

An expected outcome is a **claim about observable state** that a Playwright assertion can check. Write what a person would see, precisely enough that two developers would write the same assertion.

| Rejected | Why | Write instead |
|---|---|---|
| "Order is placed successfully" | Names no observable thing. | "The order confirmation panel shows an order number." |
| "Page looks correct" | Nothing to assert. | "The heading reads 'Order complete' and the cart badge shows 0." |
| "The POST /orders call returns 201" | Invisible on engine-dispatched hosts; the wait no-ops and the test passes regardless. | "The order row appears at the top of the order history table." |
| "Error is shown" | Which error, where? | "An alert with text 'Your cart is empty' is visible." |
| "The button works" | Not an outcome, an action. | "After clicking, the button shows a spinner and becomes disabled." |

**Assert absence too.** A negative case that only checks the error appeared can pass while the action *also* went through. Pair "the error is visible" with "the confirmation panel is not rendered".

## Steps

Steps are what the executor does, in order, in the UI. Keep them at the level of user intent: "Set the quantity field to 11", not "click the input, select all, type 11". The spec converter fills in mechanics; over-specified steps age badly and constrain the selector strategy.

Preconditions carry state the steps assume: who is signed in, what data exists, which role. Every precondition involving data is a hint to the executor about namespacing, because five developers share one deployed environment, so cases must not assume they are alone in it.

## Cases that write

Decide the feature's `mutation.policy` from what its cases do, not from where it will run:

| The cases | Policy | Then |
|---|---|---|
| only read, list, open or filter | `read-only` | no step may save, delete, submit or upload; a case that needs to is a different feature, or this one is not read-only |
| create and change their own entities | `scoped-write` with a `prefix` | every step that names a new entity starts the name with the prefix: "Create a project named `QA_TEST_<run>-alpha`" |
| touch shared data on purpose | `unrestricted` | never runnable on production |

**Shared fixtures** replace "each case creates and deletes its own project" when ten cases all work inside one. Declare the entity once under `fixtures`, name it from the cases that use it (`fixture: shared-project`), and keep the cases' preconditions honest: "Inside the shared project fixture" rather than restating how it was made. Choose `teardown: delete` unless QA needs to inspect the entity afterwards.

## Linking cases to acceptance criteria

When the feature states acceptance criteria, declare them once under `requirements` and let each case name what it tests with `covers`. The criteria are copied from the task or the documentation, so coverage is measured against what was asked for, not against what the cases happen to test.

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

- **One claim per entry.** `ORDER-1/AC-2` is a requirement id, a slash, a criterion id. Ids use letters, digits, `.`, `_` and `-`, and quote one that looks like a number (`"1"`, `"1.10"`), since YAML would read it as a number. A requirement id is at most 64 characters.
- **A case may cover several criteria, and a criterion several cases.** List only what the case's expected outcomes would actually catch: `covers` is a claim, and a criterion marked covered by a case that does not assert it is a false green in the coverage report.
- **An uncovered criterion is a warning, not an error.** It is a gap QA decides on: add the case, or leave it and say so.
- **No stated criteria, no keys.** Do not write requirements to have something to link; a feature with neither `requirements` nor `covers` validates and reports as before.

## What not to generate

- **Volume.** Twenty shallow cases are worse than eight sharp ones: they consume QA review time and dilute the confidence score with cases nobody trusts.
- **Cases that restate the same assertion with different inputs**, unless the inputs are boundaries. Three "valid quantity" cases test one thing.
- **Cases for behavior the code does not have.** If the ClickUp task describes something the code does not do yet, that is a question for the user, not a test case that will fail forever.
- **Anything you could not explain to QA in one sentence.** If the case needs a paragraph to justify, it is probably two cases or none.
