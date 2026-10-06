import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile, validateProfile } from '../lib/profile.mjs';
import { buildPayload } from '../publish-payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const PROFILE_PATH = resolve(FIXTURES, 'qa-pilot.config.yaml');
const CLI = resolve(HERE, '../publish-payload.mjs');
const { profile: QA } = loadProfile(PROFILE_PATH);
const SHA = 'd'.repeat(64);

function report(env = 'qa') {
  const r = JSON.parse(readFileSync(resolve(FIXTURES, 'testing/checkout/sample-report.json'), 'utf8'));
  r.env_name = env;
  r.env_kind = env;
  for (const c of r.cases) c.trace_sha256 = c.trace ? SHA : null;
  return r;
}
const TRANSITIONS = {
  transitions: [
    { id: 'CHECKOUT-ORDER-001', from: 'approved', to: 'approved', verdict: 'pass', reason: 'x' },
    { id: 'CHECKOUT-ORDER-002', from: 'approved_for_execution', to: 'under_review', verdict: 'fail', reason: 'x' },
    { id: 'CHECKOUT-QTY-003', from: 'approved_for_execution', to: 'quarantined', verdict: 'flaky', reason: 'x' },
  ],
  approved_ledger: {},
};
const CONFIDENCE = { confidence: { score: 0.4, ready: false, label: 'Not Ready', why: 'at least one P0 case is not an approved pass' } };

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
const NONE = profileWith((p) => { p.tracker = 'none'; delete p.clickup; });
const build = (r, profile) => buildPayload(r, profile, { transitions: TRANSITIONS, confidence: CONFIDENCE });

// --- local evidence: exactly the Decision 4 fields, nothing more ----------------------

const LOCAL_CASE_KEYS = ['case_id', 'verdict', 'target_status', 'env_name', 'build_id', 'run_id', 'trace_path', 'trace_sha256'];
const LOCAL_SUMMARY_KEYS = ['run_id', 'env_name', 'build_id', 'counts', 'blocked_pct', 'confidence', 'ready'];

test('a production payload carries exactly the allowed per-case fields', () => {
  const p = build(report('production'), PROD);
  assert.equal(p.mode, 'local');
  for (const c of p.cases) assert.deepEqual(Object.keys(c).sort(), [...LOCAL_CASE_KEYS].sort(), c.case_id);
  const c = p.cases.find((x) => x.case_id === 'CHECKOUT-ORDER-002');
  assert.equal(c.trace_path, 'test-results/checkout-order-002/trace.zip');
  assert.equal(c.trace_sha256, SHA);
  assert.equal(c.target_status, 'ready for review', 'resolved to this host\'s status name');
});

test('a production run summary carries exactly the allowed fields', () => {
  const p = build(report('production'), PROD);
  assert.deepEqual(Object.keys(p.summary).sort(), [...LOCAL_SUMMARY_KEYS].sort());
  assert.deepEqual(p.summary.counts, { pass: 2, fail: 1, flaky: 1, blocked: 0 });
  assert.equal(p.summary.blocked_pct, 0);
  assert.deepEqual(p.summary.confidence, { score: 0.4, label: 'Not Ready' });
  assert.equal(p.summary.ready, false);
});

