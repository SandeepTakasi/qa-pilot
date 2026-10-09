import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile, validateProfile, effectiveEvidenceUpload } from '../lib/profile.mjs';
import { buildPayload } from '../publish-payload.mjs';
import { validateReport } from '../validate-report.mjs';
import { buildBugs, failureSignature } from '../bug-report.mjs';

// The reference mode: the tracker gets the failure text and the fields, never the trace.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const PROFILE_PATH = resolve(FIXTURES, 'qa-pilot.config.yaml');
const { profile: TRACKER } = loadProfile(PROFILE_PATH);
const FAIL = 'CHECKOUT-ORDER-002';
const TRACE = 'test-results/checkout-order-002/trace.zip';
const SHA = 'e'.repeat(64);
const has = (list, re) => list.some((m) => re.test(m));
const cases = () => parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8')).cases;

const raw = () => parse(readFileSync(PROFILE_PATH, 'utf8'));
function validate(edit) {
  const p = raw();
  edit(p);
  return validateProfile(p);
}
function profileWith(edit) {
  const { profile, errors } = validate(edit);
  assert.deepEqual(errors, []);
  return profile;
}
// The fixture opts qa and staging into tracker; without that opt-in they get the default.
const REFERENCE = profileWith((p) => {
  delete p.environments.qa.evidence_upload;
  delete p.environments.staging.evidence_upload;
});
const addProduction = (p, extra = {}) => {
  p.environments.production = {
    kind: 'production',
    apps: { storefront: 'https://app.host-fake.example.com' },
    test_account: 'qa-runner@example.com, own tenant, no admin rights',
    sha_source: { url: 'https://app.host-fake.example.com/api/version', json_path: 'build.commit' },
    ...extra,
  };
  p.mutation = { write_signatures: [{ method: 'DELETE', url: '/api/' }] };
};

function report(env = 'qa', kind = env) {
  const r = JSON.parse(readFileSync(resolve(FIXTURES, 'testing/checkout/sample-report.json'), 'utf8'));
  r.env_name = env;
  r.env_kind = kind;
  for (const c of r.cases) c.trace_sha256 = c.trace ? SHA : null;
  return r;
}
const failureText = () => report().cases.find((c) => c.id === FAIL).failure_summary;
const TRANSITIONS = {
  transitions: [{ id: FAIL, from: 'approved_for_execution', to: 'under_review', verdict: 'fail', reason: 'x' }],
  approved_ledger: {},
};
const CONFIDENCE = { confidence: { score: 0.4, ready: false, label: 'Not Ready', why: 'a P0 case failed' } };
const payload = (r, profile) => buildPayload(r, profile, { transitions: TRANSITIONS, confidence: CONFIDENCE });

// --- the effective value ---------------------------------------------------------------

test('reference is the default off production', () => {
  assert.equal(effectiveEvidenceUpload({ kind: 'qa' }), 'reference');
  assert.equal(effectiveEvidenceUpload({ kind: 'staging' }, { tracker: 'clickup' }), 'reference');
  const { profile, errors } = validate((p) => { delete p.environments.qa.evidence_upload; });
  assert.deepEqual(errors, []);
  assert.equal(profile.environments.qa.evidence_upload, 'reference');
});

test('an explicit tracker, reference or local wins off production', () => {
  for (const v of ['tracker', 'reference', 'local']) {
    assert.equal(effectiveEvidenceUpload({ kind: 'staging', evidence_upload: v }), v);
    const { profile, errors } = validate((p) => { p.environments.staging.evidence_upload = v; });
    assert.deepEqual(errors, [], v);
    assert.equal(profile.environments.staging.evidence_upload, v);
  }
});

test('an unknown evidence_upload names all three values', () => {
  const { errors } = validate((p) => { p.environments.qa.evidence_upload = 'clickup'; });
  assert.ok(has(errors, /environments\.qa\.evidence_upload: must be tracker \| reference \| local/), errors.join('\n'));
});

test('production is always local, and an explicit tracker or reference there is refused by name', () => {
  for (const v of ['tracker', 'reference']) {
    assert.equal(effectiveEvidenceUpload({ kind: 'production', evidence_upload: v }), 'local');
    const { errors } = validate((p) => addProduction(p, { evidence_upload: v }));
    assert.ok(has(errors, new RegExp(`environments\\.production\\.evidence_upload: ${v} is refused on a production environment`)), errors.join('\n'));
  }
  assert.equal(effectiveEvidenceUpload({ kind: 'production' }), 'local');
  assert.deepEqual(validate((p) => addProduction(p, { evidence_upload: 'local' })).errors, []);
});

test('tracker: none is local whatever the environment says, reference included', () => {
  for (const v of [undefined, 'tracker', 'reference']) {
    assert.equal(effectiveEvidenceUpload({ kind: 'qa', evidence_upload: v }, { tracker: 'none' }), 'local', String(v));
  }
});

