import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildReport, artifactPaths } from '../parse-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARSE = resolve(HERE, '../parse-report.mjs');

// Small hand-built Playwright reports: one suite, specs with one tests[] entry per project,
// each entry's results[] its attempts.
const RUN = '/runs/r1';
const att = (name, path) => ({ name, path, contentType: 'application/octet-stream' });
const res = (status, attachments = [], extra = {}) => ({ status, duration: 5, attachments, ...extra });
const spec = (title, ...entries) => ({ title, tests: entries.map((results) => ({ results })) });
const pw = (...specs) => ({ suites: [{ specs }] });
const META = { run_id: 'r1', feature: 'f', sha_before: 'a', sha_after: 'a' };
const W = (dir) => `${RUN}/test-results/${dir}/writes.json`;
const T = (dir) => `${RUN}/test-results/${dir}/trace.zip`;
const writes = (o = {}) => ({ installed: true, policy: 'scoped-write', prefix: 'QA_T_', scope_urls: [],
  write_signatures: 2, routed_requests: 10, blocked: 0, observed: 1, events: [], ...o });
const build = (report, opts = {}, meta = META) => buildReport(report, meta, { runDir: RUN, ...opts });

// --- fixtures ----------------------------------------------------------------------

test('FIXTURE setup and teardown titles land in fixtures[], not in cases or unmapped', () => {
  const r = build(pw(
    spec('FIXTURE shared-project', [res('passed')]),
    spec('FIXTURE shared-project teardown', [res('passed')]),
    spec('CHECKOUT-ORDER-001 places an order', [res('passed')]),
  ));
  assert.deepEqual(r.fixtures.map((f) => [f.name, f.phase, f.verdict]),
    [['shared-project', 'setup', 'pass'], ['shared-project', 'teardown', 'pass']]);
  assert.deepEqual(r.cases.map((c) => c.id), ['CHECKOUT-ORDER-001']);
  assert.deepEqual(r.unmapped_specs, []);
  assert.deepEqual(r.summary, { pass: 1, fail: 0, flaky: 0, blocked: 0 }, 'fixtures are not counted');
});

test('a FIXTURE title outside the grammar is unmapped, never guessed at', () => {
  const r = build(pw(
    spec('FIXTURE Shared_Project', [res('passed')]),
    spec('FIXTURE p1 cleanup', [res('passed')]),
    spec('FIXTURE', [res('passed')]),
  ));
  assert.deepEqual(r.fixtures, []);
  assert.deepEqual(r.unmapped_specs, ['FIXTURE Shared_Project', 'FIXTURE p1 cleanup', 'FIXTURE']);
});

test('fixture verdicts are derived exactly as case verdicts are', () => {
  const r = build(pw(
    spec('FIXTURE a', [res('failed')]),
    spec('FIXTURE b', [res('skipped')]),
    spec('FIXTURE c', [res('passed')], [res('failed')]),
  ));
  assert.deepEqual(r.fixtures.map((f) => f.verdict), ['fail', 'blocked', 'fail']);
  const moved = build(pw(spec('FIXTURE a', [res('passed')])), {}, { ...META, sha_after: 'b' });
  assert.equal(moved.fixtures[0].verdict, 'blocked', 'a mid-run deploy blocks fixtures too');
});

test('fixtures are sorted by name, setup before teardown', () => {
  const r = build(pw(
    spec('FIXTURE b teardown', [res('passed')]), spec('FIXTURE b', [res('passed')]), spec('FIXTURE a', [res('passed')]),
  ));
  assert.deepEqual(r.fixtures.map((f) => `${f.name}:${f.phase}`), ['a:setup', 'b:setup', 'b:teardown']);
});

// --- trace paths and hashes -----------------------------------------------------------

test('trace paths become relative to the run directory, with / separators', () => {
  const r = build(pw(spec('CHECKOUT-ORDER-001 x', [res('passed', [att('trace', T('o1'))])]),
    spec('FIXTURE p', [res('passed', [att('trace', T('fx'))])])));
  assert.equal(r.cases[0].trace, 'test-results/o1/trace.zip');
  assert.equal(r.fixtures[0].trace, 'test-results/fx/trace.zip');
});

test('without a run directory the trace path is left as Playwright wrote it', () => {
  const r = buildReport(pw(spec('CHECKOUT-ORDER-001 x', [res('passed', [att('trace', T('o1'))])])), META);
  assert.equal(r.cases[0].trace, T('o1'));
});

