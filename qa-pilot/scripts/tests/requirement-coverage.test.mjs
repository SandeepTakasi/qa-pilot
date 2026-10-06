import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile, validateProfile } from '../lib/profile.mjs';
import { partitionCases, requirementCoverage } from '../case-status.mjs';
import { buildPayload } from '../publish-payload.mjs';
import { DEFAULT_STATUSES } from '../lib/statuses.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const PROFILE_PATH = resolve(FIXTURES, 'qa-pilot.config.yaml');
const CASE_STATUS = resolve(HERE, '../case-status.mjs');
const OMITTED = 'requirements has lint errors, so requirement coverage is omitted; run validate-cases.mjs';

const TITLE = 'Orders can be placed';
const TEXT = 'Placing an order with one item shows an order number';
const doc = (cases, requirements) => ({
  ...(requirements === undefined ? {} : { requirements }),
  cases: cases.map(([id, covers]) => ({ id, priority: 'P1', ...(covers === undefined ? {} : { covers }) })),
});
const REQS = [
  { id: 'ORDER-1', title: TITLE, criteria: [{ id: 'AC-1', text: TEXT }, { id: 'AC-2', text: 'Another criterion text' }] },
  { id: 'ORDER-2', title: 'Orders can be cancelled', criteria: [{ id: 'AC-1', text: 'Cancelling marks the order cancelled' }] },
];
const A = 'Approved';
const R = 'Under Review';
const states = (cov) => cov.by_requirement.flatMap((r) => r.criteria.map((c) => `${r.id}/${c.id}=${c.state}`));
const one = (covers, status, verdict) => requirementCoverage(
  doc([['X-001', covers]], REQS), { 'X-001': status }, verdict === undefined ? {} : { 'X-001': verdict }, DEFAULT_STATUSES,
).by_requirement[0].criteria[0].state;

// --- states ---------------------------------------------------------------------------

test('a criterion no case covers is uncovered, with no cases', () => {
  const cov = requirementCoverage(doc([['X-001', ['ORDER-1/AC-1']]], REQS), { 'X-001': A }, { 'X-001': 'pass' }, DEFAULT_STATUSES);
  assert.deepEqual(cov.by_requirement[1].criteria, [{ id: 'AC-1', state: 'uncovered', cases: [] }]);
  assert.equal(cov.uncovered, 2);
});

test('an approved pass proves a criterion', () => {
  assert.equal(one(['ORDER-1/AC-1'], A, 'pass'), 'proved');
});

test('a pass QA has not approved yet is unproved, and so is an approved case that did not pass', () => {
  assert.equal(one(['ORDER-1/AC-1'], R, 'pass'), 'unproved');
  assert.equal(one(['ORDER-1/AC-1'], A, 'blocked'), 'unproved');
  assert.equal(one(['ORDER-1/AC-1'], A, undefined), 'unproved', 'approved but absent from the run');
});

test('a covered criterion whose only case is blocked is unproved, not failing', () => {
  assert.equal(one(['ORDER-1/AC-1'], A, 'blocked'), 'unproved');
  assert.equal(one(['ORDER-1/AC-1'], R, 'blocked'), 'unproved');
});

test('a fail or a flaky verdict makes a criterion failing, approved or not', () => {
  for (const status of [A, R]) {
    assert.equal(one(['ORDER-1/AC-1'], status, 'fail'), 'failing');
    assert.equal(one(['ORDER-1/AC-1'], status, 'flaky'), 'failing');
  }
});

test('evaluation order: a failing case is never hidden by another case that passed', () => {
  const d = doc([['X-001', ['ORDER-1/AC-1']], ['X-002', ['ORDER-1/AC-1']]], REQS);
  const cov = requirementCoverage(d, { 'X-001': A, 'X-002': A }, { 'X-001': 'pass', 'X-002': 'fail' }, DEFAULT_STATUSES);
  assert.equal(cov.by_requirement[0].criteria[0].state, 'failing');
  assert.deepEqual(cov.by_requirement[0].criteria[0].cases, ['X-001', 'X-002']);
});

