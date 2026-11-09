import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const PROFILE = join(FIXTURES, 'qa-pilot.config.yaml');
const PUBLISH = resolve(HERE, '../publish.mjs');
const RUN_ID = '20261109T100000Z-checkout-a1b2c3d';
// 001 was approved on hash h1 ("accepted"); 002 is newly approved for execution.
const READY = { 'CHECKOUT-ORDER-001': 'accepted', 'CHECKOUT-ORDER-002': 'ready to run' };

/** A feature directory holding one finished, unrestricted qa run of two passing cases. */
function feature() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-publish-'));
  copyFileSync(join(FIXTURES, 'testing/checkout/cases.yaml'), join(dir, 'cases.yaml'));
  copyFileSync(join(FIXTURES, 'testing/checkout/clickup-map.json'), join(dir, 'clickup-map.json'));
  const run = join(dir, 'runs', RUN_ID);
  const specs = Object.keys(READY).map((id, i) => {
    const t = join(run, 'test-results', `c${i}`, 'trace.zip');
    mkdirSync(dirname(t), { recursive: true });
    writeFileSync(t, `trace ${id}`);
    return { title: `${id} works`, tests: [{ results: [{ status: 'passed', duration: 5, attachments: [{ name: 'trace', path: t, contentType: 'application/zip' }] }] }] };
  });
  writeFileSync(join(run, 'results.json'), JSON.stringify({ suites: [{ specs }] }));
  writeFileSync(join(run, 'meta.json'), JSON.stringify({
    run_id: RUN_ID, run_kind: 'verdict', feature: 'checkout', app: 'storefront', env_name: 'qa', env_kind: 'qa',
    env_url: 'https://qa.host-fake.example.com', api_mode: 'server', sha_before: 'a1b2c3d', sha_after: 'a1b2c3d',
    sha_source: 'https://qa.host-fake.example.com/api/version', sha_format: 'commit', evidence_capture: 'always',
    mutation_policy: 'unrestricted', mutation_prefix: null, executor: 'tester', model_version: 'claude-fable-5',
  }));
  writeFileSync(join(run, 'spec-shas.json'), JSON.stringify({ 'CHECKOUT-ORDER-001': 'h1', 'CHECKOUT-ORDER-002': 'h2' }));
  writeFileSync(join(run, 'statuses.json'), JSON.stringify(READY));
  writeFileSync(join(dir, 'current.json'), JSON.stringify(READY));
  writeFileSync(join(dir, 'approved.json'), JSON.stringify({ 'CHECKOUT-ORDER-001': 'h1' }));
  return { dir, run };
}

const publish = ({ dir, run }) => spawnSync(process.execPath, [PUBLISH, run, '--feature-dir', dir, '--profile', PROFILE,
  '--statuses', join(dir, 'current.json')], { encoding: 'utf8' });

test('a clean run publishes in one command, writing every step\'s file and the ledger last', () => {
  const f = feature();
  const r = publish(f);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(f.run, 'payload.json'), 'utf8')), payload);
  for (const file of ['report.json', 'transitions.json', 'confidence.json']) assert.ok(existsSync(join(f.run, file)), file);
  assert.ok(existsSync(join(f.dir, 'verdicts', `${RUN_ID}.json`)));
  // 001 passed again on its approved hash, so it keeps its approval; 002 was never approved.
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'approved.json'), 'utf8')), { 'CHECKOUT-ORDER-001': 'h1' });
  rmSync(f.dir, { recursive: true, force: true });
});

test('a refused run publishes nothing and leaves the ledger untouched', () => {
  const f = feature();
  rmSync(join(f.run, 'test-results', 'c1', 'trace.zip'));
  const r = publish(f);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /REFUSED\. This report cannot be published/);
  assert.match(r.stderr, /REFUSED: publish stopped at validate-report/);
  for (const file of ['transitions.json', 'confidence.json', 'payload.json']) assert.ok(!existsSync(join(f.run, file)), file);
  assert.ok(!existsSync(join(f.dir, 'verdicts')));
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'approved.json'), 'utf8')), { 'CHECKOUT-ORDER-001': 'h1' });
  rmSync(f.dir, { recursive: true, force: true });
});

test('a run directory missing its approvals is refused before anything runs', () => {
  const f = feature();
  rmSync(join(f.run, 'statuses.json'));
  const r = publish(f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED: missing .*statuses\.json/);
  assert.ok(!existsSync(join(f.run, 'report.json')));
  rmSync(f.dir, { recursive: true, force: true });
});

test('missing arguments are a usage error', () => {
  const r = spawnSync(process.execPath, [PUBLISH, '--profile', PROFILE], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node publish\.mjs/);
});
