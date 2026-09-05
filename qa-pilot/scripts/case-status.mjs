#!/usr/bin/env node
// Decide what a feature's ClickUp statuses mean: which cases may execute, which are held
// back and why, and what the confidence score is.
//
// The model fetches statuses over MCP and writes them to a JSON file; this script decides
// what they mean. Weighted arithmetic across 25 cases is not a thing to do by hand, and
// three skills reading the same rule from prose would drift.
//
// Usage: node case-status.mjs --cases <cases.yaml> --statuses <statuses.json>
//                             [--profile <qa-pilot.config.yaml>] [--verdicts <report.json>]
//                             [--include-quarantined]
//        node case-status.mjs --transitions --cases <cases.yaml> --statuses <statuses.json>
//                             --verdicts <report.json> --approved <approved.json> --profile <p>
//   statuses.json: { "<CASE-ID>": "<ClickUp status>", ... }
//   --verdicts accepts a report.json, or a plain { "<CASE-ID>": "pass|fail|..." } map.
//   Without it the confidence score reads Unknown, since approval alone is not a pass.
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
 * Confidence for a feature.
 *
 * A case counts toward the numerator only when QA accepted its verdict AND that verdict
 * was a pass. Status alone is not enough: qa-review correctly tells QA that a confirmed
 * real failure is a bug rather than a broken test, so the honest path for a failing P0 is
 * to APPROVE the verdict. Counting status alone therefore made a feature read Ready
 * precisely because QA had confirmed its P0s were broken.
 *
 * Verdicts come from the run. Without them the score is unknowable rather than zero, and
 * saying so is better than printing a number that means something else.
 *
 * @param {Array<{id: string, approved: boolean, passed: boolean|null}>} cases
 * @param {Record<string,string>} priorities case id -> P0|P1|P2
 */
export function confidence(cases, priorities) {
  const haveVerdicts = cases.some((c) => c.passed !== null && c.passed !== undefined);
  if (!haveVerdicts) {
    return {
      score: null, ready: false, label: 'Unknown',
      why: 'no verdicts supplied, so nothing has been proved yet. Pass --verdicts once a run has published.',
    };
  }
  let earned = 0, total = 0;
  let p0Blocking = false;
  for (const c of cases) {
    const w = WEIGHT[priorities[c.id]] ?? 1;
    total += w;
    const counts = Boolean(c.approved && c.passed);
    if (counts) earned += w;
    else if (priorities[c.id] === 'P0') p0Blocking = true;
  }
  const score = total === 0 ? 0 : earned / total;
  return {
    score, ready: !p0Blocking,
    label: p0Blocking ? 'Not Ready' : `${Math.round(score * 100)}%`,
    why: p0Blocking ? 'at least one P0 case is not an approved pass' : undefined,
  };
}

// What publishing a run should do to each case's status. Deterministic, because letting a
// model decide would reintroduce exactly the drift the lifecycle exists to prevent.
const TRANSITION_RULES = {
  flaky: 'quarantined',
  fail: 'under_review',
  blocked: null,          // never executed to a verdict; leave the status alone
};

/**
 * Per-case target lifecycle key for a publish.
 *
 * The rule that matters: an unchanged spec passing again on a new build KEEPS its
 * approval. Sending every case back to review on every run means a weekly re-review of
 * the whole suite by one person, which at a few hundred cases guarantees either abandoned
 * regressions or rubber-stamping.
 *
 * "Unchanged" is judged by spec hash. If either the run's hash or the approved hash is
 * missing, the spec is treated as changed, so the conservative path is the default.
 */
