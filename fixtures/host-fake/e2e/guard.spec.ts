// The write guard in a real browser. Every page is served by the spec's own route on
// https://app.test, so no request leaves the machine. Specs use ordinary clicks and fetches:
// the guard has to stop writes with no help from them.
import type { Page } from '@playwright/test';
import { request as apiRequest, chromium } from '@playwright/test';
import { test, expect, newGuardedContext } from './.guard/write-guard.fixture';
import type { BrowserContext } from '@playwright/test';

const ORIGIN = 'https://app.test';

/** Serve one HTML page at `path`, and answer every /api/ call with 200 "ok". */
async function serve(page: Page, path: string, body: string) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/api/')) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });
  });
  await page.goto(`${ORIGIN}${path}`);
}

const COUNTER = `<script>
  window.counts = {};
  function bump(id) { counts[id] = (counts[id] || 0) + 1; document.getElementById(id).textContent = String(counts[id]); }
</script>`;

// --- read-only ------------------------------------------------------------------------

test('GUARD-CLEAN-001 @read-only a page that is only read records no write', async ({ page }) => {
  await serve(page, '/projects', `${COUNTER}
    <ul><li>Project one <button onclick="bump('opened')">Open details</button></li></ul>
    <span id="opened">0</span>`);
  await page.getByRole('button', { name: 'Open details' }).click();
  await expect(page.locator('#opened')).toHaveText('1');
});

test('GUARD-READONLY-002 @read-only a Delete click is blocked before the app sees it', async ({ page }) => {
  await serve(page, '/projects', `${COUNTER}
    <ul><li>Project one <button onclick="bump('deleted')">Delete</button></li></ul>
    <span id="deleted">0</span>`);
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#deleted')).toHaveText('0');
});

test('GUARD-READONLY-003 @read-only a request matching a write signature is aborted', async ({ page }) => {
  await serve(page, '/projects', `
    <button id="load">Load</button><span id="state">idle</span>
    <script>
      document.getElementById('load').addEventListener('click', () => {
        fetch('${ORIGIN}/api/projects/1/archive', { method: 'POST', body: '{}' })
          .then(() => { document.getElementById('state').textContent = 'reached the server'; })
          .catch(() => { document.getElementById('state').textContent = 'request failed'; });
      });
    </script>`);
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.locator('#state')).toHaveText('request failed');
});

test('GUARD-READONLY-004 @read-only requests that bypass the page are refused', async ({ page }) => {
  await serve(page, '/projects', '<p>Projects</p>');
  await expect(page.request.get(`${ORIGIN}/api/projects`)).rejects.toThrow(/page\.request\.get\(\) is disabled under mutation policy read-only/);
  await expect(page.context().request.post(`${ORIGIN}/api/projects`)).rejects.toThrow(/context\.request\.post\(\) is disabled under mutation policy read-only/);
});

test('GUARD-READONLY-005 @read-only removing every route does not remove the guard', async ({ page, context }) => {
  await serve(page, '/projects', `
    <button id="load">Load</button><span id="state">idle</span>
    <script>
      document.getElementById('load').addEventListener('click', () => {
        fetch('${ORIGIN}/api/projects/1/archive', { method: 'POST', body: '{}' })
          .then(() => { document.getElementById('state').textContent = 'reached the server'; })
          .catch(() => { document.getElementById('state').textContent = 'request failed'; });
      });
    </script>`);
  // Every way a spec could clear routes; the guard's own catch-all must survive all of them.
  await context.unroute('**/*');
  await context.unrouteAll();
  await page.unrouteAll();
  // With no route left at all the request would still fail, on DNS; only the guard aborts it
  // as blocked by the client, so that is what is asserted.
  const failed = page.waitForEvent('requestfailed', (r) => r.url().includes('/api/'));
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.locator('#state')).toHaveText('request failed');
  expect((await failed).failure()?.errorText).toMatch(/ERR_BLOCKED_BY_CLIENT/);
});

test('GUARD-READONLY-006 @read-only request clients and browsers outside the guard are refused', async ({ page, playwright, browser }) => {
  await serve(page, '/projects', '<p>Projects</p>');
  const refused = /disabled under mutation policy read-only/;
  await expect(apiRequest.newContext()).rejects.toThrow(refused);
  await expect(playwright.request.newContext()).rejects.toThrow(refused);
  await expect(browser.newContext()).rejects.toThrow(refused);
  await expect(browser.newPage()).rejects.toThrow(refused);
  await expect(chromium.launch()).rejects.toThrow(refused);
  await expect(playwright.chromium.launchPersistentContext('')).rejects.toThrow(refused);
  await expect(playwright.chromium.connectOverCDP('http://127.0.0.1:9')).rejects.toThrow(refused);
});

test.describe('a page made in beforeAll', () => {
  // Playwright's documented way to share a page across serial tests; it must not escape the guard.
  let made: unknown;
  test.beforeAll(async ({ browser }) => {
    made = await browser.newPage().then(() => 'made an unguarded page', (e: Error) => e);
  });

  test('GUARD-READONLY-007 @read-only browser.newPage in beforeAll is refused', async ({ page }) => {
    await serve(page, '/projects', '<p>Projects</p>');
    expect(made).toBeInstanceOf(Error);
    expect((made as Error).message).toMatch(/browser\.newPage\(\) .*disabled under mutation policy read-only/);
  });
});