test('trace_sha256 comes from the injected hashes, keyed by the path Playwright recorded', () => {
  const report = pw(
    spec('CHECKOUT-ORDER-001 x', [res('passed', [att('trace', T('o1'))])]),
    spec('CHECKOUT-ORDER-002 y', [res('passed', [att('trace', T('o2'))])]),
    spec('CHECKOUT-ORDER-003 z', [res('skipped')]),
    spec('FIXTURE p', [res('passed', [att('trace', T('fx'))])]),
  );
  const r = build(report, { traceHashes: { [T('o1')]: 'a'.repeat(64), [T('fx')]: 'f'.repeat(64) } });
  const byId = Object.fromEntries(r.cases.map((c) => [c.id, c]));
  assert.equal(byId['CHECKOUT-ORDER-001'].trace_sha256, 'a'.repeat(64));
  assert.equal(byId['CHECKOUT-ORDER-002'].trace_sha256, null, 'unhashed trace: null');
  assert.equal(byId['CHECKOUT-ORDER-003'].trace_sha256, null, 'no trace: null');
  assert.equal(r.fixtures[0].trace_sha256, 'f'.repeat(64));
});

// --- the write record ----------------------------------------------------------------

test('writes aggregates every attempt: counts summed, paths relative, attempts counted', () => {
  const r = build(pw(spec('CHECKOUT-ORDER-001 x', [
    res('failed', [att('writes.json', W('a0'))]),
    res('passed', [att('writes.json', W('a1'))]),
  ])), { writesFiles: { [W('a0')]: writes({ blocked: 2, observed: 0, routed_requests: 4 }), [W('a1')]: writes() } });
  assert.deepEqual(r.cases[0].writes, {
    attempts: 2,
    paths: ['test-results/a0/writes.json', 'test-results/a1/writes.json'],
    installed: true,
    policy: 'scoped-write',
    prefix: 'QA_T_',
    write_signatures: 2,
    routed_requests: 14,
    blocked: 2,
    observed: 1,
  });
});

test('an attempt with no writes.json makes installed false', () => {
  const r = build(pw(spec('CHECKOUT-ORDER-001 x', [res('failed'), res('passed', [att('writes.json', W('a1'))])])),
    { writesFiles: { [W('a1')]: writes() } });
  assert.equal(r.cases[0].writes.attempts, 2);
  assert.equal(r.cases[0].writes.paths.length, 1);
  assert.equal(r.cases[0].writes.installed, false);
});

test('a skipped result is not an attempt, so a project that skips the case costs nothing', () => {
  const r = build(pw(spec('CHECKOUT-ORDER-001 x', [res('passed', [att('writes.json', W('c'))])], [res('skipped')])),
    { writesFiles: { [W('c')]: writes() } });
  assert.equal(r.cases[0].writes.attempts, 1);
  assert.equal(r.cases[0].writes.installed, true);
});

test('a test skipped at runtime may attach a record: it is summed, but not required', () => {
  // test.skip() inside the body still runs the guard fixture, so the skipped attempt can
  // attach a writes.json, and it may have written before skipping.
  const r = build(pw(spec('CHECKOUT-ORDER-001 x',
    [res('passed', [att('writes.json', W('chromium'))])],
    [res('skipped', [att('writes.json', W('firefox'))])])),
  { writesFiles: { [W('chromium')]: writes(), [W('firefox')]: writes({ installed: false, blocked: 1, observed: 0 }) } });
  assert.equal(r.cases[0].writes.attempts, 1);
  assert.equal(r.cases[0].writes.paths.length, 2);
  assert.equal(r.cases[0].writes.installed, true, 'the attempt that ran was guarded');
  assert.equal(r.cases[0].writes.blocked, 1, 'what the skipped attempt saw still counts');
});

test('an unreadable writes.json reads as not installed and contributes no counts', () => {
  const r = build(pw(spec('CHECKOUT-ORDER-001 x', [res('passed', [att('writes.json', W('a'))])])), { writesFiles: {} });
  assert.equal(r.cases[0].writes.installed, false);
  assert.equal(r.cases[0].writes.routed_requests, 0);
  assert.equal(r.cases[0].writes.policy, null);
});

test('a file with installed absent or false makes installed false', () => {
  const r = build(pw(spec('CHECKOUT-ORDER-001 x', [res('passed', [att('writes.json', W('a'))])])),
    { writesFiles: { [W('a')]: writes({ installed: undefined }) } });
  assert.equal(r.cases[0].writes.installed, false);
});