export function publishTransitions(cases, statuses, verdicts, {
  statusNames = DEFAULT_STATUSES, specHashes = {}, approvedHashes = {},
} = {}) {
  const lookup = statusLookup(statusNames);
  const keyFor = (status) => lookup.get(String(status).trim().toLowerCase());
  const out = [];
  for (const c of cases) {
    const verdict = verdicts[c.id];
    if (!verdict) continue;                       // not in this run
    const from = keyFor(statuses[c.id]);
    let to;
    let reason;
    if (verdict === 'pass') {
      const wasApproved = from === 'approved';
      const ranHash = specHashes[c.id];
      const okHash = approvedHashes[c.id];
      const specUnchanged = Boolean(ranHash && okHash && ranHash === okHash);
      if (wasApproved && specUnchanged) {
        to = 'approved';
        reason = 'unchanged spec passed again, so the existing approval carries forward';
      } else {
        to = 'under_review';
        reason = wasApproved
          ? 'passed, but the spec changed since QA approved it, so the approval does not carry'
          : 'passed and has not been approved yet';
      }
    } else if (Object.hasOwn(TRANSITION_RULES, verdict)) {
      to = TRANSITION_RULES[verdict];
      reason = verdict === 'flaky'
        ? 'passed only on retry, so it is quarantined for hardening'
        : verdict === 'fail'
          ? 'failed, so QA must look at it'
          : 'blocked, so the status is left alone';
    }
    if (to) out.push({ id: c.id, from: from ?? null, to, verdict, reason });
  }
  return out;
}

/**
 * @param {Array<{id: string, priority: string}>} cases from cases.yaml
 * @param {Record<string,string>} statuses case id -> the status ClickUp reports
 * @param {{includeQuarantined?: boolean, statusNames?: Record<string,string>,
 *           verdicts?: Record<string,string>}} opts
 *   statusNames: the host's names per lifecycle key, from profile clickup.statuses
 *   verdicts: case id -> pass|fail|flaky|blocked from the latest published run.
 *             Without it the confidence score reports Unknown rather than a number,
 *             because approval alone does not mean the case passed.
 * @returns partition + confidence
 */
export function partitionCases(cases, statuses, { includeQuarantined = false, statusNames = DEFAULT_STATUSES, verdicts = {} } = {}) {
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
  const hasVerdicts = Object.keys(verdicts).length > 0;
  const scored = cases.map((c) => ({
    id: c.id,
    approved: VERDICT_APPROVED_KEYS.has(keyFor(statuses[c.id])),
    // null when this case was not in the run, so an absent verdict never counts as a pass.
    passed: hasVerdicts ? verdicts[c.id] === 'pass' : null,
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
    console.error('usage: node case-status.mjs --cases <cases.yaml> --statuses <statuses.json> [--profile <qa-pilot.config.yaml>] [--verdicts <report.json>] [--include-quarantined]');
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
    // A report.json or a bare id->verdict map; both are accepted so a caller can pass
    // whichever it already has to hand.
    let verdicts = {};
    const verdictsPath = argValue('--verdicts');
    if (verdictsPath) {
      const raw = JSON.parse(readFileSync(verdictsPath, 'utf8'));
      verdicts = Array.isArray(raw?.cases)
        ? Object.fromEntries(raw.cases.map((c) => [c.id, c.verdict]))
        : raw;
    }
    // --transitions: what publishing this run should do to each status, and the updated
    // approval ledger. Printed rather than applied, since the writes go over MCP.
    if (process.argv.includes('--transitions')) {
      if (!verdictsPath) throw new Error('--transitions needs --verdicts <report.json>');
      const report = JSON.parse(readFileSync(verdictsPath, 'utf8'));
      const specHashes = Array.isArray(report?.cases)
        ? Object.fromEntries(report.cases.filter((c) => c.spec_sha).map((c) => [c.id, c.spec_sha]))
        : {};
      const ledgerPath = argValue('--approved');
      let approvedHashes = {};
      if (ledgerPath) {
        try { approvedHashes = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
        catch { console.error(`warning: no approval ledger at ${ledgerPath}; every passing case will go back for review`); }
      } else {
        console.error('warning: no --approved ledger given, so no approval can carry forward');
      }
      const transitions = publishTransitions(doc.cases, statuses, verdicts, {
        statusNames, specHashes, approvedHashes,
      });
      // The ledger records the spec hash QA accepted, so a later edit to that spec is
      // detectable. Only cases landing in `approved` belong in it.
      const nextLedger = { ...approvedHashes };
      for (const t of transitions) {
        if (t.to === 'approved' && specHashes[t.id]) nextLedger[t.id] = specHashes[t.id];
        else if (t.to !== 'approved') delete nextLedger[t.id];
      }
      console.log(JSON.stringify({ transitions, approved_ledger: nextLedger }, null, 2));
      process.exit(0);
    }

    const out = partitionCases(doc.cases, statuses, {
      statusNames, verdicts,
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
