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

// QA-Pilot's own case tasks are the ones recorded in testing/*/clickup-map.json; the loader
// is injected so these tests do not touch the disk. OTHER is a task QA-Pilot never created.
const OWNED = 'case7k2m9q';
const OTHER = 'bug4x8n1zr';
const owned = { ownedIds: () => new Set([OWNED]) };
const onCase = { task_id: OWNED, status: 'Approved' };

// One call: tool name, the tool's input, and the fake filesystem; options default to the
// owned-task loader above.
const ask = (tool, toolInput, stat = noFlag, opts = owned, cwd = '/repo') =>
  decide({ tool_name: tool.startsWith('mcp__') ? tool : SERVER + tool, tool_input: toolInput, cwd }, stat, opts);

// --- the rule: writes to QA-Pilot's own case tasks go through the skills ----------------

test('writes to a QA-Pilot case task are denied without the flag', () => {
  for (const t of ['clickup_update_task', 'clickup_delete_task', 'clickup_create_task_comment',
    'clickup_add_tag_to_task', 'clickup_attach_task_file', 'clickup_move_task']) {
    const v = ask(t, onCase);
    assert.ok(v, `${t} on a case task should have been denied`);
    assert.match(v.reason, /publish-results/);
  }
});

test('writes to a QA-Pilot case task are allowed with the flag', () => {
  assert.equal(ask('clickup_update_task', onCase, withFlag), null);
});

test('writes to any other task are allowed, even in a repo that uses QA-Pilot', () => {
  // The reason for this rule: ordinary bug tickets, comments and uploads in a QA-Pilot host
  // repo are not QA records, and blocking them got in the way of unrelated work.
  for (const t of ['clickup_update_task', 'clickup_create_task_comment', 'clickup_add_tag_to_task',
    'clickup_attach_task_file', 'clickup_request_attachment_upload', 'clickup_delete_task']) {
    assert.equal(ask(t, { task_id: OTHER, status: 'In progress' }), null, `${t} on another task should pass`);
  }
});

test('creating a task or a list names no case task, so it is allowed', () => {
  assert.equal(ask('clickup_create_task', { list_id: '901234', name: 'Login button misaligned' }), null);
  assert.equal(ask('clickup_create_list', { folder_id: '905678', name: 'Sprint 12' }), null);
  assert.equal(ask('clickup_add_time_entry', {}), null, 'an empty input names no case task');
});

test('a case task is recognised wherever the input names it', () => {
  // Field names differ between ClickUp servers and tools, so the guard does not trust one key.
  const shapes = [
    { taskId: OWNED },
    { task_ids: [OTHER, OWNED] },
    { links_to: OWNED, task_id: OTHER },
    { source_task_ids: [OWNED], target_task_id: OTHER },
    { task: { id: OWNED } },
    { task_id: `#${OWNED}` },
    { comment_text: 'see', task_url: `https://app.clickup.com/t/${OWNED}` },
  ];
  for (const input of shapes) {
    assert.ok(ask('clickup_update_task', input), `should deny: ${JSON.stringify(input)}`);
  }
});

test('an ID inside longer text does not match by accident', () => {
  // Only whole tokens count, so a case ID that happens to be part of a word is not a hit.
  assert.equal(ask('clickup_create_task_comment', { task_id: OTHER, comment_text: `x${OWNED}y` }), null);
});

test('a repo whose maps are empty or unreadable blocks nothing', () => {
  assert.equal(ask('clickup_update_task', onCase, noFlag, { ownedIds: () => new Set() }), null);
});

// --- which tools count as writes --------------------------------------------------------

test('read tools are always allowed: the guard polices writes, not ClickUp use', () => {
  for (const t of ['clickup_get_task', 'clickup_search', 'clickup_filter_tasks',
    'clickup_find_member_by_name', 'clickup_resolve_assignees', 'clickup_get_workspace_hierarchy',
    'clickup_list_document_pages', 'clickup_download_task_attachment', 'clickup_get_task_comments']) {
    assert.equal(ask(t, onCase), null, `${t} should be allowed`);
  }
});

test('non-ClickUp tools are none of the guard\'s business', () => {
  for (const t of ['Bash', 'Write', 'mcp__playwright__browser_click', 'mcp__github__create_issue']) {
    assert.equal(decide({ tool_name: t, tool_input: onCase, cwd: '/repo' }, noFlag, owned), null, `${t} should be allowed`);
  }
});

