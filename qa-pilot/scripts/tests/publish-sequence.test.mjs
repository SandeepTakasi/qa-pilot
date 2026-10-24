// The publish and review sequence run end to end through the CLIs, as the skills run it.
// Each test reproduces a defect a full-cycle review proved in 0.4.2, where every script
// passed its own unit tests and the sequence between them was wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload, runRecord } from '../publish-payload.mjs';
import { loadProfile } from '../lib/profile.mjs';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(SCRIPTS, '../../fixtures/host-fake');
const PROFILE = join(FIXTURES, 'qa-pilot.config.yaml');
const node = (script, args, cwd) => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-sequence-'));
const at = (p) => join(dir, p);
copyFileSync(join(FIXTURES, 'testing/checkout/cases.yaml'), at('cases.yaml'));
const json = (name, v) => { writeFileSync(at(name), JSON.stringify(v)); return at(name); };

// Run 2 of a feature. Before it, QA had approved all four cases: 001 to 003 as passes with
// their hashes in the ledger, and P0 case 004 as a confirmed defect, which records no hash.
// In run 2, 004 passes (the fix landed) and 002's spec was edited.
const statusesBefore = json('statuses.json', {
  'CHECKOUT-ORDER-001': 'Approved', 'CHECKOUT-ORDER-002': 'Approved',
  'CHECKOUT-QTY-003': 'Approved', 'CHECKOUT-PERM-004': 'Approved',
});
const ledger = { 'CHECKOUT-ORDER-001': 'h1', 'CHECKOUT-ORDER-002': 'h2', 'CHECKOUT-QTY-003': 'h3' };
const report = {
  run_id: '20261024T1000Z-checkout-a1b2c3d', run_kind: 'verdict', feature: 'checkout', app: 'storefront',
  env_name: 'qa', env_kind: 'qa', env_url: 'https://qa.host-fake.example.com', api_mode: 'server',
  commit_sha: 'a1b2c3d', sha_format: 'commit', executor: 'tester', model_version: 'claude-fable-5', browser: 'chromium',
  cases: [
    { id: 'CHECKOUT-ORDER-001', verdict: 'pass', spec_sha: 'h1', trace: 'test-results/1/trace.zip', trace_sha256: 'aa' },
    { id: 'CHECKOUT-ORDER-002', verdict: 'pass', spec_sha: 'h2-edited', trace: 'test-results/2/trace.zip', trace_sha256: 'bb' },
    { id: 'CHECKOUT-QTY-003', verdict: 'fail', spec_sha: 'h3', trace: 'test-results/3/trace.zip', trace_sha256: 'cc', failure_summary: 'Error: expected 2 items, got 3' },
    { id: 'CHECKOUT-PERM-004', verdict: 'pass', spec_sha: 'h4', trace: 'test-results/4/trace.zip', trace_sha256: 'dd' },
  ],
  summary: { pass: 3, fail: 1, flaky: 0, blocked: 0 },
};
const reportPath = json('report.json', report);

test('the published score counts only what survives this publish', () => {
  writeFileSync(at('approved.json'), JSON.stringify(ledger));
  const t = node('case-status.mjs', ['--transitions', '--cases', at('cases.yaml'), '--statuses', statusesBefore,
    '--verdicts', reportPath, '--approved', at('approved.json')]);
  assert.equal(t.code, 0, t.err);
  const transitions = JSON.parse(t.out);
  const to = Object.fromEntries(transitions.transitions.map((x) => [x.id, x.to]));
  assert.deepEqual(to, {
    'CHECKOUT-ORDER-001': 'approved', 'CHECKOUT-ORDER-002': 'under_review',
    'CHECKOUT-QTY-003': 'under_review', 'CHECKOUT-PERM-004': 'under_review',
  });
  writeFileSync(at('transitions.json'), t.out);

  // Scored on the statuses before the publish (the 0.4.2 order), P0 case 004 reads as an
  // approved pass although this publish sends it back to review.
  const before = JSON.parse(node('case-status.mjs', ['--cases', at('cases.yaml'), '--statuses', statusesBefore, '--verdicts', reportPath]).out);
  assert.equal(before.confidence.ready, true);
  // Scored after the transitions apply: 004 is not an approved pass, so Not Ready.
  const after = JSON.parse(node('case-status.mjs', ['--cases', at('cases.yaml'), '--statuses', statusesBefore,
    '--verdicts', reportPath, '--apply-transitions', at('transitions.json')]).out);
  assert.equal(after.confidence.ready, false);
  assert.equal(after.confidence.label, 'Not Ready');
  assert.match(after.confidence.why, /P0/);
});

