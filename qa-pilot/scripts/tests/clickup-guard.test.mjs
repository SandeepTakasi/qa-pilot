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
const noFlag = () => false;
const withFlag = () => true;

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

test('read tools are always allowed — the guard polices writes, not ClickUp use', () => {
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

test('a read-only word in the server name does not excuse a write tool', () => {
  // Regression: matching against the whole name let "mcp__list_server__clickup_update_task"
  // pass as read-only because of the server segment.
  for (const t of ['mcp__list_clickup_server__clickup_update_task',
    'mcp__get_clickup__clickup_delete_task', 'mcp__clickup_search_svc__clickup_update_task']) {
    assert.ok(decide({ tool_name: t, cwd: '/repo' }, noFlag), `${t} should have been denied`);
  }
});

// --- end-to-end through the actual stdin/stdout contract ---

const runGuard = (payload) =>
  execFileSync('node', [GUARD], { input: JSON.stringify(payload), encoding: 'utf8' });

test('denies over stdin with the documented hookSpecificOutput shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-guard-'));
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

test('allows over stdin once the flag file exists, and prints nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-guard-'));
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

test('a malformed payload exits cleanly instead of blocking the session', () => {
  const out = execFileSync('node', [GUARD], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(out.trim(), '');
});