test('a payload with no tool name is allowed rather than breaking the session', () => {
  assert.equal(decide({}, noFlag, owned), null);
  assert.equal(decide(null, noFlag, owned), null);
});

test('server names are matched case-insensitively', () => {
  // The live server is named mcp__claude_ai_ClickUp__*, not mcp__clickup__*.
  for (const t of ['mcp__claude_ai_ClickUp__clickup_update_task',
    'mcp__ClickUpPro__update_task', 'mcp__Clickup__create_task']) {
    assert.ok(ask(t, onCase), `${t} should have been denied`);
  }
});

test('"list" as a NOUN in a write tool name does not read as read-only', () => {
  // Regression: matching the word `list` anywhere allowed five real ClickUp write tools.
  for (const t of ['clickup_create_list', 'clickup_update_list', 'clickup_add_task_to_list',
    'clickup_remove_task_from_list', 'clickup_create_list_in_folder']) {
    assert.ok(ask(t, onCase), `${t} should have been denied`);
  }
});

test('"list" as a leading VERB is still a read', () => {
  assert.equal(ask('clickup_list_document_pages', onCase), null);
});

test('unknown ClickUp tools that touch a case task are denied by default', () => {
  // A server that adds a write tool tomorrow must be covered without a code change here.
  for (const t of ['clickup_frobnicate_task', 'clickup_publish_everything']) {
    assert.ok(ask(t, onCase), `${t} should have been denied`);
  }
});

test('a stale flag no longer opens the guard', () => {
  // A session that dies between touch and rm must not leave writes open forever.
  assert.ok(ask('clickup_update_task', onCase, staleFlag), 'a 31-minute-old flag should be ignored');
  assert.equal(ask('clickup_update_task', onCase, withFlag), null, 'a fresh flag should still be honoured');
});

test('the deny message names the task and does not hand out the bypass command', () => {
  const { reason } = ask('clickup_update_task', onCase);
  assert.doesNotMatch(reason, /touch|mkdir/, 'the refusal must not be a copy-pasteable workaround');
  assert.match(reason, /publish-results/);
  assert.match(reason, new RegExp(OWNED));
});

test('a read-only word in the server name does not excuse a write tool', () => {
  // Regression: matching against the whole name let "mcp__list_server__clickup_update_task"
  // pass as read-only because of the server segment.
  for (const t of ['mcp__list_clickup_server__clickup_update_task',
    'mcp__get_clickup__clickup_delete_task', 'mcp__clickup_search_svc__clickup_update_task']) {
    assert.ok(ask(t, onCase), `${t} should have been denied`);
  }
});

// --- only in repos that use QA-Pilot -------------------------------------------------
// The plugin installs user-scope, so the hook fires in every repo. Where no host profile
// exists, ClickUp is somebody else's workflow and none of the guard's business.

test('a repo with no host profile is left alone', () => {
  assert.equal(ask('clickup_update_task', onCase, fsFake({ '/other/.git': {} }), owned, '/other'), null);
});

test('outside any git repo, only the cwd is checked, and no profile means allow', () => {
  assert.equal(ask('clickup_update_task', onCase, fsFake({}), owned, '/tmp/x'), null);
  assert.ok(ask('clickup_update_task', onCase, fsFake({ '/tmp/x/qa-pilot.config.yaml': {} }), owned, '/tmp/x'));
});

test('a session in a subdirectory still finds the profile at the git root', () => {
  assert.ok(ask('clickup_update_task', onCase, fsFake(REPO), owned, '/repo/packages/web'), 'should deny');
  assert.equal(ask('clickup_update_task', onCase, fsFake({ ...REPO, [FLAG_AT]: {} }), owned, '/repo/packages/web'), null,
    'the flag lives next to the profile, at the repo root');
});

test('the case maps are read from the directory that holds the profile', () => {
  const seen = [];
  const spy = { ownedIds: (home) => { seen.push(home); return new Set([OWNED]); } };
  ask('clickup_update_task', onCase, fsFake(REPO), spy, '/repo/packages/web');
  assert.deepEqual(seen, ['/repo']);
});

test('the search stops at the git root: a profile above it does not count', () => {
  const files = { '/home/qa-pilot.config.yaml': {}, '/home/proj/.git': {} };
  assert.equal(ask('clickup_update_task', onCase, fsFake(files), owned, '/home/proj/src'), null);
});

