// The designed-to-fail case. Takes the real read-only browser run in e2e/.out/read-only/ and
// hands it to the real parse-report and publish gate twice:
//   1. as it is: two specs tried to write, so the gate must REFUSE it, and only under the
//      read-only rule. An accept, or a refusal for any other reason, means the gate is broken.
//   2. as a clean twin, the same run reduced to the specs that wrote nothing: it must be
//      ACCEPTED, which proves the refusal in (1) came from the writes and nothing else.
// It also checks that every attempt's writes.json shows a live guard.
//
// Usage (from fixtures/host-fake): node e2e/refuse-check.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '../../../qa-pilot/scripts');
const PROFILE = resolve(HERE, '../qa-pilot.config.yaml');
const OUT = join(HERE, '.out');
const RUN = join(OUT, 'read-only');
const CLEAN = join(OUT, 'read-only-clean');
const WRITERS = ['GUARD-READONLY-002', 'GUARD-READONLY-003'];
const QUIET = ['GUARD-CLEAN-001', 'GUARD-READONLY-004'];

const fail = (msg) => { console.error(`refuse-check: FAIL: ${msg}`); process.exit(1); };
const node = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8' });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

if (!existsSync(join(RUN, 'results.json'))) fail(`no read-only run at ${RUN}; run the @read-only specs first`);

// The feature's declaration and the approvals it ran under, as run-tests would record them.
// The lint wants the file in a directory named after its feature, as testing/<feature>/ is.
mkdirSync(join(OUT, 'guard'), { recursive: true });
const CASES = join(OUT, 'guard', 'cases.yaml');
const caseEntry = (id, title) => `
  - id: ${id}
    title: ${title}
    priority: P1
    type: happy
    steps:
      - Open the projects page and use the control under test
    expected:
      - The counter or state text named in the spec shows the value the spec asserts`;
writeFileSync(CASES, `feature: guard
model_version: claude-fable-5
generated_at: 2026-10-01T00:00:00Z
mutation:
  policy: read-only
scenario_mix:
  happy: covered
  negative: { n_a: "The guard proof has no failure path of its own to cover" }
  boundary: { n_a: "No limits are involved in a single click" }
  permission: { n_a: "One account; roles are not what is under test" }
  data-validation: { n_a: "No form input is submitted" }
cases:${caseEntry('GUARD-CLEAN-001', 'A page that is only read records no write')}${caseEntry('GUARD-READONLY-002', 'A Delete click is blocked')}${caseEntry('GUARD-READONLY-003', 'A write request is aborted')}${caseEntry('GUARD-READONLY-004', 'Requests that bypass the page are refused')}
`);
const lint = node('validate-cases.mjs', [CASES, '--profile', PROFILE]);
if (lint.status !== 0) fail(`the cases file does not lint:\n${lint.stderr}`);

function prepare(runDir) {
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    run_id: `${new Date().toISOString()}-guard-proof`, feature: 'guard', app: 'storefront',
    env_name: 'qa', env_kind: 'qa', env_url: 'https://qa.host-fake.example.com', api_mode: 'server',
    sha_before: 'a1b2c3d', sha_after: 'a1b2c3d', sha_source: 'https://qa.host-fake.example.com/api/version',
    sha_format: 'commit', evidence_capture: 'always', mutation_policy: 'read-only', mutation_prefix: null,
    executor: 'guard-proof', model_version: 'claude-fable-5',
  }, null, 2));
  writeFileSync(join(runDir, 'statuses.json'), JSON.stringify(
    Object.fromEntries([...WRITERS, ...QUIET].map((id) => [id, 'ready to run']))));
  const parsed = node('parse-report.mjs', [join(runDir, 'results.json'), join(runDir, 'meta.json')]);
  if (parsed.status !== 0) fail(`parse-report failed on ${runDir}:\n${parsed.stderr}`);
  return readJson(join(runDir, 'report.json'));
}
const gate = (runDir) => node('validate-report.mjs', [join(runDir, 'report.json'), '--profile', PROFILE,
  '--statuses', join(runDir, 'statuses.json'), '--cases', CASES]);

