#!/usr/bin/env node
// PreToolUse guard: ClickUp writes may only happen inside a QA-Pilot skill's write phase.
//
// The point is not to stop anyone from using ClickUp. It is that the QA record's write
// path has to be the scripted, validated one. Otherwise "just mark that case passed"
// puts an unevidenced verdict in the record with the same authority as an evidenced one.
//
// Skills that legitimately write create .qa-pilot/allow-clickup-writes immediately before
// their write phase and remove it after.
//
// ponytail: flag-file scoping, not QA-space scoping, since checking the target space would
// need an authenticated API call from inside a hook. Upgrade if non-QA ClickUp writes get annoying.

import { statSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
import { join } from 'node:path';

const FLAG = '.qa-pilot/allow-clickup-writes';

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

/**
 * @param {{tool_name?: string, cwd?: string}} input PreToolUse payload
 * @param {(p: string) => {mtimeMs: number}} stat
 * @returns {null | {reason: string}} null === allow
 */
export function decide(input, stat = statSync) {
  const tool = input?.tool_name ?? '';
  if (!/clickup/i.test(tool)) return null;          // not ours to police
  if (READ_VERBS.has(leadingVerb(tool))) return null;
  if (flagIsLive(join(input?.cwd ?? process.cwd(), FLAG), stat)) return null;
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
  const verdict = decide(input);
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