test('one approved pass proves a criterion although a sibling case was blocked or unreviewed', () => {
  const d = doc([['X-001', ['ORDER-1/AC-1']], ['X-002', ['ORDER-1/AC-1']], ['X-003', ['ORDER-1/AC-1']]], REQS);
  const cov = requirementCoverage(d, { 'X-001': A, 'X-002': A, 'X-003': R }, { 'X-001': 'pass', 'X-002': 'blocked', 'X-003': 'pass' }, DEFAULT_STATUSES);
  assert.equal(cov.by_requirement[0].criteria[0].state, 'proved');
});

test('with no verdicts at all every covered criterion is unproved', () => {
  const d = doc([['X-001', ['ORDER-1/AC-1']], ['X-002', ['ORDER-1/AC-2']]], REQS);
  const cov = requirementCoverage(d, { 'X-001': A, 'X-002': A }, {}, DEFAULT_STATUSES);
  assert.deepEqual(states(cov), ['ORDER-1/AC-1=unproved', 'ORDER-1/AC-2=unproved', 'ORDER-2/AC-1=uncovered']);
  assert.equal(cov.unproved, 2);
});

test('status names map through the host profile, case-insensitively, like the confidence score', () => {
  const names = { ...DEFAULT_STATUSES, approved: 'signed off' };
  const d = doc([['X-001', ['ORDER-1/AC-1']]], REQS);
  const cov = requirementCoverage(d, { 'X-001': 'Signed Off' }, { 'X-001': 'pass' }, names);
  assert.equal(cov.by_requirement[0].criteria[0].state, 'proved');
  const plain = requirementCoverage(d, { 'X-001': 'Signed Off' }, { 'X-001': 'pass' }, DEFAULT_STATUSES);
  assert.equal(plain.by_requirement[0].criteria[0].state, 'unproved', 'an unknown status is not an approval');
  const none = requirementCoverage(d, {}, { 'X-001': 'pass' }, DEFAULT_STATUSES);
  assert.equal(none.by_requirement[0].criteria[0].state, 'unproved', 'a case with no status is not approved');
});

// --- the object ------------------------------------------------------------------------

test('the object matches the schema worked example, in declaration and cases-file order', () => {
  const reqs = [
    { id: 'ORDER-1', title: 't', criteria: [{ id: 'AC-1', text: 'a' }, { id: 'AC-2', text: 'b' }, { id: 'AC-3', text: 'c' }] },
    { id: 'ORDER-2', title: 't', criteria: [{ id: 'AC-1', text: 'd' }] },
  ];
  const d = doc([
    ['ORDER-PLACE-001', ['ORDER-1/AC-1']], ['ORDER-PLACE-002', ['ORDER-1/AC-2']],
    ['ORDER-PLACE-003', ['ORDER-1/AC-3']], ['ORDER-PLACE-004', ['ORDER-1/AC-1']],
  ], reqs);
  const statuses = { 'ORDER-PLACE-001': A, 'ORDER-PLACE-002': A, 'ORDER-PLACE-003': R, 'ORDER-PLACE-004': A };
  const verdicts = { 'ORDER-PLACE-001': 'pass', 'ORDER-PLACE-002': 'fail', 'ORDER-PLACE-003': 'pass', 'ORDER-PLACE-004': 'blocked' };
  assert.deepEqual(requirementCoverage(d, statuses, verdicts, DEFAULT_STATUSES), {
    criteria_total: 4, proved: 1, failing: 1, unproved: 1, uncovered: 1,
    by_requirement: [
      { id: 'ORDER-1', criteria: [
        { id: 'AC-1', state: 'proved', cases: ['ORDER-PLACE-001', 'ORDER-PLACE-004'] },
        { id: 'AC-2', state: 'failing', cases: ['ORDER-PLACE-002'] },
        { id: 'AC-3', state: 'unproved', cases: ['ORDER-PLACE-003'] },
      ] },
      { id: 'ORDER-2', criteria: [{ id: 'AC-1', state: 'uncovered', cases: [] }] },
    ],
  });
});

