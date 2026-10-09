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

## Where a trace may go

`effectiveEvidenceUpload` in `qa-pilot/scripts/lib/profile.mjs` is the only place that decides,
and the loader writes its answer into the normalized profile: `local` under `tracker: none` and
on production, else the environment's explicit value, else `reference`. Four consumers must
agree with it: `publish-payload.mjs` (only `tracker` produces an `attach`), `validate-report.mjs`
rule 6 (pins `reference` and `local` traces by sha256), `bug-report.mjs` (only `tracker` attaches,
and no profile means `reference`), and the CI template, which uploads the run directory only when
GitHub confirms the repository is private. A new consumer of traces checks the same value; a new
evidence value is added to all five.

## The approval ledger has two writers

`case-status.mjs --transitions` (at publish) keeps an entry when an approved, unchanged spec passes
again and deletes every other; it never adds one. `case-status.mjs --record-approvals` (at review)
adds the hash of each pass QA approved and removes an approved failure. It requires `--approved`,
starts a new ledger only when that file is missing, and refuses a corrupt or non-object one,
because printing a partial ledger invites overwriting every earlier approval.
