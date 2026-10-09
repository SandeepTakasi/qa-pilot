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
//        node case-status.mjs --record-approvals --verdicts <report.json> --approved <approved.json>
//                             --ids <A,B,...>
//   --record-approvals seeds the approval ledger when QA approves (needs no --cases or --statuses):
//   a passing case records the run's spec hash, any other verdict removes the id. It prints
//   { "approved_ledger": { ... } }; a missing approved.json starts a new ledger.
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
import { lintRequirements } from './validate-cases.mjs';
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

  // The P0 veto cannot fire on a feature that has no P0 case, so on its own it would
  // report a feature where every case failed as Ready. `ready` is the field callers act
  // on, so it needs a floor of its own.
  const noP0 = !Object.values(priorities).includes('P0');
  let why;
  if (p0Blocking) why = 'at least one P0 case is not an approved pass';
  else if (score === 0) why = 'no case is an approved pass yet';
  else if (noP0) why = 'this feature has no P0 case, so nothing here can veto a release. Check that the case set is right.';

  const ready = !p0Blocking && score > 0;
  return {
    score, ready,
    label: ready ? `${Math.round(score * 100)}%` : 'Not Ready',
    why,
  };
}

// The requirements block is malformed when the shared lint reports an error on a
// `requirements` path. A `covers` error is a mistake in a case, never in the block.
const blockMalformed = (doc) => lintRequirements(doc).errors.some((e) => e.startsWith('requirements'));

/**
 * Coverage of the declared requirements, or null when there is nothing to report: no
 * `requirements` key, or a malformed block (the lint reports that). Rules and output shape:
 * qa-pilot/schemas/cases.schema.md, "Requirements and coverage". Pure, like confidence().
 *
 * A criterion is, first match wins: uncovered (no case covers it), failing (a covering case
 * failed or was flaky, so another case's pass never hides it), proved (a covering case passed
 * AND QA approved that verdict, the confidence numerator's rule), else unproved. A `covers`
 * that is not a list, or an entry that is not a string or names nothing, is ignored.
 *
 * @param {object} doc parsed cases.yaml
 * @param {Record<string,string>} statuses case id -> the status ClickUp reports
 * @param {Record<string,string>} verdicts case id -> pass|fail|flaky|blocked
 * @param {Record<string,string>} statusNames the host's names per lifecycle key
 */
export function requirementCoverage(doc, statuses, verdicts, statusNames = DEFAULT_STATUSES) {
  if (doc?.requirements === undefined || blockMalformed(doc)) return null;
  const lookup = statusLookup(statusNames);
  const keyFor = (status) => lookup.get(String(status).trim().toLowerCase());
  const byRef = new Map();
  const by_requirement = doc.requirements.map((r) => ({
    id: r.id,
    criteria: r.criteria.map((c) => {
      const entry = { id: c.id, state: 'uncovered', cases: [] };
      byRef.set(`${r.id}/${c.id}`, entry);   // ids cannot contain '/', so a ref is unambiguous
      return entry;
    }),
  }));
  for (const c of Array.isArray(doc.cases) ? doc.cases : []) {
    if (typeof c?.id !== 'string' || !Array.isArray(c.covers)) continue;
    for (const ref of c.covers) {
      const entry = typeof ref === 'string' ? byRef.get(ref) : undefined;
      if (entry && !entry.cases.includes(c.id)) entry.cases.push(c.id);
    }
  }
  const count = { proved: 0, failing: 0, unproved: 0, uncovered: 0 };
  const verdictOf = (id) => verdicts?.[id];
  for (const entry of byRef.values()) {
    if (entry.cases.length === 0) entry.state = 'uncovered';
    else if (entry.cases.some((id) => ['fail', 'flaky'].includes(verdictOf(id)))) entry.state = 'failing';
    else if (entry.cases.some((id) => verdictOf(id) === 'pass' && VERDICT_APPROVED_KEYS.has(keyFor(statuses?.[id])))) entry.state = 'proved';
    else entry.state = 'unproved';
    count[entry.state]++;
  }
  return { criteria_total: byRef.size, ...count, by_requirement };
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
 * The ledger after QA approves `ids` at result review: the first entry for a case, and the
 * only place one is written. publishTransitions can keep an entry but never creates it, so
 * without this no approval carries forward and CI selects nothing.
 *
 * A passing verdict records the run's spec hash. Any other verdict removes the id: approving
 * a confirmed failure records that QA agreed the feature is broken, which is not a baseline
 * a later run should be compared with. Pure; `ledger` is never mutated.
 *
 * @param {{cases: Array<{id: string, verdict: string, spec_sha?: string}>}} report a report.json
 * @param {Record<string,string>} ledger case id -> approved spec hash
 * @param {string[]} ids the cases QA just approved
 */
export function recordApprovals(report, ledger, ids) {
  const byId = new Map(report.cases.map((c) => [c.id, c]));
  const next = { ...ledger };
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) throw new Error(`record-approvals: ${id} is not in the report`);
    if (c.verdict !== 'pass') delete next[id];
    else if (!c.spec_sha) throw new Error(`record-approvals: ${id} has no spec_sha in the report`);
    else next[id] = c.spec_sha;
  }
  return next;
}

