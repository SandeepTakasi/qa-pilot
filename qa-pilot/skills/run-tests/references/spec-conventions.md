# Spec conventions

Committed specs are the durable asset. Write them so someone else can fix them in six months.

## File layout and naming

```
<spec_dir>/<feature>/<CASE-ID>.spec.ts
```

The test title **must** begin with the case ID. `parse-report.mjs` maps Playwright results back to cases by that prefix; without it a result cannot be published.

```ts
test('CHECKOUT-ORDER-001 places an order with a single in-stock item', async ({ page }) => { … });
```

Shared fixture specs are the one exception, and their titles are exact: `FIXTURE <name>` for the setup and `FIXTURE <name> teardown` for the teardown. Any other title starting with `FIXTURE` is dropped as unmapped. See "Shared fixtures" below.

## The write guard

When a feature's `mutation.policy` is anything but `unrestricted`, or the run targets production, specs import `test` and `expect` from the write guard rather than from `@playwright/test`. `/qa-pilot:run-tests` copies `write-guard.mjs` and `write-guard.fixture.ts` into the spec directory.

```ts
import { test, expect } from '../write-guard.fixture';
```

Nothing else changes in the spec: ordinary `locator.click()` calls are judged in the page before the app sees them, and every request is judged at the network layer. A blocked click does nothing, a blocked request is aborted, and each one is recorded in the attempt's `writes.json`, which the publish gate re-reads. Under `read-only` any recorded write refuses the run; under `scoped-write` a blocked one does.

Rules the guard imposes on specs:

- **Drive the app through the page.** The `request` fixture, `page.request`, `context.request`, `browser.newContext()` and `browser.newPage()` throw under any policy but `unrestricted`, because their requests would bypass the guard. A cross-app spec that needs a second context calls `newGuardedContext(options)` from the fixture instead.
- **Under `scoped-write`, name what you create with the prefix.** A write control is allowed only in a row or dialog that shows `mutation.prefix`, or on a page inside a scope the spec declared with `writeGuard.setScope({ url: '<regex>' })`. An entity named without the prefix cannot be edited or deleted by its own spec.
- **Your own route handlers still work.** The guard decides first and then hands the request to them, so `route.fulfill()` for a stub, `route.fallback()` and `route.continue()` all behave as usual. `unroute(url, handler)` with the original handler does not remove a wrapped one; use `unroute(url)`.
- **Native dialogs are declined under `read-only`**, since a `confirm()` before a delete is a write path too.

## Shared fixtures

A fixture is one entity several cases work inside, declared in `cases.yaml` under `fixtures` and named by each case's `fixture:` key.

```
<spec_dir>/<feature>/FIXTURE-<name>.setup.ts      title: FIXTURE <name>
<spec_dir>/<feature>/FIXTURE-<name>.teardown.ts   title: FIXTURE <name> teardown   (teardown: delete only)
```

```ts
// FIXTURE-shared-project.setup.ts
import { test, expect, saveFixture } from '../write-guard.fixture';

test('FIXTURE shared-project', async ({ page }) => {
  await page.goto('/projects/new');
  await page.getByTestId('project-name').fill(`QA_TEST_${Date.now()}`);   // the scoped-write prefix
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
  saveFixture('shared-project', { url: page.url() });
});

// CHECKOUT-ORDER-003.spec.ts, a case with `fixture: shared-project`
import { test, expect, loadFixture } from '../write-guard.fixture';

test('CHECKOUT-ORDER-003 renames a line item inside the shared project', async ({ page }) => {
  const { url } = loadFixture<{ url: string }>('shared-project');
  await page.goto(url);
  …
});
```

`saveFixture` and `loadFixture` read and write `$QA_PILOT_FIXTURE_DIR/<name>.json`, which `/qa-pilot:run-tests` points at the run's own `fixtures/` directory, so two runs never share an identity. Both throw when the variable is unset.

The setup and teardown run as Playwright projects with an explicit `testMatch` and `retries: 0` (see `/qa-pilot:run-tests` step 5). If the setup fails, Playwright skips its dependents, which is what makes them `blocked`, and the publish gate refuses a report where a dependent of a failed setup still carries a verdict. A teardown that fails is a publish warning naming the entity left behind.

Fixtures are not allowed under `read-only`: they create something.

## Authentication

Specs consume saved profiles, never login flows:

```ts
test.use({ storageState: '.playwright/profiles/storefront-member.json' });
```

Never script a login inside a feature spec. Logins are slow, they are the most brittle thing in any suite, and re-testing them in every spec means one auth change breaks everything at once. `/qa-pilot:setup-profiles` owns that.

Permission cases point at their role's profile. That is the whole reason role accounts exist.

## Selectors

Use the profile's `selectors.testid_attribute`:

```ts
page.getByTestId('checkout-submit')
```