test('a custom profile path is honoured instead of the default name', () => {
  const custom = { ...owned, profilePath: 'config/qa.yaml' };
  const files = { '/repo/.git': {}, '/repo/config/qa.yaml': {} };
  assert.ok(ask('clickup_update_task', onCase, fsFake(files), custom), 'custom path present: deny');
  assert.equal(ask('clickup_update_task', onCase, fsFake(REPO), custom), null,
    'only the configured path counts, not the default name');
  assert.equal(ask('clickup_update_task', onCase, fsFake({ ...files, [FLAG_AT]: {} }), custom), null,
    'the flag sits at the repo root whatever the profile path');
});

test('an absolute profile path is checked as given', () => {
  const opts = { ...owned, profilePath: '/etc/qa/qa-pilot.config.yaml' };
  assert.ok(ask('clickup_update_task', onCase, fsFake({ '/etc/qa/qa-pilot.config.yaml': {} }), opts));
  assert.equal(ask('clickup_update_task', onCase, fsFake(REPO), opts), null);
});

test('reads never need a profile lookup to be allowed', () => {
  assert.equal(ask('clickup_get_task', onCase, fsFake(REPO)), null);
});

// --- end-to-end through the actual stdin/stdout contract, with real files ---

const runGuard = (payload) =>
  execFileSync('node', [GUARD], { input: JSON.stringify(payload), encoding: 'utf8' });

// A throwaway repo that uses QA-Pilot, with one feature whose case map owns OWNED.
const qaRepo = ({ map = { 'CHECKOUT-ORDER-001': OWNED } } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-guard-'));
  writeFileSync(join(dir, 'qa-pilot.config.yaml'), 'project: x\n');
  mkdirSync(join(dir, 'testing/checkout'), { recursive: true });
  writeFileSync(join(dir, 'testing/checkout/clickup-map.json'), typeof map === 'string' ? map : JSON.stringify(map));
  return dir;
};
const write = (dir, toolInput) => ({
  hook_event_name: 'PreToolUse', tool_name: SERVER + 'clickup_update_task', tool_input: toolInput, cwd: dir,
});

test('denies over stdin with the documented hookSpecificOutput shape', () => {
  const out = JSON.parse(runGuard(write(qaRepo(), onCase)));
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /video, trace, deploy SHA/);
});

test('allows over stdin, printing nothing, for a task no case map owns', () => {
  assert.equal(runGuard(write(qaRepo(), { task_id: OTHER, status: 'Done' })).trim(), '');
});

test('allows over stdin, printing nothing, in a repo without a host profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-guard-'));
  assert.equal(runGuard(write(dir, onCase)).trim(), '');
});

test('allows over stdin once the flag file exists, and prints nothing', () => {
  const dir = qaRepo();
  mkdirSync(join(dir, '.qa-pilot'), { recursive: true });
  writeFileSync(join(dir, '.qa-pilot/allow-clickup-writes'), '');
  assert.equal(runGuard(write(dir, onCase)).trim(), '');
});

test('a malformed case map is skipped, not fatal, and the others still count', () => {
  const dir = qaRepo({ map: '{ not json' });
  assert.equal(runGuard(write(dir, onCase)).trim(), '', 'the only map is unreadable: nothing is owned');
  mkdirSync(join(dir, 'testing/login'), { recursive: true });
  writeFileSync(join(dir, 'testing/login/clickup-map.json'), JSON.stringify({ 'LOGIN-001': OWNED }));
  assert.match(runGuard(write(dir, onCase)), /"deny"/, 'a readable map elsewhere still owns the task');
});

test('the CLI reads the configured profile path from the plugin option variable', () => {
  // Claude Code exports each plugin userConfig option to hooks as CLAUDE_PLUGIN_OPTION_<KEY>.
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-guard-'));
  writeFileSync(join(dir, 'custom-qa.yaml'), 'project: x\n');
  mkdirSync(join(dir, 'testing/checkout'), { recursive: true });
  writeFileSync(join(dir, 'testing/checkout/clickup-map.json'), JSON.stringify({ 'CHECKOUT-ORDER-001': OWNED }));
  const payload = JSON.stringify(write(dir, onCase));
  const run = (env) => execFileSync('node', [GUARD], { input: payload, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(run({ CLAUDE_PLUGIN_OPTION_PROFILE_PATH: 'custom-qa.yaml' }), /"deny"/);
  assert.equal(run({ CLAUDE_PLUGIN_OPTION_PROFILE_PATH: '' }).trim(), '', 'unset means the default name, absent here');
});

test('a malformed payload exits cleanly instead of blocking the session', () => {
  const out = execFileSync('node', [GUARD], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(out.trim(), '');
});