test('the object has no not_proved and never carries titles or criterion text', () => {
  const cov = requirementCoverage(doc([['X-001', ['ORDER-1/AC-1']]], REQS), { 'X-001': A }, { 'X-001': 'pass' }, DEFAULT_STATUSES);
  assert.deepEqual(Object.keys(cov), ['criteria_total', 'proved', 'failing', 'unproved', 'uncovered', 'by_requirement']);
  assert.ok(!JSON.stringify(cov).includes(TITLE) && !JSON.stringify(cov).includes(TEXT));
  assert.equal(cov.criteria_total, cov.proved + cov.failing + cov.unproved + cov.uncovered);
});

test('a case listing the same criterion twice is named once', () => {
  const cov = requirementCoverage(doc([['X-001', ['ORDER-1/AC-1', 'ORDER-1/AC-1']]], REQS), { 'X-001': A }, { 'X-001': 'pass' }, DEFAULT_STATUSES);
  assert.deepEqual(cov.by_requirement[0].criteria[0].cases, ['X-001']);
});

// --- validity and malformed input -----------------------------------------------------

test('no requirements key gives null, and an empty or absent cases list does not matter', () => {
  assert.equal(requirementCoverage({ cases: [] }, {}, {}, DEFAULT_STATUSES), null);
  assert.equal(requirementCoverage(doc([['X-001']]), {}, {}, DEFAULT_STATUSES), null);
  assert.equal(requirementCoverage({}, {}, {}, DEFAULT_STATUSES), null);
});

test('a malformed requirements block gives null', () => {
  for (const bad of [[], null, 'x', {}, [{ id: 'R', title: 't' }], [{ id: 'R', title: 't', criteria: [] }],
    [{ id: 1, title: 't', criteria: [{ id: 'A', text: 'x' }] }], [{ ...REQS[0] }, { ...REQS[0] }]]) {
    assert.equal(requirementCoverage(doc([['X-001']], bad), {}, {}, DEFAULT_STATUSES), null, JSON.stringify(bad));
  }
});

test('a covers error never suppresses coverage, and a bad entry is ignored', () => {
  const d = doc([['X-001', ['ORDER-1/AC-1', 'ORDER-9/AC-9', 'nonsense']]], REQS);
  const cov = requirementCoverage(d, { 'X-001': A }, { 'X-001': 'pass' }, DEFAULT_STATUSES);
  assert.deepEqual(states(cov), ['ORDER-1/AC-1=proved', 'ORDER-1/AC-2=uncovered', 'ORDER-2/AC-1=uncovered']);
});

test('a malformed covers contributes nothing and never throws', () => {
  for (const covers of ['ORDER-1/AC-1', null, 5, { a: 1 }, true]) {
    const cov = requirementCoverage(doc([['X-001', covers]], REQS), { 'X-001': A }, { 'X-001': 'pass' }, DEFAULT_STATUSES);
    assert.equal(cov.uncovered, 3, JSON.stringify(covers));
  }
  const mixed = requirementCoverage(doc([['X-001', [5, null, 'ORDER-1/AC-1', ['ORDER-1/AC-2']]]], REQS), { 'X-001': A }, { 'X-001': 'pass' }, DEFAULT_STATUSES);
  assert.deepEqual(states(mixed), ['ORDER-1/AC-1=proved', 'ORDER-1/AC-2=uncovered', 'ORDER-2/AC-1=uncovered']);
  const odd = { requirements: REQS, cases: [null, 7, { covers: ['ORDER-1/AC-1'] }, { id: 3, covers: ['ORDER-1/AC-1'] }, { id: 'X-001', covers: ['ORDER-1/AC-2'] }] };
  assert.deepEqual(states(requirementCoverage(odd, {}, {}, DEFAULT_STATUSES)), ['ORDER-1/AC-1=uncovered', 'ORDER-1/AC-2=unproved', 'ORDER-2/AC-1=uncovered']);
  assert.equal(requirementCoverage({ requirements: REQS, cases: 'x' }, {}, {}, DEFAULT_STATUSES).uncovered, 3);
});

// --- the partition output --------------------------------------------------------------

const PASSING = { 'X-001': 'pass' };
const part = (d, opts = {}) => partitionCases(d.cases, { 'X-001': A }, { verdicts: PASSING, doc: d, ...opts });

