import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { decide } from '../clickup-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '../clickup-guard.mjs');
// The guard stats paths through an injected function, so a fake filesystem is a map of
// path -> stat-like object; anything else throws ENOENT. The guard acts only in a repo
// with a host profile, so the fakes below say explicitly whether one is present.
const fsFake = (files) => (p) => {
  if (Object.hasOwn(files, p)) return { mtimeMs: Date.now(), ...files[p] };
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};
const REPO = { '/repo/.git': {}, '/repo/qa-pilot.config.yaml': {} };
const FLAG_AT = '/repo/.qa-pilot/allow-clickup-writes';
const noFlag = fsFake(REPO);
const withFlag = fsFake({ ...REPO, [FLAG_AT]: {} });
const staleFlag = fsFake({ ...REPO, [FLAG_AT]: { mtimeMs: Date.now() - 31 * 60 * 1000 } });

const SERVER = 'mcp__ec09fc14-2b44-446e-8e53-b0d505c57a84__';

test('write tools are denied without the flag', () => {
  for (const t of ['clickup_update_task', 'clickup_create_task', 'clickup_delete_task',
    'clickup_create_task_comment', 'clickup_add_tag_to_task', 'clickup_attach_task_file']) {
    const v = decide({ tool_name: SERVER + t, cwd: '/repo' }, noFlag);
    assert.ok(v, `${t} should have been denied`);
    assert.match(v.reason, /publish-results/);
  }
});

test('write tools are allowed with the flag', () => {
  assert.equal(decide({ tool_name: SERVER + 'clickup_update_task', cwd: '/repo' }, withFlag), null);
});

test('read tools are always allowed: the guard polices writes, not ClickUp use', () => {
  for (const t of ['clickup_get_task', 'clickup_search', 'clickup_filter_tasks',
    'clickup_find_member_by_name', 'clickup_resolve_assignees', 'clickup_get_workspace_hierarchy',
    'clickup_list_document_pages', 'clickup_download_task_attachment', 'clickup_get_task_comments']) {
    assert.equal(decide({ tool_name: SERVER + t, cwd: '/repo' }, noFlag), null, `${t} should be allowed`);
  }
});

test('non-ClickUp tools are none of the guard\'s business', () => {
  for (const t of ['Bash', 'Write', 'mcp__playwright__browser_click', 'mcp__github__create_issue']) {
    assert.equal(decide({ tool_name: t, cwd: '/repo' }, noFlag), null, `${t} should be allowed`);
  }
});

test('a payload with no tool name is allowed rather than breaking the session', () => {
  assert.equal(decide({}, noFlag), null);
  assert.equal(decide(null, noFlag), null);
});

test('server names are matched case-insensitively', () => {
  // The live server is named mcp__claude_ai_ClickUp__*, not mcp__clickup__*.
  for (const t of ['mcp__claude_ai_ClickUp__clickup_update_task',
    'mcp__ClickUpPro__update_task', 'mcp__Clickup__create_task']) {
    assert.ok(decide({ tool_name: t, cwd: '/repo' }, noFlag), `${t} should have been denied`);
  }
});

test('"list" as a NOUN in a write tool name does not read as read-only', () => {
  // Regression: matching the word `list` anywhere allowed five real ClickUp write tools.
  for (const t of ['clickup_create_list', 'clickup_update_list', 'clickup_add_task_to_list',
    'clickup_remove_task_from_list', 'clickup_create_list_in_folder']) {
    assert.ok(decide({ tool_name: SERVER + t, cwd: '/repo' }, noFlag), `${t} should have been denied`);
  }
});

test('"list" as a leading VERB is still a read', () => {
  assert.equal(decide({ tool_name: SERVER + 'clickup_list_document_pages', cwd: '/repo' }, noFlag), null);
});

test('unknown ClickUp tools are denied by default', () => {
  // A server that adds a write tool tomorrow must be covered without a code change here.
  for (const t of ['clickup_frobnicate_task', 'clickup_publish_everything']) {
    assert.ok(decide({ tool_name: SERVER + t, cwd: '/repo' }, noFlag), `${t} should have been denied`);
  }
});

test('a stale flag no longer opens the guard', () => {
  // A session that dies between touch and rm must not leave writes open forever.
  assert.ok(decide({ tool_name: SERVER + 'clickup_update_task', cwd: '/repo' }, staleFlag),
    'a 31-minute-old flag should be ignored');
  assert.equal(decide({ tool_name: SERVER + 'clickup_update_task', cwd: '/repo' }, withFlag), null,
    'a fresh flag should still be honoured');
});

test('the deny message does not hand out the bypass command', () => {
  const { reason } = decide({ tool_name: SERVER + 'clickup_update_task', cwd: '/repo' }, noFlag);
  assert.doesNotMatch(reason, /touch|mkdir/, 'the refusal must not be a copy-pasteable workaround');
  assert.match(reason, /publish-results/);
});

test('a read-only word in the server name does not excuse a write tool', () => {
  // Regression: matching against the whole name let "mcp__list_server__clickup_update_task"
  // pass as read-only because of the server segment.
  for (const t of ['mcp__list_clickup_server__clickup_update_task',
    'mcp__get_clickup__clickup_delete_task', 'mcp__clickup_search_svc__clickup_update_task']) {
    assert.ok(decide({ tool_name: t, cwd: '/repo' }, noFlag), `${t} should have been denied`);
  }
});

