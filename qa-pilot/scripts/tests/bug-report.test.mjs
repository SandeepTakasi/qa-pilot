import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { buildBugs, bugBody, failureSignature } from '../bug-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const report = () => JSON.parse(readFileSync(resolve(FIXTURES, 'testing/checkout/sample-report.json'), 'utf8'));
const cases = () => parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8')).cases;
const { profile } = loadProfile(resolve(FIXTURES, 'qa-pilot.config.yaml'));

const FAIL = 'CHECKOUT-ORDER-002';   // verdict: fail
const FLAKY = 'CHECKOUT-QTY-003';    // verdict: flaky
const PASS = 'CHECKOUT-ORDER-001';   // verdict: pass

const build = (confirmed, opts = {}) => buildBugs(report(), cases(), confirmed, { profile, ...opts });

// --- what may become a bug ---------------------------------------------------

test('a confirmed failure becomes one bug', () => {
  const out = build([FAIL]);
  assert.equal(out.create.length, 1);
  assert.equal(out.create[0].id, FAIL);
  assert.equal(out.create[0].link_to_case, FAIL);
  assert.equal(out.create[0].priority, 'P1');
});

test('a passing case is never filed as a bug', () => {
  const out = build([PASS]);
  assert.deepEqual(out.create, []);
  assert.match(out.skipped[0].reason, /not a failure/);
});

test('a flaky case is filed, and labelled intermittent', () => {
  // An intermittent product bug is real. Hiding the intermittency costs the developer
  // their first hour, since one manual attempt will often pass.
  const out = build([FLAKY]);
  assert.equal(out.create.length, 1);
  assert.ok(out.create[0].tags.includes('intermittent'));
  assert.match(out.create[0].body, /intermittent/);
  assert.match(out.create[0].body, /do not close it because one manual attempt worked/);
});

test('a case absent from the run is skipped, never invented', () => {
  const out = build(['CHECKOUT-GHOST-099']);
  assert.deepEqual(out.create, []);
  assert.match(out.skipped[0].reason, /no evidence to file against/);
});

test('a case absent from cases.yaml is skipped', () => {
  const r = report();
  r.cases.push({ id: 'CHECKOUT-ORPHAN-050', verdict: 'fail', failure_summary: 'Error: boom', trace: 't.zip' });
  const out = buildBugs(r, cases(), ['CHECKOUT-ORPHAN-050'], { profile });
  assert.deepEqual(out.create, []);
  assert.match(out.skipped[0].reason, /steps and expectations are unknown/);
});

test('a failure with no recorded error is not filed', () => {
  const r = report();
  r.cases.find((c) => c.id === FAIL).failure_summary = null;
  const out = buildBugs(r, cases(), [FAIL], { profile });
  assert.deepEqual(out.create, []);
  assert.match(out.skipped[0].reason, /cannot evidence/);
});

// --- the body is copied, never described -------------------------------------

test('the bug carries the Playwright error verbatim', () => {
  const r = report();
  const c = r.cases.find((x) => x.id === FAIL);
  const body = bugBody(c, cases().find((k) => k.id === FAIL), r);
  assert.ok(body.includes(c.failure_summary), 'the error must appear unaltered');
});

test('the bug carries the case steps, expectations and the build it was proved against', () => {
  const out = build([FAIL]);
  const body = out.create[0].body;
  const kase = cases().find((k) => k.id === FAIL);
  for (const step of kase.steps) assert.ok(body.includes(step), `missing step: ${step}`);
  for (const exp of kase.expected) assert.ok(body.includes(exp), `missing expectation: ${exp}`);
  assert.ok(body.includes(report().commit_sha));
  assert.ok(body.includes(report().env_url));
  assert.ok(body.includes(report().run_id));
});

test('a build-id is labelled as one, so it is never mistaken for a commit', () => {
  const r = report();
  r.sha_format = 'build-id';
  const body = bugBody(r.cases.find((c) => c.id === FAIL), cases().find((k) => k.id === FAIL), r);
  assert.match(body, /build id, not a commit/);
});

