import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile, validateProfile } from '../lib/profile.mjs';
import { buildBugs, failureSignature } from '../bug-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const PROFILE_PATH = resolve(FIXTURES, 'qa-pilot.config.yaml');
const cases = () => parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8')).cases;
const { profile: QA } = loadProfile(PROFILE_PATH);
const FAIL = 'CHECKOUT-ORDER-002';
const SHA = 'c'.repeat(64);

// The sample qa report, moved to another environment and given the 0.3.0 fields.
function report(env = 'qa', kind = env) {
  const r = JSON.parse(readFileSync(resolve(FIXTURES, 'testing/checkout/sample-report.json'), 'utf8'));
  r.env_name = env;
  r.env_kind = kind;
  for (const c of r.cases) c.trace_sha256 = c.trace ? SHA : null;
  return r;
}
const failureText = () => report().cases.find((c) => c.id === FAIL).failure_summary;

function profileWith(edit) {
  const raw = parse(readFileSync(PROFILE_PATH, 'utf8'));
  edit(raw);
  const { profile, errors } = validateProfile(raw);
  assert.deepEqual(errors, []);
  return profile;
}
const PROD = profileWith((p) => {
  p.environments.production = {
    kind: 'production',
    apps: { storefront: 'https://app.host-fake.example.com' },
    test_account: 'qa-runner@example.com, own tenant, no admin rights',
    sha_source: { url: 'https://app.host-fake.example.com/api/version', json_path: 'build.commit' },
  };
  p.mutation = { write_signatures: [{ method: 'DELETE', url: '/api/' }] };
});
const LOCAL_STAGING = profileWith((p) => { p.environments.staging.evidence_upload = 'local'; });
const NONE = profileWith((p) => { p.tracker = 'none'; delete p.clickup; });

// Everything the tracker must not receive from a local-evidence run.
function assertWithheld(text, r) {
  assert.ok(!text.includes(failureText()), 'failure text leaked');
  assert.ok(!text.includes('toHaveText'), 'failure text leaked');
  assert.ok(!text.includes(r.env_url ?? '\u0000'), 'env_url leaked');
  assert.ok(!text.includes(r.executor), 'executor leaked');
  assert.ok(!/\/Users\/|\/home\//.test(text), 'an absolute path leaked');
}

// --- refusals ---------------------------------------------------------------------

test('without a profile, a production report is refused', () => {
  assert.throws(() => buildBugs(report('production'), cases(), [FAIL]), /refused.*profile/i);
});

test('without a profile, a report with no env_kind is refused', () => {
  const r = report();
  delete r.env_kind;
  assert.throws(() => buildBugs(r, cases(), [FAIL]), /refused.*profile/i);
});

test('without a profile, an env_kind that is not exactly qa or staging is refused', () => {
  for (const kind of ['prod', 'Production', 'live', 'QA']) {
    assert.throws(() => buildBugs(report('qa', kind), cases(), [FAIL]), /refused.*profile/i, kind);
  }
  assert.equal(buildBugs(report('staging'), cases(), [FAIL]).create.length, 1);
});

test('without a profile, a qa report still files as before', () => {
  const out = buildBugs(report(), cases(), [FAIL]);
  assert.equal(out.create.length, 1);
  assert.ok(out.create[0].body.includes(failureText()));
});

test('a profile that does not register the report environment is refused', () => {
  assert.throws(() => buildBugs(report('nowhere'), cases(), [FAIL], { profile: QA }), /"nowhere" is not a registered environment/);
});

// --- local evidence: no application data in the bug ----------------------------------

test('a production bug names the trace path and sha256 instead of the failure text', () => {
  const r = report('production');
  const out = buildBugs(r, cases(), [FAIL], { profile: PROD });
  const bug = out.create[0];
  assertWithheld(bug.body, r);
  for (const s of [FAIL, r.run_id, 'production', r.commit_sha, 'test-results/checkout-order-002/trace.zip', SHA]) {
    assert.ok(bug.body.includes(s), `body should name ${s}`);
  }
  assert.equal(bug.trace_attachment, null, 'nothing is attached');
});

test('a production dedup comment carries no failure text either', () => {
  const r = report('production');
  const signature = failureSignature(FAIL, r.cases.find((c) => c.id === FAIL).failure_summary);
  const out = buildBugs(r, cases(), [FAIL], { profile: PROD, ledger: { [FAIL]: { task_id: 't1', signature } } });
  assert.equal(out.comment.length, 1);
  assertWithheld(out.comment[0].body, r);
  assert.ok(out.comment[0].body.includes(SHA));
  assert.ok(out.comment[0].body.includes('test-results/checkout-order-002/trace.zip'));
});

test('withholding keys on local evidence, so a staging environment set to local is withheld too', () => {
  const r = report('staging');
  const bug = buildBugs(r, cases(), [FAIL], { profile: LOCAL_STAGING }).create[0];
  assertWithheld(bug.body, r);
  assert.equal(bug.trace_attachment, null);
});

test('a qa run that uploads to the tracker keeps the failure text and the attachment', () => {
  const bug = buildBugs(report(), cases(), [FAIL], { profile: QA }).create[0];
  assert.ok(bug.body.includes(failureText()));
  assert.ok(bug.trace_attachment);
});

test('the dedup signature is unchanged by any of this', () => {
  const r = report();
  const out = buildBugs(r, cases(), [FAIL], { profile: QA });
  assert.equal(out.ledger[FAIL].signature, failureSignature(FAIL, r.cases.find((c) => c.id === FAIL).failure_summary));
});

// --- tracker: none: bugs are files in the run directory ---------------------------------

test('under tracker: none a bug is a file in the run directory and keeps the failure text', () => {
  const r = report();
  const out = buildBugs(r, cases(), [FAIL], { profile: NONE });
  const bug = out.create[0];
  assert.equal(bug.file, `testing/checkout/runs/${r.run_id}/bugs/${FAIL}.md`);
  assert.equal(bug.list, null);
  assert.equal(bug.trace_attachment, null);
  assert.ok(bug.body.includes(failureText()), 'it never leaves the machine, so the text stays');
  assert.ok(bug.body.includes('test-results/checkout-order-002/trace.zip'));
  assert.deepEqual(out.warnings, [], 'no bug-list nag without a tracker');
});

test('under tracker: none a repeat failure is a new file for the new run, not a comment', () => {
  const r = report();
  const signature = failureSignature(FAIL, r.cases.find((c) => c.id === FAIL).failure_summary);
  const out = buildBugs(r, cases(), [FAIL], { profile: NONE, ledger: { [FAIL]: { task_id: null, signature } } });
  assert.equal(out.comment.length, 0);
  assert.equal(out.create.length, 1);
});

test('under tracker: none even a ledger entry with a task id gets a file, never a tracker comment', () => {
  // A ledger left over from before the switch to tracker: none must not send anything.
  const r = report();
  const signature = failureSignature(FAIL, r.cases.find((c) => c.id === FAIL).failure_summary);
  const out = buildBugs(r, cases(), [FAIL], { profile: NONE, ledger: { [FAIL]: { task_id: 't-old', signature } } });
  assert.equal(out.comment.length, 0);
  assert.equal(out.create.length, 1);
  assert.ok(out.create[0].file);
});
