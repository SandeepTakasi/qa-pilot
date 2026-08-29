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
2. Role + accessible name — `page.getByRole('button', { name: 'Place order' })`. Durable and it doubles as an accessibility check.
3. Label or associated text for form fields.

Never bind to CSS class names, DOM position (`div > div:nth-child(3)`), or generated IDs. Component libraries regenerate all three.

**Component-library overlays.** Vuetify and MUI teleport menus, dialogs, and select dropdowns to the end of `<body>`, outside the component that opened them. Scope those queries to the overlay root rather than to the trigger's ancestor, and wait for the overlay to be visible before interacting — the trigger's click resolves before the menu is mounted.

## Assertions

**Read the profile before writing a single assertion.**

When `assertions.network_events: forbidden`:

```ts
// WRONG on an engine-dispatched host — this never fires and never fails.
await page.waitForResponse(r => r.url().includes('/orders'));

// RIGHT — assert what the user can see.
await expect(page.getByTestId('order-confirmation')).toBeVisible();
await expect(page.getByTestId('order-number')).toHaveText(/\d{4,}/);
```

Operations dispatched through an engine, a worker, or a multiplexed socket never appear as network events. `waitForResponse` on such a host resolves never — or, worse, the surrounding code proceeds and the test passes without having checked anything.

**Assert absence as well as presence.** A negative case that only checks the error appeared can pass while the action *also* succeeded:

```ts
await expect(page.getByTestId('checkout-error')).toHaveText('Your cart is empty');
await expect(page.getByTestId('order-confirmation')).toBeHidden();
```

**Web-first assertions only.** `expect(locator).toBeVisible()` retries; `expect(await locator.isVisible()).toBe(true)` does not, and turns every timing difference into flake. Never use `page.waitForTimeout` as a synchronization tool.

## Console evidence

When the profile's `evidence.extra` includes `console_log`, attach console output to every test. On hosts where operations bypass the network, this is the only machine-readable trace of what the application actually did — and `validate-report.mjs` refuses to publish without it.

Put it in a fixture so every spec gets it without repeating the wiring. `<spec_dir>/fixtures.ts`:

```ts
import { test as base } from '@playwright/test';

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

export { expect } from '@playwright/test';
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

Use two browser contexts — one per app, each with its own storageState — rather than two tests that assume ordering. These specs live in `cross_app.spec_home`'s spec dir and run on a schedule, not per deploy.

## Test data on a shared environment

Five developers run against one deployment. Data collisions read as flakiness and get misattributed to the tests.

- Prefix every entity a spec creates with the run ID: `qa-${runId}-project-1`.
- Create data under the executor's own account wherever the tenancy model allows.
- Clean up what you create in `afterEach`, and write cleanup so it succeeds even when the test failed halfway.
- Never assert on a global count ("there are 3 projects") — someone else's run will break it. Assert on the entity you created.

## What makes a spec durable

The suite-durability metric is "still passing in CI two weeks later". Specs fail that bar for predictable reasons: they bound to markup instead of test IDs, they raced instead of waiting on a web-first assertion, they assumed they were alone in the environment, or they asserted on something the feature never actually guaranteed. All four are avoidable at authoring time and expensive to fix later.
