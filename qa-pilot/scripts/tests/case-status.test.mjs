import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { partitionCases, confidence, publishTransitions } from '../case-status.mjs';
import { DEFAULT_STATUSES } from '../lib/statuses.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const cases = parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8')).cases;
const ids = cases.map((c) => c.id);

// The fixture host deliberately does NOT use the canonical status names, so every test
// below goes through the profile's mapping rather than hardcoded wording.
const { profile } = loadProfile(resolve(FIXTURES, 'qa-pilot.config.yaml'));
const NAMES = profile.clickup.statuses;
const STATUS = Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k.toUpperCase(), v]));

// These tests are about status handling, so they default to a run where everything
// passed. Confidence-specific tests pass their own verdicts.
const allPass = () => Object.fromEntries(ids.map((id) => [id, 'pass']));
const partition = (statuses, opts = {}) =>
  partitionCases(cases, statuses, { statusNames: NAMES, verdicts: allPass(), ...opts });
const allAt = (status) => Object.fromEntries(ids.map((id) => [id, status]));
const execIds = (out) => out.executable.map((e) => e.id).sort();

// --- status names are the host's, the lifecycle is the pipeline's -----------

test('the fixture host uses its own vocabulary, not the canonical names', () => {
  assert.notDeepEqual(NAMES, DEFAULT_STATUSES, 'fixture must differ or these tests prove nothing');
  assert.equal(NAMES.approved, 'accepted');
  assert.equal(NAMES.quarantined, 'skip');
});

test("a host's own names drive the lifecycle", () => {
  const out = partition(allAt('accepted'));
  assert.equal(out.executable.length, cases.length, '"accepted" is this host\'s approved state');
  assert.equal(out.confidence.label, '100%');
});

test('the canonical names are meaningless to a host that renamed them', () => {
  // "Approved" is not a status this host has, so it must be surfaced, never assumed.
  const out = partition(allAt('Approved'));
  assert.equal(out.executable.length, 0);
  assert.equal(out.unknown_status.length, cases.length);
  assert.ok(out.warnings.some((w) => /does not declare/.test(w)), out.warnings.join('\n'));
});

test('the unknown-status warning lists what the profile does declare', () => {
  const out = partition({ ...allAt('accepted'), [ids[0]]: 'Done' });
  const w = out.warnings.find((x) => /does not declare/.test(x));
  assert.match(w, /ready for review/, 'should name the declared statuses so the fix is obvious');
  assert.match(w, /fix the names in the profile/);
});

test('status matching is case- and whitespace-insensitive', () => {
  // ClickUp shows lowercase statuses; a profile author naturally capitalises them.
  const out = partition(allAt('  ACCEPTED  '));
  assert.equal(out.executable.length, cases.length);
});

test('lifecycle state travels with each case, so callers need not re-match names', () => {
  const out = partition(allAt('ready to run'));
  assert.ok(out.executable.every((e) => e.state === 'approved_for_execution'));
});

test('falls back to canonical names when a host declares none', () => {
  const out = partitionCases(cases, allAt('Approved')); // no statusNames passed
  assert.equal(out.executable.length, cases.length);
});

// --- the lifecycle deadlock this fixes -------------------------------------

test('a fully approved feature is still executable: the regression run', () => {
  // Regression: only "Approved for Execution" was executable, so after one full cycle
  // every case sat at Approved and no second run could ever happen.
  const out = partition(allAt(STATUS.APPROVED));
  assert.deepEqual(execIds(out), [...ids].sort());
  assert.equal(out.held.length, 0);
});

test('Retest is executable, since it literally means run it again', () => {
  const out = partition(allAt(STATUS.RETEST));
  assert.equal(out.executable.length, cases.length);
});

test('first-run approval is executable', () => {
  const out = partition(allAt(STATUS.APPROVED_FOR_EXECUTION));
  assert.equal(out.executable.length, cases.length);
});