test('the output gains requirements next to confidence only when the doc declares a valid block', () => {
  const out = part(doc([['X-001', ['ORDER-1/AC-1']]], REQS));
  assert.equal(out.requirements.proved, 1);
  const keys = Object.keys(out);
  assert.equal(keys[keys.indexOf('confidence') + 1], 'requirements');
  assert.deepEqual(out.warnings, []);
});

test('without requirements the output is unchanged: no key, no warning', () => {
  const d = doc([['X-001']]);
  const withDoc = part(d);
  const without = partitionCases(d.cases, { 'X-001': A }, { verdicts: PASSING });
  assert.ok(!('requirements' in withDoc));
  assert.deepEqual(withDoc, without);
});

test('a malformed block omits coverage and adds the warning', () => {
  const out = part(doc([['X-001']], []));
  assert.ok(!('requirements' in out));
  assert.deepEqual(out.warnings, [OMITTED]);
});

test('a covers error alone does not omit coverage or warn', () => {
  const out = part(doc([['X-001', ['ORDER-9/AC-9']]], REQS));
  assert.ok('requirements' in out);
  assert.deepEqual(out.warnings, []);
});

test('coverage does not change the confidence score or readiness', () => {
  const d = doc([['X-001', ['ORDER-1/AC-1']]], REQS);
  const { requirements, ...withReqs } = part(d);
  const without = partitionCases(d.cases, { 'X-001': A }, { verdicts: PASSING });
  assert.ok(requirements);
  assert.deepEqual(withReqs, without);
});

// --- the CLI ---------------------------------------------------------------------------

const YAML_CASES = (extra) => `${extra}cases:
  - id: X-001
    priority: P1
    covers: [ORDER-1/AC-1]
`;
const YAML_REQS = `requirements:
  - id: ORDER-1
    title: ${TITLE}
    criteria:
      - id: AC-1
        text: ${TEXT}
`;
function cli(yaml, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-reqcov-'));
  writeFileSync(join(dir, 'cases.yaml'), yaml);
  writeFileSync(join(dir, 'statuses.json'), JSON.stringify({ 'X-001': 'Approved' }));
  writeFileSync(join(dir, 'verdicts.json'), JSON.stringify({ 'X-001': 'pass' }));
  const r = spawnSync(process.execPath, [CASE_STATUS, '--cases', join(dir, 'cases.yaml'), '--statuses', join(dir, 'statuses.json'),
    '--verdicts', join(dir, 'verdicts.json'), ...extraArgs], { encoding: 'utf8' });
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
}

test('the CLI prints requirements, and the malformed warning on stderr', () => {
  const ok = cli(YAML_CASES(YAML_REQS));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.requirements.proved, 1);
  const bad = cli(YAML_CASES('requirements: []\n'));
  assert.ok(!('requirements' in bad.json));
  assert.ok(bad.stderr.includes(`warning: ${OMITTED}`));
  const none = cli(YAML_CASES('').replace('    covers: [ORDER-1/AC-1]\n', ''));
  assert.ok(!('requirements' in none.json));
  assert.ok(!none.stderr.includes('requirement'));
});

test('--transitions output never carries requirements', () => {
  const t = cli(YAML_CASES(YAML_REQS), ['--transitions']);
  assert.equal(t.status, 0, t.stderr);
  assert.deepEqual(Object.keys(t.json).sort(), ['approved_ledger', 'transitions']);
});

// --- the run summary -------------------------------------------------------------------

