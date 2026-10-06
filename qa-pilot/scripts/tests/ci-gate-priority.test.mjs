import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSpecs } from '../ci-gate.mjs';
import { hashSpec } from '../parse-report.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ci-gate.mjs');
const SPEC = 'test("X-A-001 does a thing", async ({ page }) => {});';
const OTHER = 'test("X-A-001 does a different thing", async ({ page }) => {});';
const reader = (files) => (p) => (Object.hasOwn(files, p) ? files[p] : null);

// Three approved cases at three priorities, every spec unchanged.
const H = hashSpec(SPEC);
const approved = { A: H, B: H, C: H };
const paths = { A: 'a.ts', B: 'b.ts', C: 'c.ts' };
const files = { 'a.ts': SPEC, 'b.ts': SPEC, 'c.ts': SPEC };
const priorityOf = { A: 'P0', B: 'P1', C: 'P2' };

// --- the pure function -------------------------------------------------------

test('without the fourth argument the result is the same as before', () => {
  const r = selectSpecs(approved, paths, reader(files));
  assert.deepEqual(r.run.map((x) => x.id), ['A', 'B', 'C']);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(selectSpecs(approved, paths, reader(files), {}), r);
});

test('only approved cases at a listed priority run', () => {
  const r = selectSpecs(approved, paths, reader(files), { priorities: ['P0', 'P2'], priorityOf });
  assert.deepEqual(r.run.map((x) => x.id), ['A', 'C']);
});

test('an approved case outside the filter is dropped silently, not skipped', () => {
  const r = selectSpecs(approved, paths, reader(files), { priorities: ['P0'], priorityOf });
  assert.deepEqual(r.run.map((x) => x.id), ['A']);
  assert.deepEqual(r.skipped, []);
});

test('an approved case missing from cases.yaml is skipped with its own reason', () => {
  const r = selectSpecs(approved, paths, reader(files), { priorities: ['P0'], priorityOf: { A: 'P0', B: 'P1' } });
  assert.deepEqual(r.run.map((x) => x.id), ['A']);
  assert.deepEqual(r.skipped, [{ id: 'C', reason: 'not in cases.yaml, so its priority is unknown' }]);
});

test('a case present without a valid priority is skipped with a different reason', () => {
  // undefined and null count as present: the key exists, the value is not P0, P1 or P2.
  for (const bad of [undefined, null, 'P3', 'p0', '', 0]) {
    const r = selectSpecs({ A: H }, { A: 'a.ts' }, reader(files), { priorities: ['P0'], priorityOf: { A: bad } });
    assert.deepEqual(r.run, [], String(bad));
    assert.deepEqual(r.skipped, [{ id: 'A', reason: 'no valid priority in cases.yaml, so its priority is unknown' }], String(bad));
  }
});

test('both unknown-priority skips are decided before the filter', () => {
  // P3 is outside every filter, yet it is reported rather than dropped silently.
  const r = selectSpecs({ A: H, B: H }, { A: 'a.ts', B: 'b.ts' }, reader(files), { priorities: ['P1'], priorityOf: { A: 'P3' } });
  assert.deepEqual(r.run, []);
  assert.deepEqual(r.skipped.map((s) => s.id), ['A', 'B']);
});

test('a key inherited from Object.prototype is not a key', () => {
  const r = selectSpecs({ constructor: H }, { constructor: 'a.ts' }, reader(files), { priorities: ['P0'], priorityOf: {} });
  assert.match(r.skipped[0].reason, /^not in cases\.yaml/);
});

test('the hash check runs after the filter, on what remains', () => {
  const r = selectSpecs(approved, paths, reader({ ...files, 'a.ts': OTHER, 'b.ts': OTHER }), { priorities: ['P0'], priorityOf });
  assert.deepEqual(r.run, []);
  // B is outside the filter, so only A, which drifted, is reported.
  assert.deepEqual(r.skipped.map((s) => s.id), ['A']);
  assert.match(r.skipped[0].reason, /changed since QA approved it/);
});

// --- the CLI -----------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'ci-gate-priority-'));
const at = (name) => join(dir, name);
mkdirSync(join(dir, 'e2e'));
for (const n of ['a', 'b', 'c']) writeFileSync(at(`e2e/${n}.ts`), SPEC);
writeFileSync(at('approved.json'), JSON.stringify(approved));
writeFileSync(at('specs.json'), JSON.stringify({ A: at('e2e/a.ts'), B: at('e2e/b.ts'), C: at('e2e/c.ts') }));
writeFileSync(at('cases.yaml'), 'cases:\n  - id: A\n    priority: P0\n  - id: B\n    priority: P1\n  - id: C\n    priority: P2\n');
const BASE = ['--approved', at('approved.json'), '--specs', at('specs.json')];

