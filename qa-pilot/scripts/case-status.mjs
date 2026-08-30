#!/usr/bin/env node
// Decide what a feature's ClickUp statuses mean: which cases may execute, which are held
// back and why, and what the confidence score is.
//
// The model fetches statuses over MCP and writes them to a JSON file; this script decides
// what they mean. Weighted arithmetic across 25 cases is not a thing to do by hand, and
// three skills reading the same rule from prose would drift.
//
// Usage: node case-status.mjs --cases <cases.yaml> --statuses <statuses.json>
//                             [--profile <qa-pilot.config.yaml>] [--include-quarantined]
//   statuses.json: { "<CASE-ID>": "<ClickUp status>", ... }
//
// Pass --profile so the host's own status names are used. Without it the canonical names
// apply, which is only right for a host that happens to use them.

import { readFileSync } from 'node:fs';
import { parse } from './lib/yaml.mjs';
import { isMain } from './lib/is-main.mjs';
import { loadProfile } from './lib/profile.mjs';
import {
  DEFAULT_STATUSES, EXECUTABLE_KEYS, HELD_REASONS, VERDICT_APPROVED_KEYS,
  statusLookup, displayName,
} from './lib/statuses.mjs';

export { DEFAULT_STATUSES } from './lib/statuses.mjs';

const WEIGHT = { P0: 3, P1: 2, P2: 1 };

/**
 * Confidence for a feature, per the PRD weighting.
 * Any P0 without an accepted verdict forces "Not Ready" regardless of the score,
 * because a high percentage must never speak louder than an unproven critical case.
 */
export function confidence(cases, priorities) {
  let earned = 0, total = 0;
  let p0Unapproved = false;
  for (const c of cases) {
    const w = WEIGHT[priorities[c.id]] ?? 1;
    total += w;
    if (c.approved) earned += w;
    else if (priorities[c.id] === 'P0') p0Unapproved = true;
  }
  const score = total === 0 ? 0 : earned / total;
  return { score, ready: !p0Unapproved, label: p0Unapproved ? 'Not Ready' : `${Math.round(score * 100)}%` };
}

/**
 * @param {Array<{id: string, priority: string}>} cases from cases.yaml
 * @param {Record<string,string>} statuses case id -> the status ClickUp reports
 * @param {{includeQuarantined?: boolean, statusNames?: Record<string,string>}} opts
 *   statusNames: the host's names per lifecycle key, from profile clickup.statuses
 * @returns partition + confidence
 */
export function partitionCases(cases, statuses, { includeQuarantined = false, statusNames = DEFAULT_STATUSES } = {}) {
  const executable = [];
  const held = [];
  const quarantined = [];
  const unsynced = [];
  const unknownStatus = [];
  const awaitingReview = [];

  // The host names its own statuses; the pipeline reasons in lifecycle keys.
  const lookup = statusLookup(statusNames);
  const keyFor = (status) => lookup.get(String(status).trim().toLowerCase());

  for (const c of cases) {
    const status = statuses[c.id];
    if (status === undefined) {
      unsynced.push({ id: c.id, priority: c.priority });
      continue;
    }
    const key = keyFor(status);
    if (!key) {
      // A status the profile does not declare is not something to guess at.
      unknownStatus.push({ id: c.id, status });
      continue;
    }
    if (key === 'quarantined') {
      quarantined.push({ id: c.id, priority: c.priority });
      if (includeQuarantined) executable.push({ id: c.id, priority: c.priority, status, state: key });
      continue;
    }
    if (EXECUTABLE_KEYS.has(key)) {
      executable.push({ id: c.id, priority: c.priority, status, state: key });
      if (key === 'under_review') awaitingReview.push(c.id);
      continue;
    }
    held.push({
      id: c.id, priority: c.priority, status, state: key,
      reason: HELD_REASONS[key] ?? 'not an executable state',
    });
  }

  const orphaned = Object.keys(statuses).filter((id) => !cases.some((c) => c.id === id));

  const priorities = Object.fromEntries(cases.map((c) => [c.id, c.priority]));
  const scored = cases.map((c) => ({
    id: c.id,
    approved: VERDICT_APPROVED_KEYS.has(keyFor(statuses[c.id])),
  }));

  const warnings = [];
  if (awaitingReview.length) {
    warnings.push(`${awaitingReview.length} case(s) are still "${displayName(statusNames, 'under_review')}" from a previous run; re-running replaces evidence QA has not looked at yet`);
  }
  if (quarantined.length && !includeQuarantined) {
    warnings.push(`${quarantined.length} quarantined case(s) excluded. Pass --include-quarantined to run them while hardening.`);
  }
  if (unsynced.length) {
    warnings.push(`${unsynced.length} case(s) have no ClickUp status; run /qa-pilot:generate-tests to sync them`);
  }
  if (orphaned.length) {
    warnings.push(`${orphaned.length} ClickUp task(s) map to case ids absent from cases.yaml: ${orphaned.join(', ')}`);
  }
  if (unknownStatus.length) {
    const declared = Object.values(statusNames).filter(Boolean).join(', ');
    warnings.push(
      `${unknownStatus.length} case(s) carry a status the profile does not declare: ` +
      `${unknownStatus.map((u) => `${u.id}="${u.status}"`).join(', ')}. ` +
      `Declared in clickup.statuses: ${declared}. ` +
      `If ClickUp is right, fix the names in the profile rather than renaming statuses in ClickUp.`
    );
  }

  return {
    executable,
    held,
    quarantined,
    unsynced,
    unknown_status: unknownStatus,
    orphaned,
    awaiting_review: awaitingReview,
    confidence: confidence(scored, priorities),
    counts: {
      total: cases.length,
      executable: executable.length,
      held: held.length,
      quarantined: quarantined.length,
      approved: scored.filter((s) => s.approved).length,
    },
    warnings,
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

if (isMain(import.meta.url)) {
  const casesPath = argValue('--cases');
  const statusesPath = argValue('--statuses');
  const profilePath = argValue('--profile');
  if (!casesPath || !statusesPath) {
    console.error('usage: node case-status.mjs --cases <cases.yaml> --statuses <statuses.json> [--profile <qa-pilot.config.yaml>] [--include-quarantined]');
    process.exit(2);
  }
  try {
    const doc = parse(readFileSync(casesPath, 'utf8'));
    if (!Array.isArray(doc?.cases)) throw new Error(`no cases[] in ${casesPath}`);
    const statuses = JSON.parse(readFileSync(statusesPath, 'utf8'));
    // Without a profile the canonical names apply, which is right only for a host that
    // happens to use them, so say so rather than failing silently against the wrong names.
    let statusNames = DEFAULT_STATUSES;
    if (profilePath) {
      statusNames = loadProfile(profilePath).profile.clickup?.statuses ?? DEFAULT_STATUSES;
    } else {
      console.error('warning: no --profile given, so the canonical status names are assumed; pass --profile to use this host\'s names');
    }
    const out = partitionCases(doc.cases, statuses, {
      statusNames,
      includeQuarantined: process.argv.includes('--include-quarantined'),
    });
    for (const w of out.warnings) console.error(`warning: ${w}`);
    console.log(JSON.stringify(out, null, 2));
    // Nothing eligible is a stop condition, not an empty success.
    if (out.executable.length === 0) {
      console.error('no case is currently executable; see held[] above');
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
