import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Regression: `import.meta.url === \`file://${process.argv[1]}\`` is false whenever the
// path percent-encodes (a space is enough), so every CLI ran zero lines and exited 0:
// the publish gate vacuously "passed" and the hook failed open. Silent and fail-open,
// which is the worst combination, and structurally invisible to in-process unit tests.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..');

// Copy the scripts under a directory whose name contains a space.
const root = mkdtempSync(join(tmpdir(), 'qa-pilot-cli-'));
const spaced = join(root, 'plugin dir with spaces', 'scripts');
cpSync(SCRIPTS, spaced, { recursive: true });

const bad = join(root, 'garbage.json');
writeFileSync(bad, '{"not":"a report"}');
const badYaml = join(root, 'garbage.yaml');
writeFileSync(badYaml, 'project: nope\n');

const run = (script, args) => spawnSync('node', [join(spaced, script), ...args], { encoding: 'utf8' });

// Each entry: script, args that MUST fail, and a pattern its complaint should match.
const CASES = [
  ['lib/profile.mjs', [badYaml], /invalid|required/i],
  ['validate-cases.mjs', [badYaml, '--profile', badYaml], /invalid|required|not found/i],
  ['validate-report.mjs', [bad, '--profile', badYaml], /invalid|required|REFUSED/i],
  ['parse-report.mjs', [bad, join(root, 'no-such-meta.json')], /ENOENT|no such file/i],
  ['read-env-sha.mjs', [badYaml, 'nope-env'], /invalid|required|registry/i],
];

for (const [script, args, pattern] of CASES) {
  test(`${script} exits nonzero on bad input from a path containing a space`, () => {
    const { status, stderr, stdout } = run(script, args);
    assert.notEqual(status, 0,
      `${script} exited 0, so it almost certainly never ran its CLI block.\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.match(stderr, pattern);
  });
}

test('every CLI prints usage and exits nonzero when given no arguments', () => {
  for (const [script] of CASES) {
    const { status, stderr } = run(script, []);
    assert.notEqual(status, 0, `${script} exited 0 with no arguments`);
    assert.match(stderr, /usage:/i, `${script} printed no usage`);
  }
});

test('the guard still denies from a path containing a space', () => {
  // The guard acts only where a host profile exists, and only on QA-Pilot's own case tasks,
  // so give the cwd a profile and a case map, and write to a mapped task.
  writeFileSync(join(root, 'qa-pilot.config.yaml'), 'project: x\n');
  mkdirSync(join(root, 'testing/checkout'), { recursive: true });
  writeFileSync(join(root, 'testing/checkout/clickup-map.json'), JSON.stringify({ 'CHECKOUT-ORDER-001': 'case7k2m9q' }));
  const { stdout, status } = spawnSync('node', [join(spaced, 'clickup-guard.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__claude_ai_ClickUp__clickup_update_task',
      tool_input: { task_id: 'case7k2m9q', status: 'Approved' },
      cwd: root,
    }),
    encoding: 'utf8',
  });
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny',
    'the hook failed open from a spaced path, so writes would be unguarded');
});