const SHA = 'd'.repeat(64);
function profileWith(edit) {
  const raw = parse(readFileSync(PROFILE_PATH, 'utf8'));
  edit(raw);
  const { profile, errors } = validateProfile(raw);
  assert.deepEqual(errors, []);
  return profile;
}
const QA = loadProfile(PROFILE_PATH).profile;
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
function report(env) {
  const r = JSON.parse(readFileSync(resolve(FIXTURES, 'testing/checkout/sample-report.json'), 'utf8'));
  r.env_name = env;
  r.env_kind = env;
  for (const c of r.cases) c.trace_sha256 = c.trace ? SHA : null;
  return r;
}
const TRANSITIONS = { transitions: [], approved_ledger: {} };
const CONF = { score: 0.4, ready: false, label: 'Not Ready', why: 'at least one P0 case is not an approved pass' };
const REQUIREMENTS = {
  criteria_total: 4, proved: 1, failing: 1, unproved: 1, uncovered: 1,
  by_requirement: [
    { id: 'ORDER-1', criteria: [
      { id: 'AC-1', state: 'proved', cases: ['X-001'] }, { id: 'AC-2', state: 'failing', cases: ['X-002'] },
      { id: 'AC-3', state: 'unproved', cases: ['X-003'] },
    ] },
    { id: 'ORDER-2', criteria: [{ id: 'AC-1', state: 'uncovered', cases: [] }] },
    { id: 'ORDER-3', criteria: [{ id: 'AC-1', state: 'proved', cases: ['X-004'] }] },
    { id: 'ORDER-4', criteria: [{ id: 'AC-1', state: 'unproved', cases: ['X-005'] }] },
  ],
};
const EXPECTED = { criteria_total: 4, proved: 1, failing: 1, unproved: 1, uncovered: 1, not_proved: ['ORDER-1', 'ORDER-2', 'ORDER-4'] };
const build = (r, profile, confidence) => buildPayload(r, profile, { transitions: TRANSITIONS, confidence });

test('requirement_coverage reaches the summary in tracker, local and none modes', () => {
  const full = { confidence: CONF, requirements: REQUIREMENTS };
  const tracker = build(report('qa'), QA, full);
  const local = build(report('production'), PROD, full);
  const none = build(report('qa'), NONE, full);
  assert.deepEqual([tracker.mode, local.mode, none.mode], ['tracker', 'local', 'none']);
  for (const p of [tracker, local, none]) assert.deepEqual(p.summary.requirement_coverage, EXPECTED, p.mode);
});

test('not_proved lists every requirement with a criterion not proved, in declaration order', () => {
  const only = { by_requirement: [
    { id: 'B', criteria: [{ id: '1', state: 'proved', cases: [] }, { id: '2', state: 'unproved', cases: [] }] },
    { id: 'A', criteria: [{ id: '1', state: 'proved', cases: [] }] },
    { id: 'C', criteria: [{ id: '1', state: 'failing', cases: [] }] },
  ], criteria_total: 4, proved: 2, failing: 1, unproved: 1, uncovered: 0 };
  const p = build(report('qa'), QA, { confidence: CONF, requirements: only });
  assert.deepEqual(p.summary.requirement_coverage.not_proved, ['B', 'C']);
  const allProved = { ...only, by_requirement: [only.by_requirement[1]] };
  assert.deepEqual(build(report('qa'), QA, { confidence: CONF, requirements: allProved }).summary.requirement_coverage.not_proved, []);
});

test('without requirements the summary has no requirement_coverage key, in any mode or input shape', () => {
  for (const [r, profile] of [[report('qa'), QA], [report('production'), PROD], [report('qa'), NONE]]) {
    for (const confidence of [{ confidence: CONF }, CONF]) {
      assert.ok(!('requirement_coverage' in build(r, profile, confidence).summary));
    }
  }
});

test('the local summary key set gains only requirement_coverage', () => {
  const keys = (c) => Object.keys(build(report('production'), PROD, c).summary).sort();
  assert.deepEqual(keys({ confidence: CONF, requirements: REQUIREMENTS }), [...keys({ confidence: CONF }), 'requirement_coverage'].sort());
});

test('no criterion text, title or case id reaches the summary', () => {
  const real = requirementCoverage(
    doc([['X-001', ['ORDER-1/AC-1']]], REQS), { 'X-001': A }, { 'X-001': 'pass' }, DEFAULT_STATUSES,
  );
  for (const [r, profile] of [[report('qa'), QA], [report('production'), PROD], [report('qa'), NONE]]) {
    const text = JSON.stringify(build(r, profile, { confidence: CONF, requirements: real }).summary);
    for (const leak of [TITLE, TEXT, 'X-001', 'by_requirement', 'state']) assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
});

test('a requirements object without by_requirement is refused rather than summarised wrongly', () => {
  assert.throws(() => build(report('qa'), QA, { confidence: CONF, requirements: { proved: 1 } }), /by_requirement/);
});
