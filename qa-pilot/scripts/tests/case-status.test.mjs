import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { partitionCases, confidence, STATUS } from '../case-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const cases = parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8')).cases;
const ids = cases.map((c) => c.id);
const allAt = (status) => Object.fromEntries(ids.map((id) => [id, status]));
const execIds = (out) => out.executable.map((e) => e.id).sort();

// --- the lifecycle deadlock this fixes -------------------------------------

test('a fully approved feature is still executable — the regression run', () => {
  // Regression: only "Approved for Execution" was executable, so after one full cycle
  // every case sat at Approved and no second run could ever happen.
  const out = partitionCases(cases, allAt(STATUS.APPROVED));
  assert.deepEqual(execIds(out), [...ids].sort());
  assert.equal(out.held.length, 0);
});

test('Retest is executable — it literally means run it again', () => {
  const out = partitionCases(cases, allAt(STATUS.RETEST));
  assert.equal(out.executable.length, cases.length);
});

test('first-run approval is executable', () => {
  const out = partitionCases(cases, allAt(STATUS.APPROVED_FOR_EXECUTION));
  assert.equal(out.executable.length, cases.length);
});

test('Under Review is executable but warns that unreviewed evidence is replaced', () => {
  const out = partitionCases(cases, allAt(STATUS.UNDER_REVIEW));
  assert.equal(out.executable.length, cases.length);
  assert.ok(out.warnings.some((w) => /still Under Review/.test(w)), out.warnings.join('\n'));
});

// --- what must NOT run ------------------------------------------------------

test('unapproved cases never execute', () => {
  const out = partitionCases(cases, allAt(STATUS.CASE_REVIEW));
  assert.equal(out.executable.length, 0);
  assert.ok(out.held.every((h) => /awaiting QA design review/.test(h.reason)));
});

test('a rejected case is held back and says how to get it moving', () => {
  const out = partitionCases(cases, allAt(STATUS.REJECTED));
  assert.equal(out.executable.length, 0);
  assert.ok(out.held[0].reason.includes('generate-tests'), out.held[0].reason);
});

test('quarantined cases are excluded by default and includable while hardening', () => {
  const statuses = { ...allAt(STATUS.APPROVED), [ids[0]]: STATUS.QUARANTINED };
  const off = partitionCases(cases, statuses);
  assert.ok(!execIds(off).includes(ids[0]));
  assert.equal(off.quarantined.length, 1);
  assert.ok(off.warnings.some((w) => /--include-quarantined/.test(w)));

  const on = partitionCases(cases, statuses, { includeQuarantined: true });
  assert.ok(execIds(on).includes(ids[0]));
});

test('a status outside the lifecycle is surfaced, never guessed at', () => {
  const out = partitionCases(cases, { ...allAt(STATUS.APPROVED), [ids[0]]: 'Done ✅' });
  assert.deepEqual(out.unknown_status, [{ id: ids[0], status: 'Done ✅' }]);
  assert.ok(!execIds(out).includes(ids[0]));
});

test('cases never synced to ClickUp are reported, not silently run', () => {
  const partial = { ...allAt(STATUS.APPROVED) };
  delete partial[ids[0]];
  const out = partitionCases(cases, partial);
  assert.deepEqual(out.unsynced.map((u) => u.id), [ids[0]]);
  assert.ok(out.warnings.some((w) => /no ClickUp status/.test(w)));
});

test('ClickUp tasks with no matching case are surfaced', () => {
  const out = partitionCases(cases, { ...allAt(STATUS.APPROVED), 'CHECKOUT-GHOST-099': STATUS.APPROVED });
  assert.deepEqual(out.orphaned, ['CHECKOUT-GHOST-099']);
});

// --- confidence -------------------------------------------------------------

test('only an accepted verdict counts toward confidence', () => {
  // "Approved for Execution" is design approval, not a trusted result.
  const out = partitionCases(cases, allAt(STATUS.APPROVED_FOR_EXECUTION));
  assert.equal(out.counts.approved, 0);
  assert.equal(out.confidence.label, 'Not Ready'); // the fixture has P0 cases
});

test('a fully approved feature scores 100% and reads Ready', () => {
  const out = partitionCases(cases, allAt(STATUS.APPROVED));
  assert.equal(out.confidence.score, 1);
  assert.equal(out.confidence.label, '100%');
  assert.equal(out.confidence.ready, true);
});

test('confidence weights P0 over P1 over P2', () => {
  const priorities = { A: 'P0', B: 'P1', C: 'P2' };
  const all = confidence([{ id: 'A', approved: true }, { id: 'B', approved: true }, { id: 'C', approved: true }], priorities);
  assert.equal(all.score, 1);
  assert.equal(all.label, '100%');

  const noP2 = confidence([{ id: 'A', approved: true }, { id: 'B', approved: true }, { id: 'C', approved: false }], priorities);
  assert.equal(noP2.score, 5 / 6);
  assert.equal(noP2.ready, true);
});

test('any unapproved P0 forces Not Ready regardless of score', () => {
  const priorities = { A: 'P0', B: 'P1', C: 'P2' };
  const c = confidence([{ id: 'A', approved: false }, { id: 'B', approved: true }, { id: 'C', approved: true }], priorities);
  assert.equal(c.ready, false);
  assert.equal(c.label, 'Not Ready');
});

test('one unapproved P0 sinks an otherwise-approved feature', () => {
  const p0 = cases.find((c) => c.priority === 'P0');
  const out = partitionCases(cases, { ...allAt(STATUS.APPROVED), [p0.id]: STATUS.UNDER_REVIEW });
  assert.equal(out.confidence.ready, false);
  assert.equal(out.confidence.label, 'Not Ready');
});
