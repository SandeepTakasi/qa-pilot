import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSpecs, ciVerdict } from '../ci-gate.mjs';
import { hashSpec } from '../parse-report.mjs';

const SPEC = 'test("X-A-001 does a thing", async ({ page }) => {});';
const OTHER = 'test("X-A-001 does a different thing", async ({ page }) => {});';
const reader = (files) => (p) => (Object.hasOwn(files, p) ? files[p] : null);

// --- selection ---------------------------------------------------------------

test('an approved spec that has not changed is run', () => {
  const { run, skipped } = selectSpecs(
    { 'X-A-001': hashSpec(SPEC) }, { 'X-A-001': 'e2e/a.spec.ts' }, reader({ 'e2e/a.spec.ts': SPEC }),
  );
  assert.deepEqual(run, [{ id: 'X-A-001', path: 'e2e/a.spec.ts' }]);
  assert.deepEqual(skipped, []);
});

test('a spec edited since approval is excluded, not run', () => {
  // It may well be a better spec, but nobody reviewed it. A green CI run against an
  // unreviewed spec claims a human stands behind something no human read.
  const { run, skipped } = selectSpecs(
    { 'X-A-001': hashSpec(SPEC) }, { 'X-A-001': 'e2e/a.spec.ts' }, reader({ 'e2e/a.spec.ts': OTHER }),
  );
  assert.deepEqual(run, []);
  assert.match(skipped[0].reason, /changed since QA approved it/);
});

test('a spec approved but missing from the repo is reported, never silently dropped', () => {
  const { run, skipped } = selectSpecs(
    { 'X-A-001': hashSpec(SPEC) }, { 'X-A-001': 'e2e/a.spec.ts' }, reader({}),
  );
  assert.deepEqual(run, []);
  assert.match(skipped[0].reason, /missing from the repo/);
});

test('an approved case with no spec path is skipped with a reason', () => {
  const { skipped } = selectSpecs({ 'X-A-001': 'abc' }, {}, reader({}));
  assert.match(skipped[0].reason, /nothing to run/);
});

test('only approved cases run, whatever else is in the specs map', () => {
  // The specs map lists what exists; the ledger says what QA accepted. The ledger decides.
  const { run } = selectSpecs(
    { 'X-A-001': hashSpec(SPEC) },
    { 'X-A-001': 'e2e/a.spec.ts', 'X-A-002': 'e2e/b.spec.ts' },
    reader({ 'e2e/a.spec.ts': SPEC, 'e2e/b.spec.ts': SPEC }),
  );
  assert.deepEqual(run.map((r) => r.id), ['X-A-001']);
});

// --- verdict -----------------------------------------------------------------

const report = (over = {}) => ({
  env_name: 'qa', commit_sha: 'abc', sha_mismatch: false,
  cases: [{ id: 'X-A-001', verdict: 'pass' }],
  summary: { pass: 1, fail: 0, flaky: 0, blocked: 0 },
  ...over,
});

test('an all-pass run is green', () => {
  const v = ciVerdict(report());
  assert.equal(v.ok, true);
});

test('a failing approved case fails the build and names the error', () => {
  const v = ciVerdict(report({
    cases: [{ id: 'X-A-001', verdict: 'fail', failure_summary: 'Error: expect(locator).toBeVisible() failed' }],
    summary: { pass: 0, fail: 1, flaky: 0, blocked: 0 },
  }));
  assert.equal(v.ok, false);
  assert.equal(v.regression, true);
  assert.match(v.reason, /toBeVisible/);
});

test('a flaky case fails the build too', () => {
  // Pass-on-retry is never a pass anywhere else here. Letting CI be the one place it goes
  // green would make CI where people look for a friendlier answer.
  const v = ciVerdict(report({
    cases: [{ id: 'X-A-001', verdict: 'flaky', failure_summary: 'Error: timeout' }],
    summary: { pass: 0, fail: 0, flaky: 1, blocked: 0 },
  }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /never a pass/);
});

test('a broken environment is not reported as a regression', () => {
  // Waking someone at 3am for "the feature broke" when the QA box is down burns the
  // credibility the whole signal depends on.
  const cases = Array.from({ length: 10 }, (_, i) => ({ id: `X-A-00${i}`, verdict: i < 2 ? 'blocked' : 'pass' }));
  const v = ciVerdict(report({ cases, summary: { pass: 8, fail: 0, flaky: 0, blocked: 2 } }));
  assert.equal(v.ok, false);
  assert.equal(v.environment_failed, true);
  assert.equal(v.regression, undefined);
  assert.match(v.reason, /environment failed, not the feature/);
});

test('one blocked case in a large run is not an environment failure', () => {
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: `X-A-0${i}`, verdict: i < 1 ? 'blocked' : 'pass' }));
  assert.equal(ciVerdict(report({ cases, summary: { pass: 19, fail: 0, flaky: 0, blocked: 1 } })).ok, true);
});

test('a mid-run deploy is an environment failure, not a regression', () => {
  const v = ciVerdict(report({ sha_mismatch: true, sha_before: 'aaa', sha_after: 'bbb' }));
  assert.equal(v.environment_failed, true);
  assert.match(v.reason, /aaa -> bbb/);
});

test('a run with no cases is never green', () => {
  // Zero tests passing is not the suite passing.
  const v = ciVerdict(report({ cases: [], summary: { pass: 0, fail: 0, flaky: 0, blocked: 0 } }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /nothing was proved/);
});