Order of preference when no test ID exists yet:

1. **Add the test ID to the app source.** This is the correct fix, and doing it as features enter the pipeline is how a codebase with zero test IDs gets covered incrementally.
2. Role + accessible name, as in `page.getByRole('button', { name: 'Place order' })`. Durable and it doubles as an accessibility check.
3. Label or associated text for form fields.

Never bind to CSS class names, DOM position (`div > div:nth-child(3)`), or generated IDs. Component libraries regenerate all three.

**Component-library overlays.** Vuetify and MUI teleport menus, dialogs, and select dropdowns to the end of `<body>`, outside the component that opened them. Scope those queries to the overlay root rather than to the trigger's ancestor, and wait for the overlay to be visible before interacting, because the trigger's click resolves before the menu is mounted.

## Assertions

**Read the profile before writing a single assertion.**

When `assertions.network_events: forbidden`:

```ts
// WRONG on an engine-dispatched host: this never fires and never fails.
await page.waitForResponse(r => r.url().includes('/orders'));

// RIGHT: assert what the user can see.
await expect(page.getByTestId('order-confirmation')).toBeVisible();
await expect(page.getByTestId('order-number')).toHaveText(/\d{4,}/);
```

Operations dispatched through an engine, a worker, or a multiplexed socket never appear as network events. `waitForResponse` on such a host resolves never, or, worse, the surrounding code proceeds and the test passes without having checked anything.

**Assert absence as well as presence.** A negative case that only checks the error appeared can pass while the action *also* succeeded:

```ts
await expect(page.getByTestId('checkout-error')).toHaveText('Your cart is empty');
await expect(page.getByTestId('order-confirmation')).toBeHidden();
```

**Web-first assertions only.** `expect(locator).toBeVisible()` retries; `expect(await locator.isVisible()).toBe(true)` does not, and turns every timing difference into flake. Never use `page.waitForTimeout` as a synchronization tool.

## Console evidence

When the profile's `evidence.extra` includes `console_log`, attach console output to every test. On hosts where operations bypass the network, this is the only machine-readable record of what the application actually did. The publish gate does not require the attachment, because the trace already carries the console output and the trace is required; the separate log is there so a failure can be read without opening the trace.

Put it in a fixture so every spec gets it without repeating the wiring. Build it on the write guard's `test` when the feature is guarded, so specs keep a single import. `<spec_dir>/fixtures.ts`:

```ts
import { test as base } from './write-guard.fixture';   // or '@playwright/test' when unguarded

export const test = base.extend<{ consoleLog: void }>({
  consoleLog: [async ({ page }, use, testInfo) => {
    const lines: string[] = [];
    page.on('console', m => lines.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => lines.push(`[pageerror] ${e.message}`));
    await use();
    await testInfo.attach('console.log', {
      body: lines.join('\n'),
      contentType: 'text/plain',
    });
  }, { auto: true }],
});

export { expect, saveFixture, loadFixture, newGuardedContext } from './write-guard.fixture';
```

Specs then import `test` from `./fixtures` instead of `@playwright/test`, and the attachment appears in the JSON report where `parse-report.mjs` picks it up.

Attach the full log, not a filtered one. Filtering to the markers you expect hides the line that explains an unexpected failure.

## Cross-app and eventual consistency

When a change in one app becomes visible in another only after a propagation delay, poll to the profile's declared ceiling:

```ts
await expect.poll(
  async () => reader.getByTestId('published-item').count(),
  { timeout: profile.cross_app.propagation_window_s * 1000, intervals: [1000, 2000, 5000] }
).toBeGreaterThan(0);
```

Use two browser contexts, one per app and each with its own storageState, rather than two tests that assume ordering. These specs live in `cross_app.spec_home`'s spec dir and run on a schedule, not per deploy.

## Test data on a shared environment

Five developers run against one deployment. Data collisions read as flakiness and get misattributed to the tests.

- Prefix every entity a spec creates with the run ID: `qa-${runId}-project-1`. Under `scoped-write` the name must also carry the feature's `mutation.prefix`, which comes first: `QA_TEST_${runId}-project-1`.
- Create data under the executor's own account wherever the tenancy model allows.
- Clean up what you create in `afterEach`, and write cleanup so it succeeds even when the test failed halfway. A read-only feature creates nothing, so it has nothing to clean up.
- When several cases need the same built-up entity, use a shared fixture rather than each case building and deleting its own.
- Never assert on a global count ("there are 3 projects"), because someone else's run will break it. Assert on the entity you created.

## What makes a spec durable

The suite-durability metric is "still passing in CI two weeks later". Specs fail that bar for predictable reasons: they bound to markup instead of test IDs, they raced instead of waiting on a web-first assertion, they assumed they were alone in the environment, or they asserted on something the feature never actually guaranteed. All four are avoidable at authoring time and expensive to fix later.