/**
 * @param {Array<{id: string, priority: string}>} cases from cases.yaml
 * @param {Record<string,string>} statuses case id -> the status ClickUp reports
 * @param {{includeQuarantined?: boolean, statusNames?: Record<string,string>,
 *           verdicts?: Record<string,string>, doc?: object}} opts
 *   statusNames: the host's names per lifecycle key, from profile clickup.statuses
 *   verdicts: case id -> pass|fail|flaky|blocked from the latest published run.
 *             Without it the confidence score reports Unknown rather than a number,
 *             because approval alone does not mean the case passed.
 *   doc: the parsed cases.yaml; when it declares requirements the output gains `requirements`
 * @returns partition + confidence
 */
export function partitionCases(cases, statuses, { includeQuarantined = false, statusNames = DEFAULT_STATUSES, verdicts = {}, doc } = {}) {
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

  const requirements = requirementCoverage(doc, statuses, verdicts, statusNames);
  if (doc?.requirements !== undefined && !requirements) {
    warnings.push('requirements has lint errors, so requirement coverage is omitted; run validate-cases.mjs');
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
    ...(requirements && { requirements }),
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

if (isMain(import.meta.url) && process.argv.includes('--record-approvals')) {
  // Handled before the --cases/--statuses guard: seeding the ledger needs only a report.
  try {
    const verdictsPath = argValue('--verdicts');
    if (!verdictsPath) throw new Error('--record-approvals needs --verdicts <report.json>');
    const idsArg = argValue('--ids');
    if (!idsArg) throw new Error('--record-approvals needs --ids <A,B>');
    const report = JSON.parse(readFileSync(verdictsPath, 'utf8'));
    if (!Array.isArray(report?.cases)) throw new Error(`no cases[] in ${verdictsPath}`);
    const ledgerPath = argValue('--approved');
    let ledger = {};
    if (ledgerPath) {
      // Only a missing file starts a new ledger; a corrupt one would silently drop every
      // earlier approval, so it is refused.
      let raw = null;
      try { raw = readFileSync(ledgerPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (raw === null) console.error(`warning: no approval ledger at ${ledgerPath}; starting a new one`);
      else {
        try { ledger = JSON.parse(raw); } catch { throw new Error(`record-approvals: ${ledgerPath} is not valid JSON; fix or remove it before recording approvals`); }
      }
    } else {
      console.error('warning: no --approved ledger given; starting a new one');
    }
    const ids = idsArg.split(',').map((s) => s.trim()).filter(Boolean);
    console.log(JSON.stringify({ approved_ledger: recordApprovals(report, ledger, ids) }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
} else if (isMain(import.meta.url)) {
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
      statusNames, verdicts, doc,
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
