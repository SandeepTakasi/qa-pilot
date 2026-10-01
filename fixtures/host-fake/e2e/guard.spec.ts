// The write guard in a real browser. Every page is served by the spec's own route on
// https://app.test, so no request leaves the machine. Specs use ordinary clicks and fetches:
// the guard has to stop writes with no help from them.
import type { Page } from '@playwright/test';
import { test, expect } from './.guard/write-guard.fixture';

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