test('an unreviewed case is executable but warns that its evidence is replaced', () => {
  const out = partition(allAt(STATUS.UNDER_REVIEW));
  assert.equal(out.executable.length, cases.length);
  // The warning quotes the host's own wording, so it reads like their board.
  assert.ok(out.warnings.some((w) => w.includes(`"${NAMES.under_review}"`)), out.warnings.join('\n'));
});

// --- what must NOT run ------------------------------------------------------

test('unapproved cases never execute', () => {
  const out = partition(allAt(STATUS.CASE_REVIEW));
  assert.equal(out.executable.length, 0);
  assert.ok(out.held.every((h) => /awaiting QA design review/.test(h.reason)));
});

test('a rejected case is held back and says how to get it moving', () => {
  const out = partition(allAt(STATUS.REJECTED));
  assert.equal(out.executable.length, 0);
  assert.ok(out.held[0].reason.includes('generate-tests'), out.held[0].reason);
});

test('quarantined cases are excluded by default and includable while hardening', () => {
  const statuses = { ...allAt(STATUS.APPROVED), [ids[0]]: STATUS.QUARANTINED };
  const off = partition(statuses);
  assert.ok(!execIds(off).includes(ids[0]));
  assert.equal(off.quarantined.length, 1);
  assert.ok(off.warnings.some((w) => /--include-quarantined/.test(w)));

  const on = partition(statuses, { includeQuarantined: true });
  assert.ok(execIds(on).includes(ids[0]));
});

test('a status outside the lifecycle is surfaced, never guessed at', () => {
  const out = partition({ ...allAt(STATUS.APPROVED), [ids[0]]: 'Done ✅' });
  assert.deepEqual(out.unknown_status, [{ id: ids[0], status: 'Done ✅' }]);
  assert.ok(!execIds(out).includes(ids[0]));
});

test('cases never synced to ClickUp are reported, not silently run', () => {
  const partial = { ...allAt(STATUS.APPROVED) };
  delete partial[ids[0]];
  const out = partition(partial);
  assert.deepEqual(out.unsynced.map((u) => u.id), [ids[0]]);
  assert.ok(out.warnings.some((w) => /no ClickUp status/.test(w)));
});

test('ClickUp tasks with no matching case are surfaced', () => {
  const out = partition({ ...allAt(STATUS.APPROVED), 'CHECKOUT-GHOST-099': STATUS.APPROVED });
  assert.deepEqual(out.orphaned, ['CHECKOUT-GHOST-099']);
});

// --- confidence -------------------------------------------------------------

test('only an accepted verdict counts toward confidence', () => {
  // "Approved for Execution" is design approval, not a trusted result.
  const out = partition(allAt(STATUS.APPROVED_FOR_EXECUTION));
  assert.equal(out.counts.approved, 0);
  assert.equal(out.confidence.label, 'Not Ready'); // the fixture has P0 cases
});

test('a fully approved feature scores 100% and reads Ready', () => {
  const out = partition(allAt(STATUS.APPROVED));
  assert.equal(out.confidence.score, 1);
  assert.equal(out.confidence.label, '100%');
  assert.equal(out.confidence.ready, true);
});

test('confidence weights P0 over P1 over P2', () => {
  const priorities = { A: 'P0', B: 'P1', C: 'P2' };
  const all = confidence([{ id: 'A', approved: true, passed: true }, { id: 'B', approved: true, passed: true }, { id: 'C', approved: true, passed: true }], priorities);
  assert.equal(all.score, 1);
  assert.equal(all.label, '100%');

  const noP2 = confidence([{ id: 'A', approved: true, passed: true }, { id: 'B', approved: true, passed: true }, { id: 'C', approved: false, passed: true }], priorities);
  assert.equal(noP2.score, 5 / 6);
  assert.equal(noP2.ready, true);
});

test('any unapproved P0 forces Not Ready regardless of score', () => {
  const priorities = { A: 'P0', B: 'P1', C: 'P2' };
  const c = confidence([{ id: 'A', approved: false, passed: true }, { id: 'B', approved: true, passed: true }, { id: 'C', approved: true, passed: true }], priorities);
  assert.equal(c.ready, false);
  assert.equal(c.label, 'Not Ready');
});

