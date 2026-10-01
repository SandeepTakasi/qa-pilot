import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile, validateProfile } from '../lib/profile.mjs';
import { buildReport, artifactPaths } from '../parse-report.mjs';
import { validateReport } from '../validate-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const PROFILE_PATH = resolve(FIXTURES, 'qa-pilot.config.yaml');
const GATE = resolve(HERE, '../validate-report.mjs');
const { profile: QA_PROFILE } = loadProfile(PROFILE_PATH);
const goldenCases = () => parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const has = (list, re) => list.some((m) => re.test(m));
const rules = (list, n) => list.filter((m) => m.startsWith(`rule ${n}: `));

// The host-fake profile plus a production environment, normalized by the real loader.
const PROD_SIGNATURES = 2;
function productionProfile({ capture = 'always' } = {}) {
  const raw = parse(readFileSync(PROFILE_PATH, 'utf8'));
  raw.environments.production = {
    kind: 'production',
    apps: { storefront: 'https://app.host-fake.example.com' },
    sha_source: { url: 'https://app.host-fake.example.com/api/version', json_path: 'build.commit' },
  };
  raw.evidence.capture = capture;
  raw.mutation = { write_signatures: [{ method: 'POST', url: '/graphql$', body: 'mutation' }, { method: 'DELETE', url: '/api/' }] };
  const { profile, errors } = validateProfile(raw);
  assert.deepEqual(errors, []);
  return profile;
}

const ENV_URL = { qa: 'https://qa.host-fake.example.com', staging: 'https://staging.host-fake.example.com', production: 'https://app.host-fake.example.com' };
const record = (o = {}) => ({ installed: true, policy: 'read-only', prefix: null, scope_urls: [],
  write_signatures: 0, routed_requests: 5, blocked: 0, observed: 0, events: [], ...o });
const events = (action, n) => Array.from({ length: n }, (_, i) => ({ kind: 'request', action, reason: 'test', method: 'POST', url: `/x/${i}`, at: '2026-10-01T00:00:00Z' }));

/**
 * Build a real run directory: per attempt a trace and the guard's writes.json, a copy of
 * the record where Playwright would put an attachment, results.json, meta.json, and the
 * report.json parse-report would produce. `entities` are { title, attempts: [{ status,
 * writes: object | null }] }; `copy: false` attaches the originals instead of copies.
 */
function makeRun({ env = 'qa', policy = 'read-only', prefix = null, entities, copy = true, metaExtra = {} }) {
  const run = mkdtempSync(join(tmpdir(), 'qa-pilot-gate-'));
  const specs = entities.map((e, si) => ({
    title: e.title,
    tests: [{
      results: e.attempts.map((a, ai) => {
        const dir = join(run, 'test-results', `s${si}-a${ai}`);
        mkdirSync(join(dir, 'attachments'), { recursive: true });
        const attachments = [];
        if (a.status !== 'skipped' || a.trace) {
          writeFileSync(join(dir, 'trace.zip'), `trace ${si} ${ai}`);
          attachments.push({ name: 'trace', path: join(dir, 'trace.zip'), contentType: 'application/zip' });
        }
        if (a.writes) {
          const body = JSON.stringify(a.writes);
          writeFileSync(join(dir, 'writes.json'), body);
          let path = join(dir, 'writes.json');
          if (copy) { path = join(dir, 'attachments', `writes-${ai}.json`); writeFileSync(path, body); }
          attachments.push({ name: 'writes.json', path, contentType: 'application/json' });
        }
        return { status: a.status, duration: 5, attachments, ...(a.status === 'failed' ? { error: { message: 'boom' } } : {}) };
      }),
    }],
  }));
  const pw = { suites: [{ specs }] };
  writeFileSync(join(run, 'results.json'), JSON.stringify(pw));
  const meta = {
    run_id: 'r1', feature: 'checkout', app: 'storefront', env_name: env, env_url: ENV_URL[env],
    env_kind: env === 'production' ? 'production' : env, api_mode: 'server',
    sha_before: 'a1', sha_after: 'a1', sha_source: `${ENV_URL[env]}/api/version`, sha_format: 'commit',
    evidence_capture: 'always', executor: 'tester', model_version: 'claude-fable-5',
    mutation_policy: policy, mutation_prefix: prefix, ...metaExtra,
  };
  writeFileSync(join(run, 'meta.json'), JSON.stringify(meta));
  const report = rebuild(run, pw, meta);
  return { run, pw, meta, report };
}

