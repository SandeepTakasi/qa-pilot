#!/usr/bin/env node
// PreToolUse guard: a QA-Pilot case task changes only inside a QA-Pilot skill's write phase.
//
// The point is not to stop anyone from using ClickUp. It is that the QA record's write
// path has to be the scripted, validated one. Otherwise "just mark that case passed"
// puts an unevidenced verdict in the record with the same authority as an evidenced one.
//
// So the guard blocks a ClickUp write only when it names one of QA-Pilot's own case tasks:
// the task IDs recorded in the repo's testing/*/clickup-map.json. Every other ClickUp write
// (bug tickets, comments, uploads, new tasks) passes, in every repo. A repo with no host
// profile is not policed at all.
//
// Skills that legitimately write create .qa-pilot/allow-clickup-writes immediately before
// their write phase and remove it after, next to the host profile (normally the repo root).
//
// ponytail: protects the case tasks, not the lists or folders that hold them; a hand-made task
// in a QA list is not a verdict, and recognising the lists would need an API call from a hook.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const FLAG = '.qa-pilot/allow-clickup-writes';
const DEFAULT_PROFILE = 'qa-pilot.config.yaml'; // plugin.json userConfig.profile_path default

// A skill that dies between creating the flag and removing it would otherwise leave the
// guard open forever, invisibly: .qa-pilot/ is gitignored, so nothing surfaces a stale
// flag. Generous for a 25-case publish; caps the exposure to one window.
const FLAG_TTL_MS = 30 * 60 * 1000;

// Allow-list of leading verbs, deny by default. ClickUp uses "list" as a NOUN in write
// tool names (clickup_create_list, clickup_add_task_to_list), so matching the word
// anywhere lets writes through. Only the verb the name STARTS with is meaningful.
// Deny-by-default also means a ClickUp server that adds a new write tool is covered
// without a code change here.
const READ_VERBS = new Set(['get', 'list', 'search', 'filter', 'find', 'resolve', 'download', 'read']);

const denyReason = (taskId) =>
  `QA-Pilot: task ${taskId} is a QA-Pilot test case, and its record changes only through QA-Pilot.\n` +
  'Verdicts enter the record through /qa-pilot:publish-results, which validates evidence ' +
  '(video, trace, deploy SHA) before anything is written. A verdict written by hand skips that check.\n' +
  'Use /qa-pilot:publish-results to publish a run, or /qa-pilot:qa-review to record a review decision. ' +
  'Other ClickUp tasks are not affected.';

/**
 * Task IDs of QA-Pilot's own case tasks: the values of every testing/<feature>/clickup-map.json
 * ({"CASE-ID": "task-id"}) under the profile's directory. A missing or malformed map owns
 * nothing; it is skipped rather than failing the hook, so one bad file never blocks a session.
 */
export function ownedTaskIds(home) {
  const ids = new Set();
  let features = [];
  try {
    features = readdirSync(join(home, 'testing'), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return ids;
  }
  for (const f of features) {
    try {
      const map = JSON.parse(readFileSync(join(home, 'testing', f.name, 'clickup-map.json'), 'utf8'));
      for (const id of Object.values(map ?? {})) {
        if (typeof id === 'string' && id.trim()) ids.add(id.trim().replace(/^#/, ''));
      }
    } catch {
      // no map for this feature, or an unreadable one
    }
  }
  return ids;
}

/**
 * The first owned task ID named anywhere in a tool's input, or null. Field names differ between
 * ClickUp servers and tools (task_id, taskId, task_ids, links_to, a task URL), so every string
 * in the input is split into whole tokens and each token checked; "#id" and ".../t/id" count.
 */
function namedCaseTask(value, owned) {
  if (owned.size === 0 || value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).split(/[^A-Za-z0-9_-]+/).find((t) => owned.has(t)) ?? null;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) {
      const hit = namedCaseTask(v, owned);
      if (hit) return hit;
    }
  }
  return null;
}

/** The verb a ClickUp tool name starts with: mcp__<server>__clickup_<verb>_<noun>. */
function leadingVerb(toolName) {
  const segments = toolName.split('__');
  const toolPart = segments.length > 1 ? segments[segments.length - 1] : toolName;
  return toolPart.replace(/^clickup_/i, '').split('_')[0].toLowerCase();
}

/** A flag file counts only while it is fresh; see FLAG_TTL_MS. */
function flagIsLive(path, stat) {
  try {
    return Date.now() - stat(path).mtimeMs < FLAG_TTL_MS;
  } catch {
    return false; // missing or unreadable
  }
}

const exists = (path, stat) => {
  try { stat(path); return true; } catch { return false; }
};

/**
 * The directory whose host profile governs this session, or null when the repo does not
 * use QA-Pilot. A relative profile path is looked for from `cwd` upward, stopping at the
 * git root (the first directory holding `.git`); outside a git repo only `cwd` is checked,
 * so a stray profile in a home directory never captures unrelated work.
 */
export function findProfileDir(cwd, profilePath, stat) {
  const dirs = [];
  for (let d = resolve(cwd); ; d = dirname(d)) {
    dirs.push(d);
    if (dirname(d) === d) break;
  }
  const rootAt = dirs.findIndex((d) => exists(join(d, '.git'), stat));
  const searched = rootAt === -1 ? [dirs[0]] : dirs.slice(0, rootAt + 1);
  if (isAbsolute(profilePath)) return exists(profilePath, stat) ? searched[searched.length - 1] : null;
  return searched.find((d) => exists(join(d, profilePath), stat)) ?? null;
}

/**
 * @param {{tool_name?: string, tool_input?: unknown, cwd?: string}} input PreToolUse payload
 * @param {(p: string) => {mtimeMs: number}} stat
 * @param {{profilePath?: string, ownedIds?: (home: string) => Set<string>}} options the plugin's
 *   configured profile path, and the loader of QA-Pilot's case task IDs (injected by tests)
 * @returns {null | {reason: string}} null === allow
 */
export function decide(input, stat = statSync, { profilePath = DEFAULT_PROFILE, ownedIds = ownedTaskIds } = {}) {
  const tool = input?.tool_name ?? '';
  if (!/clickup/i.test(tool)) return null;          // not ours to police
  if (READ_VERBS.has(leadingVerb(tool))) return null;
  // The plugin installs user-scope, so this runs in every repo. Where no host profile
  // exists, ClickUp is someone else's workflow, not a QA record to protect.
  const home = findProfileDir(input?.cwd ?? process.cwd(), profilePath || DEFAULT_PROFILE, stat);
  if (home === null) return null;
  // Only QA-Pilot's own case tasks are the record; a write that names none of them is ordinary work.
  const task = namedCaseTask(input?.tool_input, ownedIds(home));
  if (task === null) return null;
  if (flagIsLive(join(home, FLAG), stat)) return null;
  return { reason: denyReason(task) };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (isMain(import.meta.url)) {
  let input = {};
  try {
    const raw = (await readStdin()).trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    process.exit(0); // Never break a session over a malformed payload.
  }
  // Claude Code exports each plugin userConfig option to hooks as CLAUDE_PLUGIN_OPTION_<KEY>.
  // Whether it passes the declared default when the user set nothing is undocumented, so
  // an empty or missing value falls back to the default name here.
  const verdict = decide(input, statSync, { profilePath: process.env.CLAUDE_PLUGIN_OPTION_PROFILE_PATH || DEFAULT_PROFILE });
  if (verdict) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }));
  }
  process.exit(0);
}
