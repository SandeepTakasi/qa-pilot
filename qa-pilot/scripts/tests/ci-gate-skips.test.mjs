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
const H = hashSpec(SPEC);

// --- the pure function -------------------------------------------------------

test('a case dropped by the priority filter is not a skip', () => {
  const r = selectSpecs(
    { A: H, B: H },
    { A: 'a.ts', B: 'b.ts' },
    (p) => (p === 'a.ts' || p === 'b.ts' ? SPEC : null),
    { priorities: ['P0'], priorityOf: { A: 'P0', B: 'P1' } },
  );
  assert.deepEqual(r.run.map((x) => x.id), ['A']);
  assert.equal(r.skipped.length, 0);
});

// --- the CLI -----------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'ci-gate-skips-'));
const at = (name) => join(dir, name);
mkdirSync(join(dir, 'e2e'));
writeFileSync(at('e2e/a.ts'), SPEC);
writeFileSync(at('e2e/b.ts'), SPEC);
writeFileSync(at('approved.json'), JSON.stringify({ A: H, B: H, C: H }));
// C's spec file does not exist: one skip. B is present and unchanged.
writeFileSync(at('specs.json'), JSON.stringify({ A: at('e2e/a.ts'), B: at('e2e/b.ts'), C: at('e2e/gone.ts') }));
const BASE = ['--approved', at('approved.json'), '--specs', at('specs.json')];
const RUN = `${at('e2e/a.ts')} ${at('e2e/b.ts')}\n`;
const SKIP_LINE = 'skipped C: the spec file is missing from the repo, though QA approved it. Commit it, or re-approve the case.\n';
const refused = (k, n) => `REFUSED: ${k} approved spec(s) were skipped and --max-skipped allows ${n}, so this job would report green on part of the suite.\n`;

const select = (...args) => {
  const r = spawnSync(process.execPath, [GATE, 'select', ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('without the flag a skip is tolerated, as in 0.4.0', () => {
  const r = select(...BASE);
  assert.equal(r.code, 0);
  assert.equal(r.out, RUN);
  assert.equal(r.err, SKIP_LINE);
});

test('--max-skipped 0 refuses on a single skip, with the skip line first and nothing on stdout', () => {
  const r = select(...BASE, '--max-skipped', '0');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err, SKIP_LINE + refused(1, 0));
});

test('--max-skipped 0 with --json prints nothing on stdout either', () => {
  const r = select(...BASE, '--json', '--max-skipped', '0');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err, SKIP_LINE + refused(1, 0));
});

test('a limit at or above the skip count passes and prints the run list', () => {
  for (const n of ['1', '2', '10', '01']) {
    const r = select(...BASE, '--max-skipped', n);
    assert.equal(r.code, 0, n);
    assert.equal(r.out, RUN, n);
    assert.equal(r.err, SKIP_LINE, n);
  }
  const j = select(...BASE, '--json', '--max-skipped', '1');
  assert.equal(j.code, 0);
  assert.deepEqual(JSON.parse(j.out), [{ id: 'A', path: at('e2e/a.ts') }, { id: 'B', path: at('e2e/b.ts') }]);
});

test('the refusal counts every skip against the limit', () => {
  writeFileSync(at('approved2.json'), JSON.stringify({ A: H, C: H, D: H }));
  writeFileSync(at('specs2.json'), JSON.stringify({ A: at('e2e/a.ts'), C: at('e2e/gone.ts') }));
  const base = ['--approved', at('approved2.json'), '--specs', at('specs2.json')];
  // C is missing, D has no spec path: two skips.
  let r = select(...base, '--max-skipped', '1');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.ok(r.err.endsWith(refused(2, 1)), r.err);
  r = select(...base, '--max-skipped', '2');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')}\n`);
});

test('--max-skipped 0 passes when nothing was skipped', () => {
  writeFileSync(at('approved-clean.json'), JSON.stringify({ A: H, B: H }));
  const r = select('--approved', at('approved-clean.json'), '--specs', at('specs.json'), '--max-skipped', '0');
  assert.equal(r.code, 0);
  assert.equal(r.out, RUN);
  assert.equal(r.err, '');
});

test('cases dropped by --priority are not skips, so --max-skipped 0 still passes', () => {
  writeFileSync(at('approved-clean.json'), JSON.stringify({ A: H, B: H }));
  writeFileSync(at('cases.yaml'), 'cases:\n  - id: A\n    priority: P0\n  - id: B\n    priority: P1\n');
  const r = select(
    '--approved', at('approved-clean.json'), '--specs', at('specs.json'),
    '--cases', at('cases.yaml'), '--priority', 'P0', '--max-skipped', '0',
  );
  assert.equal(r.code, 0);
  assert.equal(r.out, `${at('e2e/a.ts')}\n`);
  assert.equal(r.err, '');
});

test('an invalid value throws, exit 1, whatever the skip count', () => {
  for (const value of ['', 'abc', '-1', '1.5', '1e2', ' 1', '1 ', '+1', '0x1']) {
    const r = select(...BASE, '--max-skipped', value);
    assert.equal(r.code, 1, JSON.stringify(value));
    assert.equal(r.out, '', JSON.stringify(value));
    assert.equal(r.err.trim(), 'select: --max-skipped must be a whole number, 0 or more', JSON.stringify(value));
  }
});

test('--max-skipped as the last argument is the empty value, never "unlimited"', () => {
  const r = select(...BASE, '--max-skipped');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err.trim(), 'select: --max-skipped must be a whole number, 0 or more');
});

test('zero runnable specs keeps its own refusal, ahead of the skip limit', () => {
  writeFileSync(at('approved-gone.json'), JSON.stringify({ C: H }));
  const r = select('--approved', at('approved-gone.json'), '--specs', at('specs.json'), '--max-skipped', '0');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(
    r.err,
    `${SKIP_LINE}REFUSED: no approved spec is runnable, so this job would report green having proved nothing.\n`,
  );
});
