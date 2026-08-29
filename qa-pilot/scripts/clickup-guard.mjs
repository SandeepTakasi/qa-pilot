#!/usr/bin/env node
// PreToolUse guard: ClickUp writes may only happen inside a QA-Pilot skill's write phase.
//
// The point is not to stop anyone from using ClickUp. It is that the QA record's write
// path has to be the scripted, validated one — otherwise "just mark that case passed"
// puts an unevidenced verdict in the record with the same authority as an evidenced one.
//
// Skills that legitimately write create .qa-pilot/allow-clickup-writes immediately before
// their write phase and remove it after.
//
// ponytail: flag-file scoping, not QA-space scoping — checking the target space would need
// an authenticated API call from inside a hook. Upgrade if non-QA ClickUp writes get annoying.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FLAG = '.qa-pilot/allow-clickup-writes';

// Reads are always fine; only state changes need the scripted path.
const READ_ONLY = /(^|_)(get|list|search|filter|find|resolve|download|read)(_|$)/;

const DENY_REASON =
  'QA-Pilot: ClickUp writes are restricted to the QA-Pilot publish path.\n' +
  'Verdicts enter the record through /qa-pilot:publish-results, which validates evidence ' +
  '(video, trace, deploy SHA) before anything is written — a verdict written by hand skips that check.\n' +
  'Use /qa-pilot:publish-results to publish a run, or /qa-pilot:qa-review to record a review decision.\n' +
  'For a deliberate one-off write outside those flows, the user can create the flag file: ' +
  'mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes';

/**
 * @param {{tool_name?: string, cwd?: string}} input PreToolUse payload
 * @param {(p: string) => boolean} exists
 * @returns {null | {reason: string}} null === allow
 */
export function decide(input, exists = existsSync) {
  const tool = input?.tool_name ?? '';
  if (!/clickup/i.test(tool)) return null;          // not ours to police
  // Test only the tool segment. MCP names are mcp__<server>__<tool>, and a server name
  // containing "list" or "get" must not make its write tools look read-only.
  const segments = tool.split('__');
  const toolPart = segments.length > 1 ? segments[segments.length - 1] : tool;
  if (READ_ONLY.test(toolPart)) return null;
  if (exists(join(input?.cwd ?? process.cwd(), FLAG))) return null;
  return { reason: DENY_REASON };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
