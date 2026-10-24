# Spec conventions

Committed specs are the durable asset. Write them so someone else can fix them in six months.

## File layout and naming

```
<spec_dir>/<feature>/<CASE-ID>.spec.ts
```

The test title **must** begin with the case ID. `parse-report.mjs` maps results back to cases by that prefix; without it a result cannot be published.

Keep spec paths to letters, digits, `-`, `_`, `.` and `/`. Playwright reads a path on its command line as a pattern, so a directory such as `(shop)` or `[id]` matches nothing and the spec silently does not run; CI fails the job when that happens.

**What QA approves is the spec plus every local file it imports, and the case's steps, expected outcomes, preconditions and fixture.** Editing a shared helper sends every spec that imports it back for review, and drops them from CI until QA re-approves. Keep helpers small and stable, and put each case's assertions in its own spec.

```ts
test('CHECKOUT-ORDER-001 places an order with a single in-stock item', async ({ page }) => { … });
```

Shared fixture specs are the one exception, with exact titles: `FIXTURE <name>` for the setup and `FIXTURE <name> teardown` for the teardown. Any other title starting with `FIXTURE` is dropped as unmapped. See "Shared fixtures" below.

## The write guard

When a feature's `mutation.policy` is anything but `unrestricted`, or the run targets production, specs import `test` and `expect` from the write guard rather than `@playwright/test`. `/qa-pilot:run-tests` copies `write-guard.mjs` and `write-guard.fixture.ts` into the spec directory.

```ts
import { test, expect } from '../write-guard.fixture';
```

Nothing else changes in the spec. Blocked clicks do nothing, blocked requests are aborted, and each is recorded in the attempt's `writes.json`, which the publish gate re-reads. Under `read-only` any recorded write refuses the run; under `scoped-write` a blocked one does.

Rules the guard imposes on specs:

- **Drive the app through the page.** Under any policy but `unrestricted`, these are refused because the guard cannot see their requests: the `request` fixture; the send methods of `page.request` and `context.request`; `request.newContext()` (also `playwright.request.newContext()`); Node's global `fetch()`; `browser.newContext()` and `browser.newPage()` (in tests and in `beforeAll` / `beforeEach`); and every browser type's `launch`, `launchPersistentContext`, `launchServer`, `connect` and `connectOverCDP`. Never use `node:http`, `node:https` or `node:net` in a guarded spec: they are not refused, but a request through them is a write nobody records. A cross-app spec that needs a second context calls `newGuardedContext(options)` from the fixture. Sharing one page across serial tests from `beforeAll` is not possible; use the per-test `page`.
- **Under `scoped-write`, name what you create with the prefix.** A write control is allowed only in a row or dialog that shows `mutation.prefix`, or on a page inside a scope the spec declared with `writeGuard.setScope({ url: '<regex>' })`. Only the spec can set the scope; the page cannot widen it.
- **Your own route handlers still work.** `route.fulfill()`, `route.fallback()`, `route.continue()`, `unroute(...)` and `unrouteAll()` behave as usual; none removes the guard's own route. A `continue` or `fallback` that changes the method, URL or body is judged again first, so a handler cannot turn a read into a write.
- **The page cannot slip a write past the route.** A `keepalive` fetch loses its keepalive flag so it is routed and judged, and `SharedWorker` is refused and recorded as a blocked write.
- **Every guarded test gets a browser context**, even one that never asks for `page`.
- **Native dialogs are declined under `read-only`**, since a `confirm()` before a delete is a write path.

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