function rebuild(run, pw, meta) {
  const { traces, writes } = artifactPaths(pw);
  const traceHashes = Object.fromEntries(traces.map((t) => [t, sha256(readFileSync(t))]));
  const writesFiles = Object.fromEntries(writes.map((w) => [w, JSON.parse(readFileSync(w, 'utf8'))]));
  return buildReport(pw, meta, { runDir: run, traceHashes, writesFiles });
}

function casesFile({ policy = 'read-only', prefix, fixtures, caseFixture } = {}) {
  const d = goldenCases();
  if (policy !== 'unrestricted' || prefix) d.mutation = { policy, ...(prefix ? { prefix } : {}) };
  if (fixtures) d.fixtures = fixtures;
  if (caseFixture) for (const [id, f] of Object.entries(caseFixture)) d.cases.find((c) => c.id === id).fixture = f;
  return d;
}

const gate = ({ run, report }, profile, casesDoc) => validateReport(report, profile, { base: run, casesDoc });
const one = (title, writes, status = 'passed') => ({ title, attempts: [{ status, writes }] });
const RO = (o) => record({ policy: 'read-only', ...o });
const SW = (o) => record({ policy: 'scoped-write', prefix: 'QA_T_', ...o });

// --- runs that must publish ---------------------------------------------------------

test('a clean read-only run on qa is accepted', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO()), one('CHECKOUT-ORDER-002 b', RO())] });
  assert.deepEqual(gate(r, QA_PROFILE, casesFile()).errors, []);
});

test('a scoped-write run with observed writes and nothing blocked is accepted', () => {
  const r = makeRun({ policy: 'scoped-write', prefix: 'QA_T_',
    entities: [one('CHECKOUT-ORDER-001 a', SW({ observed: 2, events: events('observe', 2) }))] });
  assert.deepEqual(gate(r, QA_PROFILE, casesFile({ policy: 'scoped-write', prefix: 'QA_T_' })).errors, []);
});

test('an unrestricted qa run with no guard at all is accepted, as in 0.2.0', () => {
  const r = makeRun({ policy: 'unrestricted', entities: [one('CHECKOUT-ORDER-001 a', null)] });
  assert.deepEqual(gate(r, QA_PROFILE, casesFile({ policy: 'unrestricted' })).errors, []);
});

test('a clean read-only production run is accepted', () => {
  const r = makeRun({ env: 'production', entities: [one('CHECKOUT-ORDER-001 a', RO({ write_signatures: PROD_SIGNATURES }))] });
  assert.deepEqual(gate(r, productionProfile(), casesFile()).errors, []);
});

test('attachments that were not copied (paths name the originals) are accepted too', () => {
  const r = makeRun({ copy: false, entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  assert.deepEqual(gate(r, QA_PROFILE, casesFile()).errors, []);
});

test('a fixture identity file named writes.json under fixtures/ is not mistaken for a guard record', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  mkdirSync(join(r.run, 'fixtures'), { recursive: true });
  writeFileSync(join(r.run, 'fixtures', 'writes.json'), '{"id":"p-1"}');
  assert.deepEqual(gate(r, QA_PROFILE, casesFile()).errors, []);
});

// --- environment and capture, from the profile ----------------------------------------

test('a report with no env_kind is refused', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  r.report.env_kind = null;
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^env_kind: missing; re-run with 0\.3\.0/));
});

test('a report whose env_kind disagrees with the profile is refused', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  r.report.env_kind = 'staging';
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^env_kind: .*staging.*qa/));
});

test('a production report claiming on-failure capture is refused', () => {
  const r = makeRun({ env: 'production', entities: [one('CHECKOUT-ORDER-001 a', RO({ write_signatures: PROD_SIGNATURES }))] });
  r.report.evidence_capture = 'on-failure';
  assert.ok(has(gate(r, productionProfile(), casesFile()).errors, /^evidence_capture: .*always.*production/));
});

// --- rule 1: the declaration -------------------------------------------------------------

test('rule 1: a production report checked without a cases file is refused', () => {
  const r = makeRun({ env: 'production', entities: [one('CHECKOUT-ORDER-001 a', RO({ write_signatures: PROD_SIGNATURES }))] });
  assert.ok(has(validateReport(r.report, productionProfile(), { base: r.run }).errors, /^rule 1: --cases is required/));
});

test('rule 1: the CLI refuses without --cases on any environment', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  writeFileSync(join(r.run, 'report.json'), JSON.stringify(r.report));
  writeFileSync(join(r.run, 'statuses.json'), JSON.stringify({ 'CHECKOUT-ORDER-001': 'ready to run' }));
  const p = spawnSync('node', [GATE, join(r.run, 'report.json'), '--profile', PROFILE_PATH,
    '--statuses', join(r.run, 'statuses.json')], { encoding: 'utf8' });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /rule 1: --cases is required/);
});