const select = (...args) => {
  const r = spawnSync(process.execPath, [GATE, 'select', ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('no new flags: the output is the plain space-separated list', () => {
  const r = select(...BASE);
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')} ${at('e2e/b.ts')} ${at('e2e/c.ts')}\n`);
  assert.equal(r.err, '');
});

test('--priority with --cases runs only that priority and prints nothing on stderr', () => {
  const r = select(...BASE, '--cases', at('cases.yaml'), '--priority', 'P0');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')}\n`);
  assert.equal(r.err, '');
});

test('values are trimmed and comma-separated', () => {
  const r = select(...BASE, '--cases', at('cases.yaml'), '--priority', 'P0, P2');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')} ${at('e2e/c.ts')}\n`);
});

test('--json still works under a filter', () => {
  const r = select(...BASE, '--cases', at('cases.yaml'), '--priority', 'P1', '--json');
  assert.deepEqual(JSON.parse(r.out), [{ id: 'B', path: at('e2e/b.ts') }]);
});

test('--priority without --cases is an error, exit 1', () => {
  const r = select(...BASE, '--priority', 'P0');
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'select: --priority needs --cases <cases.yaml>, because priority is recorded only there');
});

test('an unknown value is named, case-sensitive, exit 1', () => {
  for (const [value, named] of [['P3', 'P3'], ['p0', 'p0'], ['P0,P9,P8', 'P9']]) {
    const r = select(...BASE, '--cases', at('cases.yaml'), '--priority', value);
    assert.equal(r.code, 1, value);
    assert.equal(r.err.trim(), `select: unknown priority "${named}"; use P0, P1 or P2`, value);
  }
});

test('empty elements are the unknown value ""', () => {
  for (const value of ['', 'P0,,P1', 'P0,', ',P0', 'P0, ']) {
    const r = select(...BASE, '--cases', at('cases.yaml'), '--priority', value);
    assert.equal(r.code, 1, JSON.stringify(value));
    assert.equal(r.err.trim(), 'select: unknown priority ""; use P0, P1 or P2', JSON.stringify(value));
  }
});

test('--priority as the last argument is the unknown value "", never "run everything"', () => {
  const r = select(...BASE, '--cases', at('cases.yaml'), '--priority');
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'select: unknown priority ""; use P0, P1 or P2');
});

test('--priority with no --cases and an empty value reports the missing --cases first', () => {
  const r = select(...BASE, '--priority', '');
  assert.equal(r.code, 1);
  assert.match(r.err, /--priority needs --cases/);
});

test('a missing cases file is an error, only with --priority', () => {
  const missing = at('nope.yaml');
  const r = select(...BASE, '--cases', missing, '--priority', 'P0');
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), `no cases file at ${missing}`);
});

test('--cases alone is not read: a missing file changes nothing', () => {
  const r = select(...BASE, '--cases', at('nope.yaml'));
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')} ${at('e2e/b.ts')} ${at('e2e/c.ts')}\n`);
});

test('errors are reported in order: unknown value, then cases file, then ledger', () => {
  const noLedger = ['--approved', at('no-ledger.json'), '--specs', at('specs.json')];
  // unknown value beats a missing cases file
  let r = select(...noLedger, '--cases', at('nope.yaml'), '--priority', 'P7');
  assert.match(r.err, /unknown priority "P7"/);
  // a missing cases file beats a missing ledger
  r = select(...noLedger, '--cases', at('nope.yaml'), '--priority', 'P0');
  assert.match(r.err, /^no cases file at /);
  // then the ledger
  r = select(...noLedger, '--cases', at('cases.yaml'), '--priority', 'P0');
  assert.equal(r.code, 1);
  assert.match(r.err, /^no approval ledger at /);
  // --priority without --cases beats everything after the required-flag check
  r = select(...noLedger, '--priority', 'P7');
  assert.match(r.err, /--priority needs --cases/);
  // and the required flags come first of all
  r = select('--priority', 'P7');
  assert.match(r.err, /select needs --approved/);
});

test('nothing runnable at the priority is refused with the normalised list, exit 1', () => {
  writeFileSync(at('only-p1.yaml'), 'cases:\n  - id: A\n    priority: P1\n  - id: B\n    priority: P1\n  - id: C\n    priority: P1\n');
  const r = select(...BASE, '--cases', at('only-p1.yaml'), '--priority', ' P0 , P2 ');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err.trim(), 'REFUSED: no approved spec at priority P0,P2 is runnable, so this job would report green having proved nothing.');
});

test('skips are printed on stderr, drops are not', () => {
  writeFileSync(at('partial.yaml'), 'cases:\n  - id: A\n    priority: P0\n  - id: C\n    priority: P3\n');
  const r = select(...BASE, '--cases', at('partial.yaml'), '--priority', 'P0');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')}\n`);
  assert.equal(r.err, 'skipped B: not in cases.yaml, so its priority is unknown\nskipped C: no valid priority in cases.yaml, so its priority is unknown\n');
});

test('a listed case with no priority key, or an empty one, is skipped as having no valid priority', () => {
  // D has no priority key, E has `priority:` (YAML null): both are listed, neither has a valid value.
  for (const n of ['d', 'e']) writeFileSync(at(`e2e/${n}.ts`), SPEC);
  writeFileSync(at('approved-de.json'), JSON.stringify({ A: H, D: H, E: H }));
  writeFileSync(at('specs-de.json'), JSON.stringify({ A: at('e2e/a.ts'), D: at('e2e/d.ts'), E: at('e2e/e.ts') }));
  writeFileSync(at('no-priority.yaml'), 'cases:\n  - id: A\n    priority: P0\n  - id: D\n    title: no priority key\n  - id: E\n    priority:\n');
  const r = select('--approved', at('approved-de.json'), '--specs', at('specs-de.json'), '--cases', at('no-priority.yaml'), '--priority', 'P0');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')}\n`);
  assert.equal(r.err, 'skipped D: no valid priority in cases.yaml, so its priority is unknown\nskipped E: no valid priority in cases.yaml, so its priority is unknown\n');
});

test('without --priority the existing refusal text is unchanged', () => {
  writeFileSync(at('empty-approved.json'), '{}');
  const r = select('--approved', at('empty-approved.json'), '--specs', at('specs.json'));
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'REFUSED: no approved spec is runnable, so this job would report green having proved nothing.');
});
