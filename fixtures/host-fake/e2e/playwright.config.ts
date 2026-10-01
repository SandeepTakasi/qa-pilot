// The write guard's real-browser proof. Runs only guard.spec.ts, against pages the specs
// serve themselves through page.route, so nothing reaches a real site.
//
//   QA_PILOT_MUTATION='{"policy":"read-only"}' npx playwright test -c e2e/playwright.config.ts --grep @read-only
//   QA_PILOT_MUTATION='{"policy":"scoped-write","prefix":"QA_TEST_"}' npx playwright test -c e2e/playwright.config.ts --grep @scoped-write
//
// Each policy gets its own run directory under e2e/.out/, laid out as /qa-pilot:run-tests lays
// one out, so refuse-check.mjs can hand it to the real parse-report and publish gate.
import { defineConfig } from '@playwright/test';

let policy = 'read-only';
try { policy = JSON.parse(process.env.QA_PILOT_MUTATION ?? '{}').policy ?? policy; } catch { /* the guard itself refuses bad JSON */ }
const runDir = `./.out/${policy}`;

// The host's view of a write, as a profile's mutation block would give it.
process.env.QA_PILOT_MUTATION_CONFIG ??= JSON.stringify({
  write_signatures: [{ method: 'POST', url: '^https://app\\.test/api/', note: 'every API POST writes on this fake host' }],
});

export default defineConfig({
  testDir: '.',
  testMatch: 'guard.spec.ts',
  outputDir: `${runDir}/test-results`,
  reporter: [['json', { outputFile: `${runDir}/results.json` }], ['list']],
  retries: 0,
  workers: 1,
  use: { trace: 'on', video: 'off', headless: true },
});