test('one unapproved P0 sinks an otherwise-approved feature', () => {
  const p0 = cases.find((c) => c.priority === 'P0');
  const out = partition({ ...allAt(STATUS.APPROVED), [p0.id]: STATUS.UNDER_REVIEW });
  assert.equal(out.confidence.ready, false);
  assert.equal(out.confidence.label, 'Not Ready');
});

test('an approved case that FAILED does not count toward confidence', () => {
  // The bug this replaced: qa-review tells QA that a confirmed real failure is a bug rather
  // than a broken test, so the honest action on a failing P0 is to approve the verdict.
  // Scoring on status alone therefore read "100% Ready" precisely when QA had just
  // confirmed the feature was broken.
  const priorities = { A: 'P0', B: 'P1' };
  const c = confidence(
    [{ id: 'A', approved: true, passed: false }, { id: 'B', approved: true, passed: true }],
    priorities,
  );
  assert.equal(c.ready, false);
  assert.equal(c.label, 'Not Ready');
  assert.match(c.why, /approved pass/);
});

test('without verdicts the score is Unknown, never a number', () => {
  const out = partitionCases(cases, allAt(STATUS.APPROVED), { statusNames: NAMES });
  assert.equal(out.confidence.score, null);
  assert.equal(out.confidence.label, 'Unknown');
  assert.equal(out.confidence.ready, false);
});

test('a case absent from the run never counts as a pass', () => {
  const p0 = cases.find((c) => c.priority === 'P0');
  const verdicts = allPass();
  delete verdicts[p0.id];
  const out = partition(allAt(STATUS.APPROVED), { verdicts });
  assert.equal(out.confidence.ready, false, 'an unrun P0 is not a proved P0');
});

// --- publish transitions -----------------------------------------------------

test('an unchanged spec that passes again keeps its approval', () => {
  // Otherwise every regression run resets the whole feature to unreviewed, which at a few
  // hundred cases means one person re-reviewing everything weekly: abandoned or rubber-stamped.
  const [t] = publishTransitions(
    [{ id: 'X-1' }], { 'X-1': NAMES.approved }, { 'X-1': 'pass' },
    { statusNames: NAMES, specHashes: { 'X-1': 'abc123' }, approvedHashes: { 'X-1': 'abc123' } },
  );
  assert.equal(t.to, 'approved');
  assert.match(t.reason, /carries forward/);
});

test('a spec edited since approval goes back for review even when it passes', () => {
  const [t] = publishTransitions(
    [{ id: 'X-1' }], { 'X-1': NAMES.approved }, { 'X-1': 'pass' },
    { statusNames: NAMES, specHashes: { 'X-1': 'new456' }, approvedHashes: { 'X-1': 'abc123' } },
  );
  assert.equal(t.to, 'under_review');
  assert.match(t.reason, /spec changed/);
});

test('a missing spec hash is treated as changed', () => {
  const [t] = publishTransitions(
    [{ id: 'X-1' }], { 'X-1': NAMES.approved }, { 'X-1': 'pass' }, { statusNames: NAMES },
  );
  assert.equal(t.to, 'under_review', 'unknown provenance takes the conservative path');
});

test('failures and flakes route by verdict, and blocked is left alone', () => {
  const out = publishTransitions(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    { A: NAMES.approved, B: NAMES.approved, C: NAMES.approved },
    { A: 'fail', B: 'flaky', C: 'blocked' },
    { statusNames: NAMES },
  );
  assert.deepEqual(out.map((t) => [t.id, t.to]), [['A', 'under_review'], ['B', 'quarantined']]);
});

test('a case that did not run is not transitioned', () => {
  const out = publishTransitions([{ id: 'A' }], { A: NAMES.approved }, {}, { statusNames: NAMES });
  assert.equal(out.length, 0);
});
