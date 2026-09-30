#!/usr/bin/env node
// PreToolUse guard: ClickUp writes may only happen inside a QA-Pilot skill's write phase.
//
// The point is not to stop anyone from using ClickUp. It is that the QA record's write
// path has to be the scripted, validated one. Otherwise "just mark that case passed"
// puts an unevidenced verdict in the record with the same authority as an evidenced one.
//
// Skills that legitimately write create .qa-pilot/allow-clickup-writes immediately before
// their write phase and remove it after, next to the host profile (normally the repo root).
// A repo with no host profile is not policed at all.
//
// ponytail: flag-file scoping, not QA-space scoping, since checking the target space would
// need an authenticated API call from inside a hook. Upgrade if non-QA ClickUp writes get annoying.

import { statSync } from 'node:fs';
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

const DENY_REASON =
  'QA-Pilot: ClickUp writes are restricted to the QA-Pilot publish path.\n' +
  'Verdicts enter the record through /qa-pilot:publish-results, which validates evidence ' +
  '(video, trace, deploy SHA) before anything is written. A verdict written by hand skips that check.\n' +
  'Use /qa-pilot:publish-results to publish a run, or /qa-pilot:qa-review to record a review decision.';

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
 * @param {{tool_name?: string, cwd?: string}} input PreToolUse payload
 * @param {(p: string) => {mtimeMs: number}} stat
 * @param {{profilePath?: string}} options the plugin's configured profile path
 * @returns {null | {reason: string}} null === allow
 */
export function decide(input, stat = statSync, { profilePath = DEFAULT_PROFILE } = {}) {
  const tool = input?.tool_name ?? '';
  if (!/clickup/i.test(tool)) return null;          // not ours to police
  if (READ_VERBS.has(leadingVerb(tool))) return null;
  // The plugin installs user-scope, so this runs in every repo. Where no host profile
  // exists, ClickUp is someone else's workflow, not a QA record to protect.
  const home = findProfileDir(input?.cwd ?? process.cwd(), profilePath || DEFAULT_PROFILE, stat);
  if (home === null) return null;
  if (flagIsLive(join(home, FLAG), stat)) return null;
  return { reason: DENY_REASON };
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