test('rule 1: the CLI accepts a clean run when --cases is given', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  const casesPath = join(r.run, 'cases.yaml');
  writeFileSync(casesPath, readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8') + '\nmutation:\n  policy: read-only\n');
  writeFileSync(join(r.run, 'report.json'), JSON.stringify(r.report));
  writeFileSync(join(r.run, 'statuses.json'), JSON.stringify({ 'CHECKOUT-ORDER-001': 'ready to run' }));
  const p = spawnSync('node', [GATE, join(r.run, 'report.json'), '--profile', PROFILE_PATH,
    '--statuses', join(r.run, 'statuses.json'), '--cases', casesPath], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
});

test('rule 1: a cases file for another feature, or one that fails the lint, is refused', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  const other = casesFile(); other.feature = 'payments';
  assert.ok(has(gate(r, QA_PROFILE, other).errors, /^rule 1: .*feature "payments".*"checkout"/));
  const bad = casesFile({ policy: 'scoped-write' });
  assert.ok(has(gate(r, QA_PROFILE, bad).errors, /^rule 1: .*mutation\.prefix: required/));
});

test('rule 1: the report policy must equal the declared one, and null never equals', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  r.report.mutation_policy = 'unrestricted';
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 1: report mutation_policy "unrestricted".*"read-only"/));
  r.report.mutation_policy = null;
  assert.ok(rules(gate(r, QA_PROFILE, casesFile()).errors, 1).length > 0, 'a 0.2.0 report has no policy');
});

test('rule 1: the report prefix must equal the declared prefix', () => {
  const r = makeRun({ policy: 'scoped-write', prefix: 'QA_OTHER_', entities: [one('CHECKOUT-ORDER-001 a', SW({ prefix: 'QA_OTHER_' }))] });
  assert.ok(has(gate(r, QA_PROFILE, casesFile({ policy: 'scoped-write', prefix: 'QA_T_' })).errors, /^rule 1: .*prefix/));
});

test('rule 1: a guard record that enforced a different policy is refused', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', record({ policy: 'unrestricted' }))] });
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 1: cases\[CHECKOUT-ORDER-001\]\.writes .*"unrestricted"/));
});

test('rule 1: an unrestricted feature is refused on production', () => {
  const r = makeRun({ env: 'production', policy: 'unrestricted', entities: [one('CHECKOUT-ORDER-001 a', record({ policy: 'unrestricted', write_signatures: 2 }))] });
  assert.ok(has(gate(r, productionProfile(), casesFile({ policy: 'unrestricted' })).errors, /^rule 1: .*unrestricted.*production/));
});

// --- rule 1b: the record on disk ----------------------------------------------------------

test('rule 1b: a report whose write counts were edited is refused', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO({ blocked: 2, events: events('block', 2) }))] });
  r.report.cases[0].writes.blocked = 0;
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 1b: cases\[CHECKOUT-ORDER-001\]\.writes does not match/));
});

test('rule 1b: an attempt dropped from the report and results.json cannot hide its record', () => {
  const r = makeRun({ entities: [{ title: 'CHECKOUT-ORDER-001 a', attempts: [
    { status: 'failed', writes: RO({ blocked: 1, events: events('block', 1) }) }, { status: 'passed', writes: RO() }] }] });
  // Forge both files without the first attempt; its original writes.json stays on disk.
  const pw = JSON.parse(readFileSync(join(r.run, 'results.json'), 'utf8'));
  pw.suites[0].specs[0].tests[0].results.shift();
  writeFileSync(join(r.run, 'results.json'), JSON.stringify(pw));
  const forged = { ...r, report: rebuild(r.run, pw, r.meta) };
  assert.ok(has(gate(forged, QA_PROFILE, casesFile()).errors, /^rule 1b: .*s0-a0\/writes\.json.*no listed record/));
});

test('rule 1b: results.json must be in the run directory', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  rmSync(join(r.run, 'results.json'));
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 1b: .*results\.json/));
});

test('rule 1b: a record path outside the run directory is refused', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  r.report.cases[0].writes.paths = ['../elsewhere/writes.json'];
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 1b: .*"\.\.\/elsewhere\/writes\.json" .*inside the run directory/));
});

test('rule 1b: a record whose counts disagree with its events reads as not installed', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO({ blocked: 0, events: events('block', 1) }))] });
  const errs = gate(r, QA_PROFILE, casesFile()).errors;
  assert.ok(rules(errs, '1b').length + rules(errs, 2).length > 0, errs.join('\n'));
});