// --- the payload -------------------------------------------------------------------------

test('a reference case carries the tracker fields plus run_id, trace_path and trace_sha256, and no attach', () => {
  const r = report();
  const ref = payload(r, REFERENCE);
  const trk = payload(r, TRACKER);
  assert.equal(ref.mode, 'reference');
  for (const c of ref.cases) {
    assert.deepEqual(Object.keys(c).sort(), ['case_id', 'fields', 'run_id', 'target_status', 'trace_path', 'trace_sha256'], c.case_id);
    const t = trk.cases.find((x) => x.case_id === c.case_id);
    assert.deepEqual(c.fields, t.fields, 'the same fields as tracker');
    assert.equal(c.target_status, t.target_status);
    assert.equal(c.run_id, r.run_id);
  }
  const c = ref.cases.find((x) => x.case_id === FAIL);
  assert.equal(c.trace_path, TRACE);
  assert.equal(c.trace_sha256, SHA);
  assert.equal(c.target_status, 'ready for review');
  assert.ok(!JSON.stringify(ref).includes(`${FAIL}-${r.run_id}.zip`), 'no attachment name anywhere');
});

test('a reference summary is the tracker summary with a reviewer note that keeps traces on the machine', () => {
  const r = report();
  const ref = payload(r, REFERENCE).summary;
  const trk = payload(r, TRACKER).summary;
  assert.deepEqual(Object.keys(ref), Object.keys(trk));
  assert.deepEqual({ ...ref, reviewer_note: null }, { ...trk, reviewer_note: null });
  assert.match(ref.reviewer_note, /stay on the machine that ran them/);
  assert.match(ref.reviewer_note, /sha256/);
  assert.match(ref.reviewer_note, /npx playwright show-trace <path>/);
  assert.doesNotMatch(ref.reviewer_note, /trace\.playwright\.dev/);
});

test('a reference trace path that escapes the run directory is refused, not sent', () => {
  for (const trace of ['/Users/someone/run/trace.zip', '../elsewhere/trace.zip']) {
    const r = report();
    r.cases[0].trace = trace;
    assert.throws(() => payload(r, REFERENCE), /trace path .* inside the run directory/, trace);
  }
});

// --- the publish gate: rule 6 pins reference evidence too ----------------------------------

test('rule 6 applies to reference evidence and is satisfied by the real sha256', () => {
  const casesDoc = parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8'));
  const rule6 = (r, profile) => validateReport(r, profile, { base: FIXTURES, casesDoc }).errors.filter((e) => e.startsWith('rule 6: '));
  const r = report();
  for (const c of r.cases) c.trace_sha256 = null;
  assert.ok(has(rule6(r, REFERENCE), /trace_sha256: required/), 'an unpinned trace is refused');
  for (const c of r.cases) c.trace_sha256 = createHash('sha256').update(readFileSync(resolve(FIXTURES, c.trace))).digest('hex');
  assert.deepEqual(rule6(r, REFERENCE), []);
  r.cases[1].trace_sha256 = SHA;
  assert.ok(has(rule6(r, REFERENCE), /does not match its trace_sha256/));
  assert.deepEqual(rule6(report(), TRACKER), [], 'tracker upload: no pin needed');
});

// --- bug reports -------------------------------------------------------------------------

function assertReferenceBody(text) {
  assert.ok(text.includes(failureText()), 'the failure text reaches the tracker');
  assert.ok(text.includes(TRACE), 'names the trace path');
  assert.ok(text.includes(SHA), 'names the sha256');
  assert.doesNotMatch(text, /attached/);
}

test('a reference bug keeps the failure text, names the trace path and sha256, and attaches nothing', () => {
  const bug = buildBugs(report(), cases(), [FAIL], { profile: REFERENCE }).create[0];
  assertReferenceBody(bug.body);
  assert.match(bug.body, /npx playwright show-trace/);
  assert.equal(bug.trace_attachment, null);
});

test('a reference dedup comment keeps the failure text and names the trace instead of an attachment', () => {
  const r = report();
  const signature = failureSignature(FAIL, failureText());
  const out = buildBugs(r, cases(), [FAIL], { profile: REFERENCE, ledger: { [FAIL]: { task_id: 't1', signature } } });
  assert.equal(out.comment.length, 1);
  assertReferenceBody(out.comment[0].body);
});

test('without a profile, a qa or staging report files as reference', () => {
  for (const env of ['qa', 'staging']) {
    const bug = buildBugs(report(env), cases(), [FAIL]).create[0];
    assertReferenceBody(bug.body);
    assert.equal(bug.trace_attachment, null, env);
  }
});

test('without a profile, a production report is still refused', () => {
  assert.throws(() => buildBugs(report('production'), cases(), [FAIL]), /refused.*profile/i);
});