test('GUARD-READONLY-008 @read-only Node\'s own fetch from the spec is refused', async ({ page }) => {
  await serve(page, '/projects', '<p>Projects</p>');
  // Port 9 would refuse the connection anyway; the assertion is on the guard's message.
  await expect(fetch('http://127.0.0.1:9/api/projects/1/archive', { method: 'POST', body: '{}' }))
    .rejects.toThrow(/fetch\(\) .*disabled under mutation policy read-only/);
});

test('GUARD-READONLY-009 @read-only the page cannot hide a blocked click from the record', async ({ page, guardState }) => {
  await serve(page, '/projects', `${COUNTER}
    <ul><li>Project one <button onclick="bump('deleted')">Delete</button></li></ul>
    <span id="deleted">0</span>
    <script>window.__qaPilotReport = () => {};</script>`);
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#deleted')).toHaveText('0');
  await expect.poll(() => guardState.blocked).toBe(1);
});

test('GUARD-READONLY-010 @read-only unroute with an equal RegExp removes the spec route', async ({ page }) => {
  await serve(page, '/projects', '<p>Projects</p>');
  const stub = (route: any) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'stubbed' });
  const read = () => page.evaluate(() => fetch('/api/stub').then((r) => r.text()));
  await page.route(/\/api\/stub$/, stub);
  expect(await read()).toBe('stubbed');
  await page.unroute(/\/api\/stub$/, stub); // a new literal, equal by source and flags
  expect(await read()).toBe('ok');
});

test.describe.serial('a context kept past its test', () => {
  let kept: BrowserContext;

  test('GUARD-READONLY-011 @read-only newGuardedContext gives a second guarded context', async ({ page }) => {
    await serve(page, '/projects', '<p>Projects</p>');
    kept = await newGuardedContext();
    const other = await kept.newPage();
    await other.route(`${ORIGIN}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>Other app</p>' }));
    await other.goto(`${ORIGIN}/other`);
    await expect(other.locator('p')).toHaveText('Other app');
  });

  test('GUARD-READONLY-012 @read-only that context is closed when its test ends', async ({ page }) => {
    await serve(page, '/projects', '<p>Projects</p>');
    await expect(kept.newPage()).rejects.toThrow();
  });
});

// --- scoped-write ---------------------------------------------------------------------

test('GUARD-SCOPED-001 @scoped-write a write is allowed only in a row carrying the prefix', async ({ page }) => {
  await serve(page, '/projects', `${COUNTER}
    <ul>
      <li>QA_TEST_alpha <button onclick="bump('ours')">Delete</button></li>
      <li>Customer beta <button onclick="bump('theirs')">Delete</button></li>
    </ul>
    <span id="ours">0</span><span id="theirs">0</span>`);
  await page.getByRole('listitem').filter({ hasText: 'QA_TEST_alpha' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('listitem').filter({ hasText: 'Customer beta' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#ours')).toHaveText('1');
  await expect(page.locator('#theirs')).toHaveText('0');
});

test('GUARD-SCOPED-002 @scoped-write an observed write is fulfilled by the spec\'s own route', async ({ page }) => {
  await serve(page, '/projects/QA_TEST_alpha', `
    <button id="save">Sync</button><span id="state">idle</span>
    <script>
      document.getElementById('save').addEventListener('click', () => {
        fetch('${ORIGIN}/api/projects/QA_TEST_alpha', { method: 'POST', body: '{"name":"QA_TEST_alpha"}' })
          .then((r) => r.text()).then((t) => { document.getElementById('state').textContent = 'saved: ' + t; })
          .catch(() => { document.getElementById('state').textContent = 'request failed'; });
      });
    </script>`);
  await page.getByRole('button', { name: 'Sync' }).click();
  await expect(page.locator('#state')).toHaveText('saved: ok');
});

test('GUARD-SCOPED-004 @scoped-write the page cannot widen its own scope', async ({ page }) => {
  await serve(page, '/projects', `${COUNTER}
    <button onclick="bump('wiped')">Delete</button><span id="wiped">0</span>
    <script>
      // Everything a page could try: the old global, a guessed token, replacing the setter.
      window.__qaPilotScope = '.*';
      try { window.__qaPilotSetScope('not-the-token', '.*'); } catch (_) {}
      try { window.__qaPilotSetScope = () => {}; } catch (_) {}
    </script>`);
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#wiped')).toHaveText('0');
});

test('GUARD-SCOPED-003 @scoped-write a declared scope URL unlocks writes on that page only', async ({ page, writeGuard }) => {
  await serve(page, '/projects/p-1', `${COUNTER}<button onclick="bump('saved')">Save</button><span id="saved">0</span>`);
  await writeGuard.setScope({ url: '/projects/p-1$' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#saved')).toHaveText('1');

  // A later document outside the scope gets the guard, and the scope, from the init script.
  await page.goto(`${ORIGIN}/projects/p-2`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#saved')).toHaveText('0');
});