test('rule 1b: retries recomputed from results.json must match the report', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  r.report.cases[0].retries = 3;
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 1b: cases\[CHECKOUT-ORDER-001\]\.retries/));
});

// --- rule 2: the guard was live ------------------------------------------------------------

test('rule 2: an executed read-only case with no guard record is refused', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', null)] });
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 2: cases\[CHECKOUT-ORDER-001\]: no write record/));
});

test('rule 2: a guard that never reported in, or routed nothing, is refused', () => {
  const a = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO({ installed: false }))] });
  assert.ok(has(gate(a, QA_PROFILE, casesFile()).errors, /^rule 2: .*not installed/));
  const b = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO({ routed_requests: 0 }))] });
  assert.ok(has(gate(b, QA_PROFILE, casesFile()).errors, /^rule 2: .*routed no requests/));
});

test('rule 2: one attempt whose route never ran is refused even if a sibling routed plenty', () => {
  const r = makeRun({ entities: [{ title: 'CHECKOUT-ORDER-001 a', attempts: [
    { status: 'failed', writes: RO({ routed_requests: 0 }) }, { status: 'passed', writes: RO({ routed_requests: 40 }) }] }] });
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 2: .*s0-a0.*routed no requests/));
});

test('rule 2: a scoped-write run with no guard is refused off production too', () => {
  const r = makeRun({ env: 'staging', policy: 'scoped-write', prefix: 'QA_T_', entities: [one('CHECKOUT-ORDER-001 a', null)] });
  assert.ok(has(gate(r, QA_PROFILE, casesFile({ policy: 'scoped-write', prefix: 'QA_T_' })).errors, /^rule 2: /));
});

test('rule 2: a guard that did not load the host\'s write signatures is refused', () => {
  const r = makeRun({ env: 'production', entities: [one('CHECKOUT-ORDER-001 a', RO({ write_signatures: 0 }))] });
  assert.ok(has(gate(r, productionProfile(), casesFile()).errors, /^rule 2: .*write_signatures 0.*2/));
});

test('rule 2: a blocked case is not required to carry a record', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO()), one('CHECKOUT-ORDER-002 b', null, 'skipped')] });
  assert.deepEqual(rules(gate(r, QA_PROFILE, casesFile()).errors, 2), []);
});

// --- rules 3 and 4: what the run recorded ---------------------------------------------------

test('rule 3: a read-only run that recorded writes is refused, naming the count', () => {
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO({ blocked: 2, events: events('block', 2) }))] });
  assert.ok(has(gate(r, QA_PROFILE, casesFile()).errors, /^rule 3: read-only run recorded 2 write\(s\)/));
});

test('rule 4: a scoped-write run that blocked a write is refused', () => {
  const r = makeRun({ policy: 'scoped-write', prefix: 'QA_T_', entities: [one('CHECKOUT-ORDER-001 a', SW({ blocked: 1, events: events('block', 1) }))] });
  assert.ok(has(gate(r, QA_PROFILE, casesFile({ policy: 'scoped-write', prefix: 'QA_T_' })).errors, /^rule 4: /));
});

// --- rule 5: fixtures -------------------------------------------------------------------

const FX = [{ name: 'shared', teardown: 'delete' }];
const fxCases = (fixtures = FX) => casesFile({ policy: 'scoped-write', prefix: 'QA_T_', fixtures, caseFixture: { 'CHECKOUT-ORDER-001': fixtures[0].name } });
const fxRun = (entities) => makeRun({ policy: 'scoped-write', prefix: 'QA_T_', entities });

test('rule 5: a consistent fixture run is accepted', () => {
  const r = fxRun([one('FIXTURE shared', SW()), one('CHECKOUT-ORDER-001 a', SW()), one('FIXTURE shared teardown', SW())]);
  const { errors, warnings } = gate(r, QA_PROFILE, fxCases());
  assert.deepEqual(errors, []);
  assert.ok(!has(warnings, /left behind/));
});

test('rule 5: a fixture the cases file never declared is refused', () => {
  const r = fxRun([one('FIXTURE stray', SW()), one('CHECKOUT-ORDER-001 a', SW())]);
  assert.ok(has(gate(r, QA_PROFILE, casesFile({ policy: 'scoped-write', prefix: 'QA_T_' })).errors, /^rule 5: .*"stray" is not declared/));
});