test('nothing from the run beyond those fields appears anywhere in a production payload', () => {
  const r = report('production');
  const text = JSON.stringify(build(r, PROD));
  for (const leak of [r.cases.find((c) => c.failure_summary).failure_summary, 'toHaveText', r.env_url,
    r.executor, r.api_mode, r.model_version, r.browser, '.webm', 'attach']) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(!/"\/(Users|home)\//.test(text), 'an absolute path leaked');
});

test('a local trace path that escapes the run directory is refused, not sent', () => {
  const r = report('production');
  r.cases[0].trace = '/Users/someone/run/trace.zip';
  assert.throws(() => build(r, PROD), /trace path .* inside the run directory/);
});

test('local is keyed on evidence_upload, so a staging env set to local gets the same payload', () => {
  const staging = profileWith((p) => { p.environments.staging.evidence_upload = 'local'; });
  const p = build(report('staging'), staging);
  assert.equal(p.mode, 'local');
  assert.deepEqual(Object.keys(p.cases[0]).sort(), [...LOCAL_CASE_KEYS].sort());
});

// --- tracker upload: the 0.2.0 field set and the trace to attach ----------------------

test('a tracker payload has the 0.2.0 fields and names the trace to attach', () => {
  const r = report();
  const p = build(r, QA);
  assert.equal(p.mode, 'tracker');
  const c = p.cases.find((x) => x.case_id === 'CHECKOUT-ORDER-002');
  assert.deepEqual(c.fields, {
    Verdict: 'fail', 'Build SHA': r.commit_sha, Env: 'qa', 'API Mode': 'server', App: 'storefront',
    Executor: r.executor, 'Run Date': r.finished_at,
    'Flake Count': r.cases.find((x) => x.id === 'CHECKOUT-ORDER-002').retries, 'Model Version': r.model_version,
  });
  assert.equal(c.target_status, 'ready for review');
  assert.deepEqual(c.attach, { path: 'test-results/checkout-order-002/trace.zip', name: `CHECKOUT-ORDER-002-${r.run_id}.zip` });
});

test('a case with no transition keeps its status: target_status is null', () => {
  const p = build(report(), QA);
  assert.equal(p.cases.find((x) => x.case_id === 'CHECKOUT-PERM-004').target_status, null);
});

test('a tracker run summary starts with the run id and carries the executor and reviewer line', () => {
  const r = report();
  const s = build(r, QA).summary;
  assert.equal(Object.keys(s)[0], 'run_id');
  assert.equal(s.executor, r.executor);
  assert.equal(s.build_sha, r.commit_sha);
  assert.match(s.reviewer_note, /trace\.playwright\.dev/);
});

// --- tracker: none: a plan of local writes ----------------------------------------------

test('tracker: none sends nothing and plans local writes instead', () => {
  const r = report();
  const p = build(r, NONE);
  assert.equal(p.mode, 'none');
  assert.equal(p.cases, undefined);
  assert.equal(p.statuses_file, 'testing/checkout/statuses.json');
  assert.deepEqual(p.status_writes, {
    'CHECKOUT-ORDER-001': 'Approved', 'CHECKOUT-ORDER-002': 'Under Review', 'CHECKOUT-QTY-003': 'Quarantined',
  });
  assert.equal(p.summary_file, `testing/checkout/runs/${r.run_id}/summary.json`);
  assert.equal(p.summary.run_id, r.run_id);
  assert.equal(p.bugs_dir, `testing/checkout/runs/${r.run_id}/bugs/`);
});

// --- inputs ------------------------------------------------------------------------------

test('an env_name the profile does not register is an error, never a fallback to tracker', () => {
  assert.throws(() => build(report('nowhere'), QA), /"nowhere" is not a registered environment/);
});

test('the confidence input is required, so the summary never invents a score', () => {
  assert.throws(() => buildPayload(report(), QA, { transitions: TRANSITIONS }), /confidence/);
});

test('the CLI prints the payload and makes no network call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-payload-'));
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report()));
  writeFileSync(join(dir, 't.json'), JSON.stringify(TRANSITIONS));
  writeFileSync(join(dir, 'c.json'), JSON.stringify(CONFIDENCE));
  const p = spawnSync('node', [CLI, join(dir, 'report.json'), '--profile', PROFILE_PATH,
    '--transitions', join(dir, 't.json'), '--confidence', join(dir, 'c.json')], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).mode, 'tracker');
  const missing = spawnSync('node', [CLI, join(dir, 'report.json'), '--profile', PROFILE_PATH], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /usage:/);
});

test('the script imports nothing that can reach the network', () => {
  const src = readFileSync(CLI, 'utf8');
  assert.doesNotMatch(src, /node:(http|https|net|dgram|tls)|fetch\(/);
});
