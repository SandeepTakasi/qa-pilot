import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildReport, verdictFor } from '../parse-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const readJson = (p) => JSON.parse(readFileSync(resolve(FIXTURES, p), 'utf8'));
// Captured from a real `npx playwright test` run: 1 pass, 1 fail, 1 retry-pass, 1 skipped.
const pw = () => readJson('sample-playwright-report.json');
const meta = () => readJson('testing/checkout/sample-meta.json');
const byId = (r) => Object.fromEntries(r.cases.map((c) => [c.id, c]));

test('verdictFor: a case that passed only on retry is flaky, never pass', () => {
  assert.equal(verdictFor([{ status: 'failed' }, { status: 'passed' }]), 'flaky');
  assert.equal(verdictFor([{ status: 'timedOut' }, { status: 'passed' }]), 'flaky');
});

test('verdictFor: clean results map to their verdicts', () => {
  assert.equal(verdictFor([{ status: 'passed' }]), 'pass');
  assert.equal(verdictFor([{ status: 'failed' }, { status: 'failed' }]), 'fail');
  assert.equal(verdictFor([{ status: 'timedOut' }]), 'fail');
  assert.equal(verdictFor([{ status: 'skipped' }]), 'blocked');
  assert.equal(verdictFor([]), 'blocked');
});

test('verdictFor: a SHA mismatch blocks every case regardless of outcome', () => {
  assert.equal(verdictFor([{ status: 'passed' }], { shaMismatch: true }), 'blocked');
  assert.equal(verdictFor([{ status: 'failed' }], { shaMismatch: true }), 'blocked');
});

test('the real captured report maps to the four verdicts', () => {
  const r = buildReport(pw(), meta());
  assert.deepEqual(r.summary, { pass: 1, fail: 1, flaky: 1, blocked: 1 });
  const c = byId(r);
  assert.equal(c['CHECKOUT-ORDER-001'].verdict, 'pass');
  assert.equal(c['CHECKOUT-ORDER-002'].verdict, 'fail');
  assert.equal(c['CHECKOUT-QTY-003'].verdict, 'flaky');   // passed on retry
  assert.equal(c['CHECKOUT-PERM-004'].verdict, 'blocked'); // skipped
});

test('pass and fail cases carry video and trace paths', () => {
  const c = byId(buildReport(pw(), meta()));
  for (const id of ['CHECKOUT-ORDER-001', 'CHECKOUT-ORDER-002', 'CHECKOUT-QTY-003']) {
    assert.match(c[id].video, /\.webm$/, `${id} video`);
    assert.match(c[id].trace, /\.zip$/, `${id} trace`);
  }
});

test('failure_summary is the Playwright error with ANSI stripped, not model prose', () => {
  const c = byId(buildReport(pw(), meta()));
  const s = c['CHECKOUT-ORDER-002'].failure_summary;
  assert.match(s, /toHaveText/);
  assert.doesNotMatch(s, /|\[\d+m/, 'ANSI escapes leaked into the summary');
  assert.ok(s.length <= 501);
});

test('passing and blocked cases carry no failure summary', () => {
  const c = byId(buildReport(pw(), meta()));
  assert.equal(c['CHECKOUT-ORDER-001'].failure_summary, null);
  assert.equal(c['CHECKOUT-PERM-004'].failure_summary, null);
});

test('retries are counted from the attempts', () => {
  const c = byId(buildReport(pw(), meta()));
  assert.equal(c['CHECKOUT-ORDER-001'].retries, 0);
  assert.equal(c['CHECKOUT-QTY-003'].retries, 1);
});

test('a SHA change mid-run blocks the whole report', () => {
  const m = meta();
  m.sha_after = 'ffffffffffffffffffffffffffffffffffffffff';
  const r = buildReport(pw(), m);
  assert.equal(r.sha_mismatch, true);
  assert.deepEqual(r.summary, { pass: 0, fail: 0, flaky: 0, blocked: 4 });
});

test('the kind of build identity is recorded, so a bundle hash is never read as a commit', () => {
  const m = meta();
  m.sha_before = m.sha_after = 'BA5CNMey';
  m.sha_format = 'build-id';
  const r = buildReport(pw(), m);
  assert.equal(r.commit_sha, 'BA5CNMey');
  assert.equal(r.sha_format, 'build-id');
});

test('identity defaults to commit when the run did not say', () => {
  assert.equal(buildReport(pw(), meta()).sha_format, 'commit');
});

test('provenance is carried through from the run metadata', () => {
  const r = buildReport(pw(), meta());
  assert.equal(r.env_name, 'qa');
  assert.equal(r.executor, 'dev-fixture');
  assert.equal(r.sha_source, 'https://qa.host-fake.example.com/api/version');
  assert.equal(r.api_mode, 'server');
  assert.equal(r.playwright_version, '1.62.1');
});

test('specs without a case-ID prefix are dropped and reported, never guessed at', () => {
  const p = pw();
  p.suites[0].specs[0].title = 'some ad-hoc exploratory check';
  const r = buildReport(p, meta());
  assert.equal(r.cases.length, 3);
  assert.deepEqual(r.unmapped_specs, ['some ad-hoc exploratory check']);
});

// --- multi-project reports: one tests[] entry per browser, not per attempt ---

const multiProject = (...entries) => ({
  suites: [{ specs: [{ title: 'CHECKOUT-XBROWSER-001 t', tests: entries.map((results) => ({ results })) }], suites: [] }],
  config: {}, stats: {},
});
const one = (status, extra = {}) => ({ status, duration: 100, attachments: [], ...extra });

test('a genuine cross-browser failure is a fail, never a flake', () => {
  // Regression: flattening projects made chromium-pass + firefox-fail look like a retry.
  const r = buildReport(multiProject(
    [one('passed')],
    [one('failed', { error: { message: 'boom' } })],
  ), meta());
  assert.equal(r.cases[0].verdict, 'fail');
  assert.equal(r.cases[0].retries, 0, 'no attempt was retried, so retries must be 0');
  assert.match(r.cases[0].failure_summary, /boom/);
});

test('two clean projects are a pass with no phantom retry', () => {
  const r = buildReport(multiProject([one('passed')], [one('passed')]), meta());
  assert.equal(r.cases[0].verdict, 'pass');
  assert.equal(r.cases[0].retries, 0);
});

test('a real retry inside one project is still flaky', () => {
  const r = buildReport(multiProject(
    [one('failed', { error: { message: 'x' } }), one('passed')],
    [one('passed')],
  ), meta());
  assert.equal(r.cases[0].verdict, 'flaky');
  assert.equal(r.cases[0].retries, 1);
});

test('retries are summed per project, not inflated by project count', () => {
  const r = buildReport(multiProject(
    [one('failed', { error: { message: 'x' } }), one('passed')],
    [one('failed', { error: { message: 'y' } }), one('passed')],
  ), meta());
  assert.equal(r.cases[0].retries, 2);
});

test('an interrupted attempt is blocked, not a fail with no summary', () => {
  // As a fail it tripped "failure_summary required" and refused the whole report.
  assert.equal(verdictFor([{ status: 'interrupted' }]), 'blocked');
  assert.equal(verdictFor([{ status: 'timedOut' }]), 'fail', 'a timeout is still a real failure');
});

test('nested describe suites are walked', () => {
  const p = pw();
  const inner = { specs: p.suites[0].specs.splice(0, 1), suites: [] };
  p.suites[0].suites = [inner];
  assert.equal(buildReport(p, meta()).cases.length, 4);
});
