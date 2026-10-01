# Architecture notes

## Write guard: Playwright behaviours it relies on

Verified on `@playwright/test` 1.62.1. Re-check each on a Playwright upgrade; every one has broken
a design once.

- **Route handlers run newest first.** A spec's own `page.route` registered after the guard's
  would see a request before the guard. The fixture wraps every handler a spec registers (context
  and page) so the guard decides first, and keeps a predicate catch-all route as a second layer.
- **Playwright builds the test's context through the public `browser.newContext`**
  (`_contextFactory`). The lock on `newContext` lets exactly one call through while the built-in
  `context` fixture is being created (`builtinWindow`), and every guarded test is forced to create
  that context so the window always closes.
- **Teardown reads `context.request`.** A throwing getter breaks Playwright's own cleanup, so
  `page.request` / `context.request` are Proxies that refuse only the send methods.
- **`testInfo.attach(name, { path })` copies the file.** The report lists the copies; the gate
  matches the originals under the run directory to them by sha256.
- **A CLI file filter does not apply to dependency or teardown projects**, and
  `PLAYWRIGHT_JSON_OUTPUT_NAME` resolves against the config's directory. Fixture projects are
  scoped by `QA_PILOT_FEATURE`; every output path passed to a run is absolute.

What the guard cannot see, by design (Node's own `node:http`, WebSocket frames, popups opened
outside the guarded context and more), is listed once, in the header of
`qa-pilot/templates/write-guard.fixture.ts`. Change it there, not here.
