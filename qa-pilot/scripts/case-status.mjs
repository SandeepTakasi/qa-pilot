#!/usr/bin/env node
// Decide what a feature's ClickUp statuses mean: which cases may execute, which are held
// back and why, and what the confidence score is.
//
// The model fetches statuses over MCP and writes them to a JSON file; this script decides
// what they mean. Weighted arithmetic across 25 cases is not a thing to do by hand, and
// three skills reading the same rule from prose would drift.
//
// Usage: node case-status.mjs --cases <cases.yaml> --statuses <statuses.json>
//                             [--include-quarantined]
//   statuses.json: { "<CASE-ID>": "<ClickUp status>", ... }

import { readFileSync } from 'node:fs';
import { parse } from './lib/yaml.mjs';
import { isMain } from './lib/is-main.mjs';

/** The canonical lifecycle. One definition so the skills cannot disagree. */
export const STATUS = {
  CASE_REVIEW: 'Case Review',
  APPROVED_FOR_EXECUTION: 'Approved for Execution',
  UNDER_REVIEW: 'Under Review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RETEST: 'Retest',
  QUARANTINED: 'Quarantined',
};

// Design approval PERSISTS across runs. A case QA approved stays executable so the next
// build regresses it — that is the whole CI story, and without it the pipeline runs
// exactly once per feature and then deadlocks with nothing eligible.
const EXECUTABLE = new Set([
  STATUS.APPROVED_FOR_EXECUTION, // approved, never run
  STATUS.APPROVED,               // approved, last verdict accepted — re-run on a new build
  STATUS.RETEST,                 // QA or CI explicitly asked for another run
  STATUS.UNDER_REVIEW,           // last result not yet reviewed; a newer build supersedes it
]);

const HELD_BACK = {
  [STATUS.CASE_REVIEW]: 'awaiting QA design review — nothing executes before approval',
  [STATUS.REJECTED]: 'QA rejected the case itself; fix it via /qa-pilot:generate-tests, which returns it to Case Review for re-approval',
};

// Only an accepted verdict counts toward confidence. "Approved for Execution" is design
// approval, not a trusted result.
const VERDICT_APPROVED = new Set([STATUS.APPROVED]);

const WEIGHT = { P0: 3, P1: 2, P2: 1 };

/**
 * Confidence for a feature, per the PRD weighting.
 * Any P0 without an accepted verdict forces "Not Ready" regardless of the score —
 * a high percentage must never speak louder than an unproven critical case.
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
 * @param {Record<string,string>} statuses case id -> ClickUp status
 * @returns partition + confidence
 */
export function partitionCases(cases, statuses, { includeQuarantined = false } = {}) {
  const executable = [];
  const held = [];
  const quarantined = [];
  const unsynced = [];
  const unknownStatus = [];
  const awaitingReview = [];

  const known = new Set(Object.values(STATUS));

  for (const c of cases) {
    const status = statuses[c.id];
    if (status === undefined) {
      unsynced.push({ id: c.id, priority: c.priority });
      continue;
    }
    if (!known.has(status)) {
      // A renamed or hand-made status is not something to guess at.
      unknownStatus.push({ id: c.id, status });
      continue;
    }
    if (status === STATUS.QUARANTINED) {
      quarantined.push({ id: c.id, priority: c.priority });
      if (includeQuarantined) executable.push({ id: c.id, priority: c.priority, status });
      continue;
    }
    if (EXECUTABLE.has(status)) {
      executable.push({ id: c.id, priority: c.priority, status });
      if (status === STATUS.UNDER_REVIEW) awaitingReview.push(c.id);
      continue;
    }
    held.push({ id: c.id, priority: c.priority, status, reason: HELD_BACK[status] ?? 'not an executable status' });
  }

  const orphaned = Object.keys(statuses).filter((id) => !cases.some((c) => c.id === id));

  const priorities = Object.fromEntries(cases.map((c) => [c.id, c.priority]));
  const scored = cases.map((c) => ({ id: c.id, approved: VERDICT_APPROVED.has(statuses[c.id]) }));

  const warnings = [];
  if (awaitingReview.length) {
    warnings.push(`${awaitingReview.length} case(s) are still Under Review from a previous run; re-running replaces evidence QA has not looked at yet`);
  }
  if (quarantined.length && !includeQuarantined) {
    warnings.push(`${quarantined.length} quarantined case(s) excluded — pass --include-quarantined to run them while hardening`);
  }
  if (unsynced.length) {
    warnings.push(`${unsynced.length} case(s) have no ClickUp status; run /qa-pilot:generate-tests to sync them`);
  }
  if (orphaned.length) {
    warnings.push(`${orphaned.length} ClickUp task(s) map to case ids absent from cases.yaml: ${orphaned.join(', ')}`);
  }
  if (unknownStatus.length) {
    warnings.push(`${unknownStatus.length} case(s) carry a status outside the lifecycle: ${unknownStatus.map((u) => `${u.id}=${u.status}`).join(', ')}`);
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
  if (!casesPath || !statusesPath) {
    console.error('usage: node case-status.mjs --cases <cases.yaml> --statuses <statuses.json> [--include-quarantined]');
    process.exit(2);
  }
  try {
    const doc = parse(readFileSync(casesPath, 'utf8'));
    if (!Array.isArray(doc?.cases)) throw new Error(`no cases[] in ${casesPath}`);
    const statuses = JSON.parse(readFileSync(statusesPath, 'utf8'));
    const out = partitionCases(doc.cases, statuses, {
      includeQuarantined: process.argv.includes('--include-quarantined'),
    });
    for (const w of out.warnings) console.error(`warning: ${w}`);
    console.log(JSON.stringify(out, null, 2));
    // Nothing eligible is a stop condition, not an empty success.
    if (out.executable.length === 0) {
      console.error('no case is currently executable — see held[] above');
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
