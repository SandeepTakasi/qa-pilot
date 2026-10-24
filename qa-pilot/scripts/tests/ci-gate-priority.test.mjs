import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSpecs } from '../ci-gate.mjs';
import { specHash } from '../lib/spec-hash.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ci-gate.mjs');
const SPEC = 'test("X-A-001 does a thing", async ({ page }) => {});';
const OTHER = 'test("X-A-001 does a different thing", async ({ page }) => {});';
const reader = (files) => (p) => (Object.hasOwn(files, p) ? files[p] : null);

// Three approved cases at three priorities, every spec unchanged. The cases carry no steps or
// expected outcomes, so one hash fits all three.
const H = specHash('a.ts', {}, { read: () => SPEC });
const approved = { A: H, B: H, C: H };
const paths = { A: 'a.ts', B: 'b.ts', C: 'c.ts' };
const files = { 'a.ts': SPEC, 'b.ts': SPEC, 'c.ts': SPEC };
const casesOf = (pri) => Object.entries(pri).map(([id, priority]) => ({ id, priority }));
const CASES = casesOf({ A: 'P0', B: 'P1', C: 'P2' });
const sel = (appr, p, f, cases, priorities) => selectSpecs(appr, p, cases, { read: reader(f), priorities });

// --- the pure function -------------------------------------------------------

test('without a filter every approved, unchanged case runs', () => {
  const r = sel(approved, paths, files, CASES);
  assert.deepEqual(r.run.map((x) => x.id), ['A', 'B', 'C']);
  assert.deepEqual(r.skipped, []);
});

test('only approved cases at a listed priority run', () => {
  assert.deepEqual(sel(approved, paths, files, CASES, ['P0', 'P2']).run.map((x) => x.id), ['A', 'C']);
});

test('an approved case outside the filter is dropped silently, not skipped', () => {
  const r = sel(approved, paths, files, CASES, ['P0']);
  assert.deepEqual(r.run.map((x) => x.id), ['A']);
  assert.deepEqual(r.skipped, []);
});

test('an approved case missing from cases.yaml is skipped for retirement, with or without a filter', () => {
  for (const priorities of [undefined, ['P0']]) {
    const r = sel(approved, paths, files, casesOf({ A: 'P0', B: 'P1' }), priorities);
    assert.deepEqual(r.skipped.map((s) => s.id), ['C']);
    assert.match(r.skipped[0].reason, /^no longer in cases\.yaml/);
  }
});

test('a case present without a valid priority is skipped under a filter', () => {
  for (const bad of [undefined, null, 'P3', 'p0', '', 0]) {
    const r = sel({ A: H }, { A: 'a.ts' }, files, [{ id: 'A', priority: bad }], ['P0']);
    assert.deepEqual(r.run, [], String(bad));
    assert.deepEqual(r.skipped, [{ id: 'A', reason: 'no valid priority in cases.yaml, so its priority is unknown' }], String(bad));
  }
});

test('a key inherited from Object.prototype is not a case', () => {
  const r = sel({ constructor: H }, { constructor: 'a.ts' }, files, [], ['P0']);
  assert.match(r.skipped[0].reason, /^no longer in cases\.yaml/);
});

test('the hash check runs after the filter, on what remains', () => {
  const r = sel(approved, paths, { ...files, 'a.ts': OTHER, 'b.ts': OTHER }, CASES, ['P0']);
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
const BASE = ['--approved', at('approved.json'), '--specs', at('specs.json'), '--cases', at('cases.yaml')];

const select = (...args) => {
  const r = spawnSync(process.execPath, [GATE, 'select', ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('no filter: the output is the plain space-separated list', () => {
  const r = select(...BASE);
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')} ${at('e2e/b.ts')} ${at('e2e/c.ts')}\n`);
  assert.equal(r.err, '');
});

test('--priority runs only that priority and prints nothing on stderr', () => {
  const r = select(...BASE, '--priority', 'P0');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')}\n`);
  assert.equal(r.err, '');
});

test('values are trimmed and comma-separated', () => {
  const r = select(...BASE, '--priority', 'P0, P2');
  assert.equal(r.out, `${at('e2e/a.ts')} ${at('e2e/c.ts')}\n`);
});

test('--json still works under a filter', () => {
  const r = select(...BASE, '--priority', 'P1', '--json');
  assert.deepEqual(JSON.parse(r.out), [{ id: 'B', path: at('e2e/b.ts') }]);
});

test('the cases file is required, because the approval covers the case definition', () => {
  const r = select('--approved', at('approved.json'), '--specs', at('specs.json'));
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'select needs --approved <approved.json> --specs <specs.json> --cases <cases.yaml>');
});

test('an unknown value is named, case-sensitive, exit 1', () => {
  for (const [value, named] of [['P3', 'P3'], ['p0', 'p0'], ['P0,P9,P8', 'P9']]) {
    const r = select(...BASE, '--priority', value);
    assert.equal(r.code, 1, value);
    assert.equal(r.err.trim(), `select: unknown priority "${named}"; use P0, P1 or P2`, value);
  }
});

test('empty elements, and --priority as the last argument, are the unknown value ""', () => {
  for (const args of [[''], ['P0,,P1'], ['P0,'], [',P0'], ['P0, '], []]) {
    const r = select(...BASE, '--priority', ...args);
    assert.equal(r.code, 1, JSON.stringify(args));
    assert.equal(r.err.trim(), 'select: unknown priority ""; use P0, P1 or P2', JSON.stringify(args));
  }
});

test('errors are reported in order: required flags, unknown value, ledger, cases file', () => {
  const noLedger = ['--approved', at('no-ledger.json'), '--specs', at('specs.json')];
  let r = select('--priority', 'P7');
  assert.match(r.err, /select needs --approved/);
  r = select(...noLedger, '--cases', at('nope.yaml'), '--priority', 'P7');
  assert.match(r.err, /unknown priority "P7"/);
  r = select(...noLedger, '--cases', at('nope.yaml'), '--priority', 'P0');
  assert.match(r.err, /^no approval ledger at /);
  r = select('--approved', at('approved.json'), '--specs', at('specs.json'), '--cases', at('nope.yaml'));
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), `no cases file at ${at('nope.yaml')}`);
});

test('nothing runnable at the priority is refused with the normalised list, exit 1', () => {
  writeFileSync(at('only-p1.yaml'), 'cases:\n  - id: A\n    priority: P1\n  - id: B\n    priority: P1\n  - id: C\n    priority: P1\n');
  const r = select('--approved', at('approved.json'), '--specs', at('specs.json'), '--cases', at('only-p1.yaml'), '--priority', ' P0 , P2 ');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err.trim(), 'REFUSED: no approved spec at priority P0,P2 is runnable, so this job would report green having proved nothing.');
});

test('skips are printed on stderr, drops are not', () => {
  writeFileSync(at('partial.yaml'), 'cases:\n  - id: A\n    priority: P0\n  - id: C\n    priority: P3\n');
  const r = select('--approved', at('approved.json'), '--specs', at('specs.json'), '--cases', at('partial.yaml'), '--priority', 'P0');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')}\n`);
  assert.equal(r.err, 'skipped B: no longer in cases.yaml. Delete its key from approved.json to retire it, or restore the case.\nskipped C: no valid priority in cases.yaml, so its priority is unknown\n');
});

test('an empty ledger is refused as proving nothing', () => {
  writeFileSync(at('empty-approved.json'), '{}');
  const r = select('--approved', at('empty-approved.json'), '--specs', at('specs.json'), '--cases', at('cases.yaml'));
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'REFUSED: no approved spec is runnable, so this job would report green having proved nothing.');
});
