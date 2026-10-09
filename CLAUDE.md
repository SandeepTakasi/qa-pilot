# QA-Pilot repository

## Checks before every commit

```bash
node --test qa-pilot/scripts/tests/*.test.mjs
claude plugin validate ./qa-pilot
```

Leave the glob unquoted (see `qa-pilot/README.md`, "Development").

Scripts run on Node 20, 22 and 24 (the CI matrix), so use nothing newer than Node 20: no
`Object.groupBy`, no new `Set` methods.

After changing any document the site renders (plugin docs, schemas, skills, `site/`):

```bash
cd site && npm run build:local
```

It fails on a broken link, and on an em or en dash only in a site-authored page; check plugin docs
for dashes yourself.

`qa-pilot/templates/qa-pilot-ci.yml` has no unit tests. After changing a `run:` step, run it under
`bash -eo pipefail` (how GitHub runs it) with stub commands for each exit path, and capture a
command that may fail as `out=$(cmd) || rc=$?`, since a bare `out=$(cmd)` ends the step at once.

The write guard has a real-browser proof that the unit suite cannot give. Run it after any change
to `qa-pilot/templates/write-guard.*`:

```bash
cd fixtures/host-fake && mkdir -p e2e/.guard && cp ../../qa-pilot/templates/write-guard.mjs ../../qa-pilot/templates/write-guard.fixture.ts e2e/.guard/ && npm install --no-audit --no-fund && npx playwright install chromium && QA_PILOT_MUTATION='{"policy":"read-only"}' npx playwright test -c e2e/playwright.config.ts --grep @read-only && QA_PILOT_MUTATION='{"policy":"scoped-write","prefix":"QA_TEST_"}' npx playwright test -c e2e/playwright.config.ts --grep @scoped-write && node e2e/refuse-check.mjs
```

`e2e/.guard/` and `e2e/.out/` are gitignored. Never point a Playwright `outputDir` at
`fixtures/host-fake/test-results/`: it holds committed trace fixtures the tests read.

Commit messages: sentence-case imperative subject, an explanatory body, no tool, plugin or task
names.

## No host or personal data, ever

This repository is published. Nothing about any project that uses QA-Pilot, and nothing personal
beyond the author credit in `LICENSE` and the manifests, may appear in tracked files, examples,
fixtures, commit messages or history. Use neutral nouns (project, order, item) and example
hosts (`example.com`, `.test`).

Before every commit and every push, search the **whole history**, not just the tree:
`git log --all -p --format='%H%n%B' | grep -iE '<terms>'` must print nothing. Keep `<terms>` in
your own untracked notes: the list names the hosts it protects, so it is never committed.
Host-specific values belong in the host's own `qa-pilot.config.yaml`.
