import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { recordApprovals } from '../case-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../case-status.mjs');

const report = () => ({
  cases: [
    { id: 'A', verdict: 'pass', spec_sha: 'h1' },
    { id: 'B', verdict: 'fail', spec_sha: 'h2' },
    { id: 'C', verdict: 'pass' },
    { id: 'D', verdict: 'flaky', spec_sha: 'h4' },
  ],
});

// --- recordApprovals: the first ledger entry is written at approval -----------

test('an approved pass records the run spec hash', () => {
  assert.deepEqual(recordApprovals(report(), {}, ['A']), { A: 'h1' });
});

test('an approved pass replaces a stale hash and keeps the others', () => {
  assert.deepEqual(recordApprovals(report(), { A: 'old', Z: 'keep' }, ['A']), { A: 'h1', Z: 'keep' });
});

test('approving a confirmed failure removes the entry instead of recording a baseline', () => {
  assert.deepEqual(recordApprovals(report(), { B: 'old', Z: 'keep' }, ['B']), { Z: 'keep' });
  assert.deepEqual(recordApprovals(report(), { D: 'old' }, ['D']), {});
});

test('it never mutates the ledger it is given', () => {
  const ledger = { B: 'old' };
  const next = recordApprovals(report(), ledger, ['A', 'B']);
  assert.deepEqual(ledger, { B: 'old' });
  assert.notEqual(next, ledger);
});

test('an id absent from the report throws', () => {
  assert.throws(() => recordApprovals(report(), {}, ['Z']), /record-approvals: Z is not in the report/);
});

test('a pass with no spec_sha throws', () => {
  assert.throws(() => recordApprovals(report(), {}, ['C']), /record-approvals: C has no spec_sha in the report/);
});

// --- the CLI -------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'approval-ledger-'));
const reportPath = join(dir, 'report.json');
writeFileSync(reportPath, JSON.stringify(report()));
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('the CLI needs neither --cases nor --statuses and starts a new ledger with a warning', () => {
  const r = cli('--record-approvals', '--verdicts', reportPath, '--approved', join(dir, 'none.json'), '--ids', 'A');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { approved_ledger: { A: 'h1' } });
  assert.match(r.stderr, /warning: no approval ledger at .*none\.json; starting a new one/);
});

test('the CLI extends an existing ledger and trims the id list', () => {
  const ledgerPath = join(dir, 'approved.json');
  writeFileSync(ledgerPath, JSON.stringify({ B: 'old', Z: 'keep' }));
  const r = cli('--record-approvals', '--verdicts', reportPath, '--approved', ledgerPath, '--ids', 'A, B');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { approved_ledger: { A: 'h1', Z: 'keep' } });
  assert.doesNotMatch(r.stderr, /starting a new one/);
});

test('the CLI refuses a missing --verdicts or --ids', () => {
  const noVerdicts = cli('--record-approvals', '--ids', 'A');
  assert.equal(noVerdicts.status, 1);
  assert.match(noVerdicts.stderr, /--record-approvals needs --verdicts <report\.json>/);
  const noIds = cli('--record-approvals', '--verdicts', reportPath);
  assert.equal(noIds.status, 1);
  assert.match(noIds.stderr, /--record-approvals needs --ids <A,B>/);
});

test('the CLI refuses a corrupt ledger instead of replacing it', () => {
  const bad = join(dir, 'corrupt.json');
  writeFileSync(bad, '{ "A": "h1", ');
  const r = cli('--record-approvals', '--verdicts', reportPath, '--approved', bad, '--ids', 'A');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not valid JSON/);
  assert.equal(r.stdout, '');
});

test('the CLI exits 1 on an id that is not in the report', () => {
  const r = cli('--record-approvals', '--verdicts', reportPath, '--ids', 'Z');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /record-approvals: Z is not in the report/);
});
