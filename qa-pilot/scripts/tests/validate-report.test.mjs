import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadProfile } from '../lib/profile.mjs';
import { validateReport } from '../validate-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const readJson = (p) => JSON.parse(readFileSync(resolve(FIXTURES, p), 'utf8'));
const { profile } = loadProfile(resolve(FIXTURES, 'qa-pilot.config.yaml'));
const golden = () => readJson('testing/checkout/sample-report.json');
const map = readJson('testing/checkout/clickup-map.json');

// Artifact paths in the golden report are relative to the fixture host repo.
const errorsFor = (mutate, opts = {}) => {
  const r = golden();
  mutate(r);
  return validateReport(r, profile, { base: FIXTURES, ...opts }).errors;
};
const refuses = (mutate, pattern, opts) => {
  const errs = errorsFor(mutate, opts);
  assert.ok(errs.some((e) => pattern.test(e)), `expected a refusal matching ${pattern}\ngot: ${errs.join('\n') || '(none)'}`);
};

test('golden report passes the publish gate', () => {
  assert.deepEqual(validateReport(golden(), profile, { map, base: FIXTURES }).errors, []);
});

// --- the evidence gate: the reason a Pass cannot be claimed without proof ---

test('refuses a pass with no trace', () => {
  refuses((r) => { r.cases[0].trace = null; }, /trace: required for a pass verdict/);
});

test('refuses a fail with no trace', () => {
  refuses((r) => { r.cases[1].trace = null; }, /trace: required for a fail verdict/);
});

test('the trace alone is sufficient evidence', () => {
  // It carries the video byte-for-byte and the console output, so demanding those as
  // separate uploads would store the same bytes twice for no reviewer benefit.
  const r = golden();
  assert.ok(r.cases.every((c) => !c.video && !c.console_log), 'fixture should be trace-only');
  assert.deepEqual(validateReport(r, profile, { map, base: FIXTURES }).errors, []);
});

test('an optional video path that points nowhere is still refused', () => {
  refuses((r) => { r.cases[0].video = 'test-results/gone.webm'; }, /video: .*does not exist on disk/);
});

test('refuses when a declared evidence artifact is missing on disk', () => {
  const errs = validateReport(golden(), profile, { base: '/nonexistent-base' }).errors;
  assert.ok(errs.some((e) => /does not exist on disk/.test(e)), errs.join('\n'));
});

test('a host declaring console_log evidence is satisfied by the trace', () => {
  // Playwright records console output into the trace automatically, so requiring the
  // trace already requires the console. There is no second artifact to demand.
  assert.deepEqual(profile.evidence.extra, ['console_log'], 'fixture host declares console evidence');
  const r = golden();
  assert.ok(r.cases.every((c) => !c.console_log));
  assert.deepEqual(validateReport(r, profile, { map, base: FIXTURES }).errors, []);
});

test('blocked cases need no evidence, because they never executed', () => {
  const r = golden();
  r.cases = [{ id: 'CHECKOUT-ORDER-001', verdict: 'blocked', retries: 0, video: null, trace: null, console_log: null }];
  r.summary = { pass: 0, fail: 0, flaky: 0, blocked: 1 };
  const errs = validateReport(r, profile, { base: FIXTURES }).errors;
  assert.ok(!errs.some((e) => /video|trace|console_log/.test(e)), errs.join('\n'));
});

// --- capture modes: evidence required depends on what the host chose to keep ---

test('under on-failure a passing case needs no trace', () => {
  const r = golden();
  r.evidence_capture = 'on-failure';
  for (const c of r.cases) if (c.verdict === 'pass') c.trace = null;
  assert.deepEqual(validateReport(r, profile, { map, base: FIXTURES }).errors, []);
});

test('under on-failure a FAILING case still needs a trace', () => {
  refuses((r) => {
    r.evidence_capture = 'on-failure';
    r.cases[1].trace = null;  // the fail
  }, /trace: required for a fail verdict/);
});

test('on-failure warns that a false pass would be undetectable', () => {
  const r = golden();
  r.evidence_capture = 'on-failure';
  const { warnings } = validateReport(r, profile, { map, base: FIXTURES });
  assert.ok(warnings.some((w) => /false pass in this run is undetectable/.test(w)), warnings.join('\n'));
});

test('under always a passing case still needs a trace', () => {
  refuses((r) => { r.evidence_capture = 'always'; r.cases[0].trace = null; },
    /trace: required for a pass verdict/);
});

test('a run captured with off cannot be published at all', () => {
  refuses((r) => { r.evidence_capture = 'off'; }, /captured no evidence/);
});

test('an unknown capture mode is refused rather than assumed', () => {
  refuses((r) => { r.evidence_capture = 'maybe'; }, /is not one of always \| on-failure \| off/);
});