test('policy and prefix are null when the files disagree; write_signatures is the smallest', () => {
  const r = build(pw(spec('CHECKOUT-ORDER-001 x', [
    res('failed', [att('writes.json', W('a0'))]), res('passed', [att('writes.json', W('a1'))]),
  ])), { writesFiles: { [W('a0')]: writes({ policy: 'read-only', prefix: null, write_signatures: 0 }), [W('a1')]: writes() } });
  assert.equal(r.cases[0].writes.policy, null);
  assert.equal(r.cases[0].writes.prefix, null);
  assert.equal(r.cases[0].writes.write_signatures, 0);
});

test('a case with no writes.json attachment at all has writes: null', () => {
  const r = build(pw(spec('CHECKOUT-ORDER-001 x', [res('passed')])));
  assert.equal(r.cases[0].writes, null);
});

test('fixtures carry their write record too', () => {
  const r = build(pw(spec('FIXTURE p', [res('passed', [att('writes.json', W('fx'))])])), { writesFiles: { [W('fx')]: writes() } });
  assert.equal(r.fixtures[0].writes.observed, 1);
});

// --- run metadata ----------------------------------------------------------------------

test('env_kind and the mutation policy are copied from meta, null when meta lacks them', () => {
  const r = build(pw(), {}, { ...META, env_kind: 'staging', mutation_policy: 'scoped-write', mutation_prefix: 'QA_T_' });
  assert.equal(r.env_kind, 'staging');
  assert.equal(r.mutation_policy, 'scoped-write');
  assert.equal(r.mutation_prefix, 'QA_T_');
  const old = build(pw());
  assert.equal(old.env_kind, null);
  assert.equal(old.mutation_policy, null);
  assert.equal(old.mutation_prefix, null);
  assert.deepEqual(old.fixtures, []);
});

test('artifactPaths lists every trace and writes.json the CLI must read', () => {
  const report = pw(
    spec('CHECKOUT-ORDER-001 x', [res('failed', [att('trace', T('a0')), att('writes.json', W('a0'))]),
      res('passed', [att('trace', T('a1')), att('writes.json', W('a1'))])]),
    spec('FIXTURE p', [res('passed', [att('trace', T('fx'))])]),
  );
  const { traces, writes: w } = artifactPaths(report);
  assert.deepEqual(traces.sort(), [T('a0'), T('a1'), T('fx')].sort());
  assert.deepEqual(w.sort(), [W('a0'), W('a1')].sort());
});

// --- the CLI does the I/O ------------------------------------------------------------------

test('the CLI writes report.json into the run directory, hashing traces and reading write records', () => {
  const run = mkdtempSync(join(tmpdir(), 'qa-pilot-run-'));
  const out = join(run, 'test-results', 'o1');
  mkdirSync(out, { recursive: true });
  const trace = join(out, 'trace.zip');
  const rec = join(out, 'writes.json');
  writeFileSync(trace, 'fake trace bytes');
  writeFileSync(rec, JSON.stringify(writes()));
  writeFileSync(join(run, 'meta.json'), JSON.stringify({ ...META, env_kind: 'qa', mutation_policy: 'scoped-write', mutation_prefix: 'QA_T_' }));
  writeFileSync(join(run, 'results.json'), JSON.stringify(pw(
    spec('CHECKOUT-ORDER-001 x', [res('passed', [att('trace', trace), att('writes.json', rec)])]),
  )));

  const p = spawnSync('node', [PARSE, join(run, 'results.json'), join(run, 'meta.json')], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8'));
  const c = report.cases[0];
  assert.equal(c.trace, 'test-results/o1/trace.zip');
  assert.equal(c.trace_sha256, createHash('sha256').update('fake trace bytes').digest('hex'));
  assert.equal(c.writes.paths[0], 'test-results/o1/writes.json');
  assert.equal(c.writes.installed, true);
  assert.equal(report.env_kind, 'qa');
});

test('the CLI warns and records null when a trace cannot be read', () => {
  const run = mkdtempSync(join(tmpdir(), 'qa-pilot-run-'));
  writeFileSync(join(run, 'meta.json'), JSON.stringify(META));
  writeFileSync(join(run, 'results.json'), JSON.stringify(pw(
    spec('CHECKOUT-ORDER-001 x', [res('passed', [att('trace', join(run, 'missing', 'trace.zip'))])]),
  )));
  const p = spawnSync('node', [PARSE, join(run, 'results.json'), join(run, 'meta.json')], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /cannot hash trace/);
  assert.equal(JSON.parse(readFileSync(join(run, 'report.json'), 'utf8')).cases[0].trace_sha256, null);
});