test('a ledger with merge-conflict markers is refused, never read as empty and written back', () => {
  const conflicted = `{\n<<<<<<< HEAD\n  "CHECKOUT-ORDER-001": "h1"\n=======\n  "CHECKOUT-ORDER-001": "h9"\n>>>>>>> main\n}\n`;
  writeFileSync(at('conflicted.json'), conflicted);
  const t = node('case-status.mjs', ['--transitions', '--cases', at('cases.yaml'), '--statuses', statusesBefore,
    '--verdicts', reportPath, '--approved', at('conflicted.json')]);
  assert.equal(t.code, 1);
  assert.equal(t.out, '');
  assert.match(t.err, /merge-conflict markers/);
  const r = node('case-status.mjs', ['--record-approvals', '--verdicts', reportPath, '--approved', at('conflicted.json'), '--ids', 'CHECKOUT-ORDER-001']);
  assert.equal(r.code, 1);
  assert.match(r.err, /merge-conflict markers/);
});

test('a broken bug ledger is refused too, so open bugs are not refiled', () => {
  writeFileSync(at('bugs.json'), '{ "CHECKOUT-QTY-003": ');
  const b = node('bug-report.mjs', ['--report', reportPath, '--cases', at('cases.yaml'), '--confirmed', 'CHECKOUT-QTY-003',
    '--profile', PROFILE, '--bugs', at('bugs.json')]);
  assert.equal(b.code, 1);
  assert.match(b.err, /--bugs: .*bugs\.json is not valid JSON/);
});

test('the committed run record lets QA record approvals and file bugs on another machine', () => {
  const t = JSON.parse(readFileSync(at('transitions.json'), 'utf8'));
  const conf = JSON.parse(node('case-status.mjs', ['--cases', at('cases.yaml'), '--statuses', statusesBefore,
    '--verdicts', reportPath, '--apply-transitions', at('transitions.json')]).out);
  writeFileSync(at('confidence.json'), JSON.stringify(conf));
  const p = node('publish-payload.mjs', [reportPath, '--profile', PROFILE, '--transitions', at('transitions.json'),
    '--confidence', at('confidence.json'), '--record-dir', at('verdicts')]);
  assert.equal(p.code, 0, p.err);
  const file = at(`verdicts/${report.run_id}.json`);
  assert.equal(JSON.parse(p.out).record_file, file);
  assert.ok(existsSync(file));
  assert.equal(t.transitions.length, 4);

  // QA, after a pull: the record carries each verdict and the hash it ran under.
  const rec = node('case-status.mjs', ['--record-approvals', '--verdicts', file, '--approved', at('qa-ledger.json'),
    '--ids', 'CHECKOUT-ORDER-002,CHECKOUT-PERM-004,CHECKOUT-QTY-003']);
  assert.equal(rec.code, 0, rec.err);
  assert.deepEqual(JSON.parse(rec.out).approved_ledger, { 'CHECKOUT-ORDER-002': 'h2-edited', 'CHECKOUT-PERM-004': 'h4' });

  // And files the confirmed defect from the record alone (the qa environment is tracker mode).
  const bug = node('bug-report.mjs', ['--report', file, '--cases', at('cases.yaml'), '--confirmed', 'CHECKOUT-QTY-003', '--profile', PROFILE]);
  assert.equal(bug.code, 0, bug.err);
  assert.match(JSON.stringify(JSON.parse(bug.out).create), /expected 2 items, got 3/);
});