// --- 1. the run with writes --------------------------------------------------------------
const report = prepare(RUN);
const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
for (const id of [...WRITERS, ...QUIET]) {
  const c = byId[id];
  if (!c) fail(`${id} is missing from the report`);
  if (c.verdict !== 'pass') fail(`${id} did not pass in the browser (${c.verdict}): ${c.failure_summary ?? ''}`);
  const w = c.writes;
  if (!w) fail(`${id} has no write record: the guard fixture never ran`);
  if (w.installed !== true) fail(`${id}: the guard was not installed (no heartbeat from the page)`);
  if (!(w.routed_requests > 0)) fail(`${id}: the guard's route saw no requests`);
  if (w.policy !== 'read-only') fail(`${id}: the guard enforced ${w.policy}, not read-only`);
}
for (const id of WRITERS) if (!(byId[id].writes.blocked > 0)) fail(`${id}: the guard recorded no blocked write`);
for (const id of QUIET) if (byId[id].writes.blocked + byId[id].writes.observed > 0) fail(`${id}: recorded a write it should not have`);

const refused = gate(RUN);
if (refused.status === 0) fail('the publish gate ACCEPTED a read-only run that recorded writes');
const reasons = refused.stderr.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4));
if (reasons.length === 0) fail(`the gate refused without naming a rule:\n${refused.stderr}`);
const other = reasons.filter((r) => !r.startsWith('rule 3: read-only run recorded'));
if (other.length) fail(`the gate refused for a reason other than the read-only rule:\n  ${other.join('\n  ')}`);
for (const id of WRITERS) {
  if (!reasons.some((r) => r.includes(`cases[${id}]`))) fail(`the read-only refusal does not name ${id}`);
}
console.log(`refused, as designed: ${reasons.length} read-only refusal(s)`);
for (const r of reasons) console.log(`  - ${r}`);

// --- 2. the clean twin --------------------------------------------------------------------
// The same run, reduced to the specs that wrote nothing: their results only, and only their
// output on disk, so the gate's re-read of results.json and its sweep both see a clean run.
rmSync(CLEAN, { recursive: true, force: true });
cpSync(RUN, CLEAN, { recursive: true });
for (const f of ['report.json', 'meta.json', 'statuses.json']) rmSync(join(CLEAN, f), { force: true });
const pw = JSON.parse(readFileSync(join(CLEAN, 'results.json'), 'utf8').split(RUN).join(CLEAN));
const keep = (spec) => QUIET.some((id) => spec.title.startsWith(id));
const dropDirs = new Set();
const walk = (suites) => {
  for (const s of suites ?? []) {
    for (const spec of s.specs ?? []) {
      if (keep(spec)) continue;
      for (const r of spec.tests.flatMap((t) => t.results)) {
        for (const a of r.attachments ?? []) {
          if (!a.path) continue;
          // An attempt's output directory sits directly under test-results/.
          const rel = a.path.slice(join(CLEAN, 'test-results').length + 1).split(/[\\/]/)[0];
          if (rel) dropDirs.add(join(CLEAN, 'test-results', rel));
        }
      }
    }
    s.specs = (s.specs ?? []).filter(keep);
    walk(s.suites);
  }
};
walk(pw.suites);
for (const d of dropDirs) rmSync(d, { recursive: true, force: true });
writeFileSync(join(CLEAN, 'results.json'), JSON.stringify(pw, null, 2));
const twin = prepare(CLEAN);
if (twin.cases.map((c) => c.id).sort().join() !== [...QUIET].sort().join()) fail(`the clean twin holds ${twin.cases.map((c) => c.id)}`);

const accepted = gate(CLEAN);
if (accepted.status !== 0) fail(`the publish gate refused the clean twin:\n${accepted.stderr}`);
console.log(`accepted, as designed: ${accepted.stdout.trim()}`);
console.log('refuse-check: PASS');
