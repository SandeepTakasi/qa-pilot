import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSpecs, ciVerdict } from '../ci-gate.mjs';
import { specHash } from '../lib/spec-hash.mjs';

const SPEC = 'test("X-A-001 does a thing", async ({ page }) => {});';
const OTHER = 'test("X-A-001 does a different thing", async ({ page }) => {});';
const reader = (files) => (p) => (Object.hasOwn(files, p) ? files[p] : null);
const CASE = { id: 'X-A-001', priority: 'P0', steps: ['open the page'], expected: ['the heading reads Orders'] };
const CASES = [CASE, { ...CASE, id: 'X-A-002' }];
// The hash QA approved: this spec source at e2e/a.spec.ts, for CASE.
const H = (src, files = {}, entry = CASE) => specHash('e2e/a.spec.ts', entry, { read: reader({ 'e2e/a.spec.ts': src, ...files }) });
const select = (approved, specs, files, opts = {}) => selectSpecs(approved, specs, opts.cases ?? CASES, { read: reader(files), ...opts });

// --- selection ---------------------------------------------------------------

test('an approved spec that has not changed is run', () => {
  const { run, skipped } = select(
    { 'X-A-001': H(SPEC) }, { 'X-A-001': 'e2e/a.spec.ts' }, { 'e2e/a.spec.ts': SPEC },
  );
  assert.deepEqual(run, [{ id: 'X-A-001', path: 'e2e/a.spec.ts' }]);
  assert.deepEqual(skipped, []);
});

test('a spec edited since approval is excluded, not run', () => {
  // It may well be a better spec, but nobody reviewed it. A green CI run against an
  // unreviewed spec claims a human stands behind something no human read.
  const { run, skipped } = select(
    { 'X-A-001': H(SPEC) }, { 'X-A-001': 'e2e/a.spec.ts' }, { 'e2e/a.spec.ts': OTHER },
  );
  assert.deepEqual(run, []);
  assert.match(skipped[0].reason, /changed since QA approved it/);
});

test('a spec approved but missing from the repo is reported, never silently dropped', () => {
  const { run, skipped } = select(
    { 'X-A-001': H(SPEC) }, { 'X-A-001': 'e2e/a.spec.ts' }, {},
  );
  assert.deepEqual(run, []);
  assert.match(skipped[0].reason, /missing from the repo/);
});

test('an approved case with no spec path is skipped with a reason', () => {
  const { skipped } = select({ 'X-A-001': 'abc' }, {}, {});
  assert.match(skipped[0].reason, /nothing to run/);
});

test('only approved cases run, whatever else is in the specs map', () => {
  // The specs map lists what exists; the ledger says what QA accepted. The ledger decides.
  const { run } = select(
    { 'X-A-001': H(SPEC) },
    { 'X-A-001': 'e2e/a.spec.ts', 'X-A-002': 'e2e/b.spec.ts' }, { 'e2e/a.spec.ts': SPEC, 'e2e/b.spec.ts': SPEC },
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

test('one blocked case in a large run still fails the build', () => {
  // It proved nothing. Green has to mean every selected approved case ran and passed; the
  // 10% rule decides only whether a publish halts.
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: `X-A-0${i}`, verdict: i < 1 ? 'blocked' : 'pass' }));
  const v = ciVerdict(report({ cases, summary: { pass: 19, fail: 0, flaky: 0, blocked: 1 } }));
  assert.equal(v.ok, false);
  assert.equal(v.environment_failed, true);
  assert.match(v.reason, /1 approved case\(s\) were blocked/);
});

test('ten passes and one blocked case behind a failed setup project is red, not green', () => {
  // The review's proved case: Playwright skips a dependent of a failed setup project.
  const cases = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `CHK-UI-0${10 + i}`, verdict: 'pass' })),
    { id: 'CHK-UI-011', verdict: 'blocked' },
  ];
  const v = ciVerdict(report({ cases, fixtures: [{ name: 'x', phase: 'setup', verdict: 'fail' }] }));
  assert.equal(v.ok, false);
  assert.equal(v.environment_failed, true);
});