`saveFixture` and `loadFixture` use `$QA_PILOT_FIXTURE_DIR/<name>.json` (the run's own `fixtures/` directory) and throw when the variable is unset.

Setup and teardown run as Playwright projects with an explicit `testMatch` and `retries: 0` (`/qa-pilot:run-tests` step 5). If a setup fails, its dependents are skipped and become `blocked`; the publish gate refuses a report where such a dependent carries a verdict. A failed teardown is a publish warning naming the entity left behind. Fixtures are not allowed under `read-only`.

## Authentication

Specs consume saved profiles, never login flows. Never script a login inside a feature spec; `/qa-pilot:setup-profiles` owns that.

```ts
test.use({ storageState: '.playwright/profiles/storefront-member.json' });
```

Permission cases point at their role's profile.

## Selectors

Use the profile's `selectors.testid_attribute`:

```ts
page.getByTestId('checkout-submit')
```

Order of preference when no test ID exists yet:

1. **Add the test ID to the app source.**
2. Role + accessible name: `page.getByRole('button', { name: 'Place order' })`.
3. Label or associated text for form fields.

Never bind to CSS class names, DOM position (`div > div:nth-child(3)`), or generated IDs. The lint enforces this: `playwright/no-raw-locators` refuses `page.locator('<css or xpath>')`, `no-nth-methods` refuses `.first()`, `.last()` and `.nth()` (a pick by position is also how an AI "fix" loosens a check until it passes), and `prefer-native-locators` turns `locator('[data-testid=x]')` into `getByTestId('x')`.

**Component-library overlays.** Menus, dialogs and select dropdowns (Vuetify, MUI) are teleported to the end of `<body>`. Scope those queries to the overlay root, not the trigger's ancestor, and wait for the overlay to be visible before interacting. The overlay root usually needs one CSS locator; add that exact selector to `no-raw-locators`' `allowed` list in `eslint.qa-pilot.config.mjs` rather than disabling the rule.

## Assertions

**Read the profile before writing a single assertion.** When `assertions.network_events: forbidden`, operations never appear as network events, so `waitForResponse` never resolves or the test passes unchecked:

```ts
// WRONG on such a host: this never fires and never fails.
await page.waitForResponse(r => r.url().includes('/orders'));

// RIGHT: assert what the user can see.
await expect(page.getByTestId('order-confirmation')).toBeVisible();
await expect(page.getByTestId('order-number')).toHaveText(/\d{4,}/);
```

**Assert absence as well as presence.** A negative case that only checks the error appeared can pass while the action *also* succeeded:

```ts
await expect(page.getByTestId('checkout-error')).toHaveText('Your cart is empty');
await expect(page.getByTestId('order-confirmation')).toBeHidden();
```

**Web-first assertions only.** `expect(locator).toBeVisible()` retries; `expect(await locator.isVisible()).toBe(true)` does not. Never use `page.waitForTimeout` to synchronize.

**The lint enforces these rules.** `/qa-pilot:run-tests` lints every spec and fixture spec with `eslint.qa-pilot.config.mjs` before a verdict run: `playwright/expect-expect`, `no-wait-for-timeout`, `no-skipped-test` and `no-focused-test` fail a test with no assertion, a fixed sleep, `test.skip` or `test.only`, alongside the selector rules above. Keep assertions in the test body; `expect-expect` does not see through a helper.

## Test data under `scoped-write`

Created data outlives the run, and every developer's runs share the environment:

- **Name each entity uniquely per run**: the prefix, the feature and a timestamp, such as `` `QA_TEST_checkout_${Date.now()}` ``. Find it again by that full name, never by the bare prefix, which also matches every other run's leftovers.
- **Delete what the case created in its last step**, or let a `teardown: delete` fixture do it.
- **Never assert on counts or empty states** ("the list shows 3 items", "no projects yet"). Leftovers from earlier runs make them fail from the second run on. Assert on the entity this run created.

## Console evidence

When the profile's `evidence.extra` includes `console_log`, attach console output to every test. The gate does not require it (the trace carries the console), but it lets a failure be read without opening the trace.

Put it in a fixture, built on the write guard's `test` when the feature is guarded. `<spec_dir>/fixtures.ts`:

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

Specs, which sit in `<spec_dir>/<feature>/`, import `test` from `../fixtures`. Attach the full log, not a filtered one.

## Cross-app and eventual consistency

When a change in one app becomes visible in another after a delay, poll to the profile's declared ceiling:

```ts
await expect.poll(
  async () => reader.getByTestId('published-item').count(),
  { timeout: profile.cross_app.propagation_window_s * 1000, intervals: [1000, 2000, 5000] }
).toBeGreaterThan(0);
```

Use two browser contexts, one per app, each with its own storageState. These specs live in `cross_app.spec_home`'s spec dir and run on a schedule, not per deploy.

## Test data on a shared environment

Collisions between developers read as flakiness.

- Prefix every entity a spec creates with the run ID: `qa-${runId}-project-1`. Under `scoped-write` the feature's `mutation.prefix` comes first: `QA_TEST_${runId}-project-1`.
- Create data under the executor's own account wherever the tenancy model allows.
- Clean up in `afterEach`, written so it succeeds even when the test failed halfway. A read-only feature creates nothing.
- When several cases need the same built-up entity, use a shared fixture.
- Never assert on a global count ("there are 3 projects"). Assert on the entity you created.