test('the record carries failure text only where the tracker receives it', () => {
  for (const [mode, withText] of [['tracker', true], ['reference', true], ['local', false], ['none', false]]) {
    const r = runRecord(report, mode);
    const c = r.cases.find((x) => x.id === 'CHECKOUT-QTY-003');
    assert.equal(Object.hasOwn(c, 'failure_summary'), withText, mode);
    assert.equal(c.spec_sha, 'h3', mode);
    assert.equal(r.evidence_mode, mode);
    // Never the per-attempt detail that only the run directory needs.
    assert.ok(!Object.hasOwn(c, 'writes') && !Object.hasOwn(c, 'console_log') && !Object.hasOwn(c, 'video'), mode);
  }
});

test('in tracker mode a trace path outside the run directory is refused before upload', () => {
  const { profile } = loadProfile(PROFILE);
  const bad = { ...report, cases: [{ ...report.cases[0], trace: '../../elsewhere/trace.zip' }] };
  const conf = { confidence: { score: 0, label: 'Not Ready', ready: false } };
  assert.throws(() => buildPayload(bad, profile, { transitions: { transitions: [] }, confidence: conf }), /inside the run directory/);
});

test('spec hashes are taken when the run starts, so an edit before publish cannot borrow the verdict', () => {
  const app = at('app');
  mkdirSync(join(app, 'e2e/helpers'), { recursive: true });
  writeFileSync(join(app, 'e2e/helpers/cart.ts'), 'export const add = () => 1;\n');
  writeFileSync(join(app, 'e2e/order.spec.ts'), "import { add } from './helpers/cart';\ntest('CHECKOUT-ORDER-001 orders', () => {});\n");
  writeFileSync(join(app, 'specs.json'), JSON.stringify({ 'CHECKOUT-ORDER-001': 'e2e/order.spec.ts' }));
  const runDir = join(app, 'runs/r1');
  mkdirSync(runDir, { recursive: true });

  // run-tests, before Playwright starts
  const h = node('lib/spec-hash.mjs', ['--specs', 'specs.json', '--cases', at('cases.yaml')], app);
  assert.equal(h.code, 0, h.err);
  writeFileSync(join(runDir, 'spec-shas.json'), h.out);
  const ran = JSON.parse(h.out)['CHECKOUT-ORDER-001'];
  assert.match(ran, /^[0-9a-f]{16}$/);

  // the helper is edited after the run, before publish
  writeFileSync(join(app, 'e2e/helpers/cart.ts'), 'export const add = () => 2;\n');
  const now = JSON.parse(node('lib/spec-hash.mjs', ['--specs', 'specs.json', '--cases', at('cases.yaml')], app).out)['CHECKOUT-ORDER-001'];
  assert.notEqual(now, ran);

  writeFileSync(join(runDir, 'results.json'), JSON.stringify({ suites: [{ title: 'order.spec.ts', specs: [
    { title: 'CHECKOUT-ORDER-001 orders', tests: [{ results: [{ status: 'passed', retry: 0 }] }] },
  ] }] }));
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ ...report, cases: undefined, summary: undefined }));
  const parsed = node('parse-report.mjs', [join(runDir, 'results.json'), join(runDir, 'meta.json')], app);
  assert.equal(parsed.code, 0, parsed.err);
  const out = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
  assert.equal(out.cases[0].spec_sha, ran);
});

test('without spec-shas.json the report carries no hash and says why', () => {
  const runDir = at('app/runs/r2');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'results.json'), JSON.stringify({ suites: [] }));
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ run_id: 'r2', run_kind: 'verdict' }));
  const parsed = node('parse-report.mjs', [join(runDir, 'results.json'), join(runDir, 'meta.json')]);
  assert.equal(parsed.code, 0);
  assert.match(parsed.err, /no spec-shas\.json/);
});