test('rule 5: duplicate entries and a teardown for a keep fixture are refused', () => {
  const dup = fxRun([one('FIXTURE shared', SW()), one('FIXTURE shared', SW()), one('CHECKOUT-ORDER-001 a', SW())]);
  assert.ok(has(gate(dup, QA_PROFILE, fxCases()).errors, /^rule 5: .*"shared" setup appears twice/));
  const keep = fxRun([one('FIXTURE shared', SW()), one('CHECKOUT-ORDER-001 a', SW()), one('FIXTURE shared teardown', SW())]);
  assert.ok(has(gate(keep, QA_PROFILE, fxCases([{ name: 'shared', teardown: 'keep' }])).errors, /^rule 5: .*teardown.*keep/));
});

test('rule 5: an executed case naming a fixture whose setup never ran is refused', () => {
  const r = fxRun([one('CHECKOUT-ORDER-001 a', SW())]);
  assert.ok(has(gate(r, QA_PROFILE, fxCases()).errors, /^rule 5: .*"shared" has no setup/));
});

test('rule 5: a failed setup with a dependent that still carries a verdict is refused', () => {
  const r = fxRun([one('FIXTURE shared', SW(), 'failed'), one('CHECKOUT-ORDER-001 a', SW())]);
  assert.ok(has(gate(r, QA_PROFILE, fxCases()).errors, /^rule 5: cases\[CHECKOUT-ORDER-001\].*must be blocked/));
  const ok = fxRun([one('FIXTURE shared', SW(), 'failed'), one('CHECKOUT-ORDER-001 a', null, 'skipped')]);
  assert.deepEqual(rules(gate(ok, QA_PROFILE, fxCases()).errors, 5), []);
});

test('rule 5: a delete fixture whose teardown failed or never ran is a warning naming it', () => {
  const failed = fxRun([one('FIXTURE shared', SW()), one('CHECKOUT-ORDER-001 a', SW()), one('FIXTURE shared teardown', SW(), 'failed')]);
  const a = gate(failed, QA_PROFILE, fxCases());
  assert.deepEqual(rules(a.errors, 5), []);
  assert.ok(has(a.warnings, /"shared".*qa.*left behind/), a.warnings.join('\n'));
  const missing = fxRun([one('FIXTURE shared', SW()), one('CHECKOUT-ORDER-001 a', SW())]);
  assert.ok(has(gate(missing, QA_PROFILE, fxCases()).warnings, /"shared".*left behind/));
});

test('a passing fixture without a trace is refused like a case would be', () => {
  const r = fxRun([one('FIXTURE shared', SW()), one('CHECKOUT-ORDER-001 a', SW()), one('FIXTURE shared teardown', SW())]);
  r.report.fixtures[0].trace = null;
  assert.ok(has(gate(r, QA_PROFILE, fxCases()).errors, /^fixtures\[shared setup\]\.trace: required/));
});

// --- rule 6: local evidence is pinned -----------------------------------------------------

test('rule 6: on production every trace needs its sha256', () => {
  const r = makeRun({ env: 'production', entities: [one('CHECKOUT-ORDER-001 a', RO({ write_signatures: PROD_SIGNATURES }))] });
  r.report.cases[0].trace_sha256 = null;
  assert.ok(has(gate(r, productionProfile(), casesFile()).errors, /^rule 6: cases\[CHECKOUT-ORDER-001\]\.trace_sha256: required/));
});

test('rule 6: a trace changed after the run is refused', () => {
  const r = makeRun({ env: 'production', entities: [one('CHECKOUT-ORDER-001 a', RO({ write_signatures: PROD_SIGNATURES }))] });
  writeFileSync(join(r.run, r.report.cases[0].trace), 'swapped');
  assert.ok(has(gate(r, productionProfile(), casesFile()).errors, /^rule 6: .*does not match/));
});

test('rule 6: a local trace path must stay inside the run directory', () => {
  const r = makeRun({ env: 'production', entities: [one('CHECKOUT-ORDER-001 a', RO({ write_signatures: PROD_SIGNATURES }))] });
  r.report.cases[0].trace = join(r.run, r.report.cases[0].trace);
  assert.ok(has(gate(r, productionProfile(), casesFile()).errors, /^rule 6: .*inside the run directory/));
});

test('rule 6 applies wherever evidence is local, not only on production', () => {
  const raw = parse(readFileSync(PROFILE_PATH, 'utf8'));
  raw.environments.qa.evidence_upload = 'local';
  const { profile } = validateProfile(raw);
  const r = makeRun({ entities: [one('CHECKOUT-ORDER-001 a', RO())] });
  r.report.cases[0].trace_sha256 = null;
  assert.ok(has(gate(r, profile, casesFile()).errors, /^rule 6: /));
  assert.deepEqual(rules(gate(r, QA_PROFILE, casesFile()).errors, 6), [], 'tracker upload: no pin needed');
});