test('a report with no capture mode is treated as always', () => {
  refuses((r) => { delete r.evidence_capture; r.cases[0].trace = null; },
    /trace: required for a pass verdict/);
});

// --- provenance ---

test('refuses an unregistered environment', () => {
  refuses((r) => { r.env_name = 'my-laptop'; }, /not a registered environment/);
});

test('refuses an env_url that disagrees with the registry', () => {
  refuses((r) => { r.env_url = 'https://somewhere-else.example.com'; }, /does not match the registered URL/);
});

test('refuses a report with no SHA source', () => {
  refuses((r) => { r.sha_source = null; }, /sha_source: required/);
});

test('refuses a report with no commit SHA', () => {
  refuses((r) => { r.commit_sha = null; }, /commit_sha: required/);
});

test('refuses verdicts surviving a mid-run deploy', () => {
  refuses((r) => {
    r.sha_mismatch = true;
    r.sha_after = 'ffffffffffffffffffffffffffffffffffffffff';
  }, /changed mid-run.*must be blocked/s);
});

test('recomputes the SHA mismatch instead of trusting the report', () => {
  // Regression: a report claiming sha_mismatch:false while the SHAs differ used to pass.
  refuses((r) => {
    r.sha_after = 'ffffffffffffffffffffffffffffffffffffffff';
    r.sha_mismatch = false; // the lie
  }, /changed mid-run.*must be blocked/s);
});

test('refuses a report whose sha_mismatch flag disagrees with its own SHAs', () => {
  refuses((r) => { r.sha_mismatch = true; }, /report says true but sha_before\/sha_after say false/);
});

test('refuses a report with no env_url: omitting it must not skip the registry check', () => {
  refuses((r) => { delete r.env_url; }, /env_url: required/);
});

test('refuses a zero-byte trace', () => {
  // A crashed run writes an empty file; presence alone is not evidence.
  const empty = resolve(FIXTURES, 'test-results/empty-fixture.zip');
  writeFileSync(empty, '');
  try {
    refuses((r) => { r.cases[0].trace = 'test-results/empty-fixture.zip'; }, /is empty \(0 bytes\)/);
  } finally {
    rmSync(empty, { force: true });
  }
});

test('evidence is checked on disk even when no base is given', () => {
  // Regression: `if (!base) return false` silently downgraded the gate to a string check.
  const errs = validateReport(golden(), profile, {}).errors; // base omitted entirely
  assert.ok(errs.some((e) => /does not exist on disk/.test(e)),
    `omitting --base must not skip the existence check; got: ${errs.join(' | ') || '(none)'}`);
});

test('prototype keys cannot satisfy the approved-case map', () => {
  refuses((r) => { r.cases[0].id = 'constructor'; }, /not in the approved case map/, { map });
});

// --- sandbox runs are never verdict-eligible ---

test('refuses a sandbox-mode run outright', () => {
  refuses((r) => { r.api_mode = 'mocks'; }, /structurally false passes/);
});

test('refuses a report that does not say which mode it ran in', () => {
  refuses((r) => { delete r.api_mode; }, /api_mode: required/);
});

// --- case integrity ---

test('refuses a verdict outside the enum', () => {
  refuses((r) => { r.cases[0].verdict = 'passed'; }, /is not one of pass \| fail \| flaky \| blocked/);
});

test('refuses a case QA never approved', () => {
  refuses((r) => { r.cases[0].id = 'CHECKOUT-GHOST-099'; }, /not in the approved case map/, { map });
});

test('refuses a fail with no failure summary', () => {
  refuses((r) => { r.cases[1].failure_summary = null; }, /failure_summary: required/);
});

test('refuses a flaky verdict with no retries recorded', () => {
  refuses((r) => { r.cases[2].retries = 0; }, /flaky with no retries/);
});

test('refuses duplicate case ids', () => {
  refuses((r) => { r.cases[1].id = r.cases[0].id; }, /duplicate/);
});

test('refuses a summary that disagrees with the cases', () => {
  refuses((r) => { r.summary.pass = 7; }, /summary\.pass: says 7 but 2/);
});

// --- run-level halt ---

test('halts a run where more than 10% of cases are blocked', () => {
  refuses((r) => {
    r.cases[3].verdict = 'blocked';
    r.summary = { pass: 1, fail: 1, flaky: 1, blocked: 1 };
  }, /RUN HALTED/);
});

test('warns about flaky cases rather than silently accepting them', () => {
  const { warnings } = validateReport(golden(), profile, { map, base: FIXTURES });
  assert.ok(warnings.some((w) => /flaky/.test(w)), warnings.join('\n'));
});
