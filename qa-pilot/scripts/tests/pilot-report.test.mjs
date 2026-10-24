import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pilotReport } from '../pilot-report.mjs';
import { specHash } from '../lib/spec-hash.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'pilot-report.mjs');
const rec = (...verdicts) => ({ cases: verdicts.map((verdict, i) => ({ id: `C-${i}`, verdict })) });

test('rates come from every published run, flaky over executed and blocked over all', () => {
  const r = pilotReport({ records: [rec('pass', 'pass', 'flaky', 'blocked'), rec('pass', 'fail')], reviews: [], bugs: null, selection: null });
  assert.equal(r.runs, 2);
  assert.deepEqual(r.verdicts, { pass: 3, fail: 1, flaky: 1, blocked: 1 });
  assert.equal(r.flaky_rate_pct, 20);
  assert.equal(r.blocked_rate_pct, 16.7);
});

test('review minutes are per decision, and untimed or empty sessions are left out', () => {
  const r = pilotReport({
    records: [], bugs: null, selection: null,
    reviews: [
      { started_at: '2026-10-24T10:00:00Z', finished_at: '2026-10-24T10:30:00Z', decisions: [{}, {}, {}] },
      { started_at: '2026-10-24T11:00:00Z', finished_at: '2026-10-24T11:10:00Z', decisions: [{}] },
      { started_at: '2026-10-24T12:00:00Z', decisions: [{}] },
      { started_at: '2026-10-24T13:00:00Z', finished_at: '2026-10-24T13:05:00Z', decisions: [] },
    ],
  });
  assert.deepEqual(r.review, { sessions: 2, decisions: 4, minutes_per_decision: 10 });
});

test('no data is reported as no data, never as zero', () => {
  const r = pilotReport({ records: [], reviews: [], bugs: null, selection: null });
  assert.equal(r.flaky_rate_pct, null);
  assert.equal(r.review, null);
  assert.equal(r.bugs_filed, null);
  assert.equal(r.ci, null);
});

test('bugs filed counts superseded ones too', () => {
  const r = pilotReport({ records: [], reviews: [], selection: null, bugs: { A: { superseded: ['t1'] }, B: {} } });
  assert.equal(r.bugs_filed, 3);
});

test('the CLI reads the feature directory and names specs that dropped out of CI', () => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-report-'));
  const f = join(root, 'testing/checkout');
  mkdirSync(join(f, 'verdicts'), { recursive: true });
  mkdirSync(join(root, 'e2e'));
  writeFileSync(join(f, 'verdicts/r1.json'), JSON.stringify(rec('pass', 'flaky')));
  writeFileSync(join(root, 'e2e/a.spec.ts'), 'test("A")');
  writeFileSync(join(root, 'e2e/b.spec.ts'), 'test("B") // edited');
  writeFileSync(join(f, 'cases.yaml'), 'cases:\n  - id: A\n    priority: P0\n  - id: B\n    priority: P1\n');
  const h = specHash('e2e/a.spec.ts', { id: 'A' }, { read: () => 'test("A")' });
  writeFileSync(join(f, 'approved.json'), JSON.stringify({ A: h, B: h }));
  writeFileSync(join(f, 'specs.json'), JSON.stringify({ A: 'e2e/a.spec.ts', B: 'e2e/b.spec.ts' }));
  const r = spawnSync(process.execPath, [SCRIPT, 'testing/checkout', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.flaky_rate_pct, 50);
  assert.equal(out.ci.approved_runnable, 1);
  assert.deepEqual(out.ci.dropped_out.map((s) => s.id), ['B']);
  const text = spawnSync(process.execPath, [SCRIPT, 'testing/checkout'], { cwd: root, encoding: 'utf8' });
  assert.match(text.stdout, /Dropped out of CI:\s+1\n  B: /);
  assert.match(text.stdout, /QA review time:\s+no timed review sessions/);
});