test('a failed fixture spec fails the build even when every case passed', () => {
  const v = ciVerdict(report({ fixtures: [{ name: 'seed', phase: 'teardown', verdict: 'fail' }] }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /seed teardown \(fail\)/);
});

test('a Playwright error outside any test is an environment failure, even with no cases', () => {
  const v = ciVerdict(report({ cases: [], errors: ['Timed out waiting 3s for the test suite to run'] }));
  assert.equal(v.ok, false);
  assert.equal(v.environment_failed, true);
  assert.match(v.reason, /Timed out waiting/);
});

test('a selected case missing from the report fails the build', () => {
  // A path such as tests/(shop)/b.spec.ts is a pattern to Playwright and matches nothing.
  const v = ciVerdict(report(), { expected: ['X-A-001', 'X-A-002', 'X-A-003'] });
  assert.equal(v.ok, false);
  assert.equal(v.incomplete, true);
  assert.match(v.reason, /2 selected approved case\(s\) never ran: X-A-002, X-A-003/);
});

test('a test without a case-ID title fails the build', () => {
  const v = ciVerdict(report({ unmapped_specs: ['renamed test'] }), { expected: ['X-A-001'] });
  assert.equal(v.incomplete, true);
  assert.match(v.reason, /renamed test/);
});

test('every selected case present and passing is green', () => {
  assert.equal(ciVerdict(report(), { expected: ['X-A-001'] }).ok, true);
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

test('a spec path with whitespace is refused, not shell-split into two missing files', () => {
  // The default output is a space-separated list. A path with a space would arrive at the
  // runner as two paths that do not exist, and the error would read as a missing file.
  const { run, skipped } = select(
    { 'X-A-001': H(SPEC) }, { 'X-A-001': 'e2e/my feature/a.spec.ts' }, { 'e2e/my feature/a.spec.ts': SPEC },
  );
  assert.deepEqual(run, []);
  assert.match(skipped[0].reason, /whitespace/);
});

// --- what the approval hash covers ------------------------------------------

test('editing a helper the spec imports drops it from CI', () => {
  const spec = "import { login } from './helpers/login';\n" + SPEC;
  const approved = { 'X-A-001': H(spec, { 'e2e/helpers/login.ts': 'export const login = 1;' }) };
  const same = select(approved, { 'X-A-001': 'e2e/a.spec.ts' }, { 'e2e/a.spec.ts': spec, 'e2e/helpers/login.ts': 'export const login = 1;' });
  assert.equal(same.run.length, 1);
  const edited = select(approved, { 'X-A-001': 'e2e/a.spec.ts' }, { 'e2e/a.spec.ts': spec, 'e2e/helpers/login.ts': 'export const login = 2;' });
  assert.equal(edited.run.length, 0);
  assert.match(edited.skipped[0].reason, /a file it imports/);
});

test('helpers are followed through nested imports, .js specifiers and index files', () => {
  const spec = "import { a } from './lib/index.js';\n" + SPEC;
  const files = { 'e2e/lib/index.ts': "export * from './deep';", 'e2e/lib/deep/index.ts': 'export const a = 1;' };
  const h1 = H(spec, files);
  const h2 = H(spec, { ...files, 'e2e/lib/deep/index.ts': 'export const a = 2;' });
  assert.notEqual(h1, h2);
});

test('the write guard templates are not part of the hash, so an upgrade keeps approvals', () => {
  const spec = "import { test } from './write-guard.fixture';\n" + SPEC;
  assert.equal(H(spec, { 'e2e/write-guard.fixture.ts': 'v1' }), H(spec, { 'e2e/write-guard.fixture.ts': 'v2' }));
});

test('changing the case expected outcome drops it from CI; a new title or priority does not', () => {
  const approved = { 'X-A-001': H(SPEC) };
  const files = { 'e2e/a.spec.ts': SPEC };
  const changed = select(approved, { 'X-A-001': 'e2e/a.spec.ts' }, files, { cases: [{ ...CASE, expected: ['the heading reads Invoices'] }] });
  assert.equal(changed.run.length, 0);
  const retitled = select(approved, { 'X-A-001': 'e2e/a.spec.ts' }, files, { cases: [{ ...CASE, title: 'new', priority: 'P1' }] });
  assert.equal(retitled.run.length, 1);
});

test('a case deleted from cases.yaml is named for retirement, not run', () => {
  const r = select({ 'X-A-001': H(SPEC) }, { 'X-A-001': 'e2e/a.spec.ts' }, { 'e2e/a.spec.ts': SPEC }, { cases: [] });
  assert.equal(r.run.length, 0);
  assert.match(r.skipped[0].reason, /no longer in cases\.yaml/);
});

test('Windows line endings hash the same as Unix ones', () => {
  assert.equal(H(SPEC.replace(/;/g, ';\n')), H(SPEC.replace(/;/g, ';\r\n')));
});