test('the repro command appears only when the spec path is known', () => {
  const withSpec = build([FAIL], { specs: { [FAIL]: 'e2e/checkout/CHECKOUT-ORDER-002.spec.ts' } });
  assert.match(withSpec.create[0].body, /npx playwright test e2e\/checkout\/CHECKOUT-ORDER-002\.spec\.ts/);
  // Without one, no command: a guessed path sends the developer to a file that is not there.
  assert.doesNotMatch(build([FAIL]).create[0].body, /npx playwright test/);
});

test('the bug warns that the trace is a credential', () => {
  assert.match(build([FAIL]).create[0].body, /trace as a credential/);
});

// --- deduplication -----------------------------------------------------------

test('the same failure filed twice comments instead of filing again', () => {
  // A weekly regression run against an unfixed bug would otherwise file it every week,
  // and a board of duplicates is a board nobody reads.
  const first = build([FAIL]);
  const ledger = { ...first.ledger };
  ledger[FAIL].task_id = 'abc123';

  const second = build([FAIL], { ledger });
  assert.deepEqual(second.create, []);
  assert.equal(second.comment.length, 1);
  assert.equal(second.comment[0].task_id, 'abc123');
  assert.match(second.comment[0].body, /Still failing/);
  assert.equal(second.ledger[FAIL].seen_count, 2);
});

test('a different failure on the same case files a new bug and names the old one', () => {
  const ledger = { [FAIL]: { task_id: 'abc123', signature: 'somethingelse', seen_count: 1 } };
  const out = build([FAIL], { ledger });
  assert.equal(out.create.length, 1);
  assert.equal(out.create[0].supersedes.task_id, 'abc123');
  assert.match(out.create[0].supersedes.note, /different defect/);
});

test('a ledger entry with no task id does not suppress the bug', () => {
  // task_id is null until ClickUp returns one. Treating that as "already filed" would
  // lose the bug entirely if the write failed halfway.
  const ledger = { [FAIL]: { task_id: null, signature: failureSignature(FAIL, report().cases.find((c) => c.id === FAIL).failure_summary) } };
  const out = build([FAIL], { ledger });
  assert.equal(out.create.length, 1);
});

test('run-varying numbers do not split one defect into two bugs', () => {
  // Playwright errors carry timeouts and element counts that differ between runs while
  // naming the same break.
  const a = failureSignature('X-1', 'Timeout 5000ms exceeded waiting for locator, 3 elements found');
  const b = failureSignature('X-1', 'Timeout 30000ms exceeded waiting for locator, 7 elements found');
  assert.equal(a, b);
});

test('different cases never share a signature', () => {
  assert.notEqual(failureSignature('X-1', 'Error: boom'), failureSignature('X-2', 'Error: boom'));
});

// --- where bugs land ---------------------------------------------------------

test('the profile names the bug list when it declares one', () => {
  const p = JSON.parse(JSON.stringify(profile));
  p.clickup.bug_list = 'Storefront Bugs';
  const out = buildBugs(report(), cases(), [FAIL], { profile: p });
  assert.equal(out.create[0].list, 'Storefront Bugs');
  assert.deepEqual(out.warnings, []);
});

test('with no bug list the bug still files, and says where it landed', () => {
  const out = build([FAIL]);
  assert.equal(out.create[0].list, null);
  assert.match(out.create[0].list_source, /no clickup.bug_list/);
  assert.ok(out.warnings.some((w) => /bug_list is not set/.test(w)));
});

test('no warning about the bug list when nothing is being filed', () => {
  assert.deepEqual(build([PASS]).warnings, []);
});

test('a superseded bug keeps its task id in the ledger', () => {
  // A changed failure does not mean the old defect was fixed, and that bug may still be
  // open. Once the new entry replaces the old one, the ledger is the only link left.
  const ledger = { [FAIL]: { task_id: 'abc123', signature: 'somethingelse', seen_count: 1 } };
  const out = build([FAIL], { ledger });
  assert.deepEqual(out.ledger[FAIL].superseded, ['abc123']);
});

test('superseded ids accumulate rather than replacing each other', () => {
  const ledger = { [FAIL]: { task_id: 'second', signature: 'other', superseded: ['first'] } };
  const out = build([FAIL], { ledger });
  assert.deepEqual(out.ledger[FAIL].superseded, ['first', 'second']);
});