// --- only in repos that use QA-Pilot -------------------------------------------------
// The plugin installs user-scope, so the hook fires in every repo. Where no host profile
// exists, ClickUp is somebody else's workflow and none of the guard's business.

const WRITE = SERVER + 'clickup_update_task';

test('a repo with no host profile is left alone', () => {
  assert.equal(decide({ tool_name: WRITE, cwd: '/other' }, fsFake({ '/other/.git': {} })), null);
});

test('outside any git repo, only the cwd is checked, and no profile means allow', () => {
  assert.equal(decide({ tool_name: WRITE, cwd: '/tmp/x' }, fsFake({})), null);
  assert.ok(decide({ tool_name: WRITE, cwd: '/tmp/x' }, fsFake({ '/tmp/x/qa-pilot.config.yaml': {} })));
});

test('a session in a subdirectory still finds the profile at the git root', () => {
  const files = { ...REPO };
  assert.ok(decide({ tool_name: WRITE, cwd: '/repo/packages/web' }, fsFake(files)), 'should deny');
  assert.equal(decide({ tool_name: WRITE, cwd: '/repo/packages/web' }, fsFake({ ...files, [FLAG_AT]: {} })), null,
    'the flag lives next to the profile, at the repo root');
});

test('the search stops at the git root: a profile above it does not count', () => {
  const files = { '/home/qa-pilot.config.yaml': {}, '/home/proj/.git': {} };
  assert.equal(decide({ tool_name: WRITE, cwd: '/home/proj/src' }, fsFake(files)), null);
});

test('a custom profile path is honoured instead of the default name', () => {
  const custom = { profilePath: 'config/qa.yaml' };
  const files = { '/repo/.git': {}, '/repo/config/qa.yaml': {} };
  assert.ok(decide({ tool_name: WRITE, cwd: '/repo' }, fsFake(files), custom), 'custom path present: deny');
  assert.equal(decide({ tool_name: WRITE, cwd: '/repo' }, fsFake(REPO), custom), null,
    'only the configured path counts, not the default name');
  assert.equal(decide({ tool_name: WRITE, cwd: '/repo' }, fsFake({ ...files, [FLAG_AT]: {} }), custom), null,
    'the flag sits at the repo root whatever the profile path');
});

test('an absolute profile path is checked as given', () => {
  const opts = { profilePath: '/etc/qa/qa-pilot.config.yaml' };
  assert.ok(decide({ tool_name: WRITE, cwd: '/repo' }, fsFake({ '/etc/qa/qa-pilot.config.yaml': {} }), opts));
  assert.equal(decide({ tool_name: WRITE, cwd: '/repo' }, fsFake(REPO), opts), null);
});

test('reads never need a profile lookup to be allowed', () => {
  assert.equal(decide({ tool_name: SERVER + 'clickup_get_task', cwd: '/repo' }, fsFake(REPO)), null);
});

// --- end-to-end through the actual stdin/stdout contract ---

const runGuard = (payload) =>
  execFileSync('node', [GUARD], { input: JSON.stringify(payload), encoding: 'utf8' });

// A throwaway repo that uses QA-Pilot: the guard only needs the profile to exist.
const qaRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-guard-'));
  writeFileSync(join(dir, 'qa-pilot.config.yaml'), 'project: x\n');
  return dir;
};

test('denies over stdin with the documented hookSpecificOutput shape', () => {
  const dir = qaRepo();
  const out = JSON.parse(runGuard({
    hook_event_name: 'PreToolUse',
    tool_name: SERVER + 'clickup_update_task',
    tool_input: { taskId: 'abc', status: 'Approved' },
    cwd: dir,
  }));
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /video, trace, deploy SHA/);
});

test('allows over stdin, printing nothing, in a repo without a host profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-guard-'));
  const out = runGuard({ hook_event_name: 'PreToolUse', tool_name: SERVER + 'clickup_update_task', cwd: dir });
  assert.equal(out.trim(), '');
});

test('allows over stdin once the flag file exists, and prints nothing', () => {
  const dir = qaRepo();
  mkdirSync(join(dir, '.qa-pilot'), { recursive: true });
  writeFileSync(join(dir, '.qa-pilot/allow-clickup-writes'), '');
  const out = runGuard({
    hook_event_name: 'PreToolUse',
    tool_name: SERVER + 'clickup_update_task',
    tool_input: {},
    cwd: dir,
  });
  assert.equal(out.trim(), '');
});

test('the CLI reads the configured profile path from the plugin option variable', () => {
  // Claude Code exports each plugin userConfig option to hooks as CLAUDE_PLUGIN_OPTION_<KEY>.
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-guard-'));
  writeFileSync(join(dir, 'custom-qa.yaml'), 'project: x\n');
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: SERVER + 'clickup_update_task', cwd: dir });
  const run = (env) => execFileSync('node', [GUARD], { input: payload, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(run({ CLAUDE_PLUGIN_OPTION_PROFILE_PATH: 'custom-qa.yaml' }), /"deny"/);
  assert.equal(run({ CLAUDE_PLUGIN_OPTION_PROFILE_PATH: '' }).trim(), '', 'unset means the default name, absent here');
});

test('a malformed payload exits cleanly instead of blocking the session', () => {
  const out = execFileSync('node', [GUARD], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(out.trim(), '');
});
