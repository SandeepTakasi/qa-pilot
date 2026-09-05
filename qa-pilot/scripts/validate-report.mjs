#!/usr/bin/env node
// The publish gate. A report that fails here does not reach ClickUp, which is why QA
// never has to police formatting, and why a Pass without evidence cannot enter the record.
//
// Usage: node validate-report.mjs <report.json> --profile <config.yaml> \
//          --statuses <statuses.json> [--map <clickup-map.json>] [--base <dir>]

import { readFileSync, statSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { loadProfile } from './lib/profile.mjs';
import { EXECUTABLE_KEYS, DEFAULT_STATUSES, statusLookup } from './lib/statuses.mjs';

const VERDICTS = ['pass', 'fail', 'flaky', 'blocked'];
const BLOCKED_HALT_RATIO = 0.1;

// Which verdicts must carry a trace, given what the host chose to capture. `blocked` never
// appears: those cases did not execute. Capturing a trace roughly doubles a run, so a host
// may keep evidence only for failures, at the cost of QA no longer being able to sample
// passes. The gate enforces the host's declared choice rather than guessing.
const EVIDENCE_BY_MODE = {
  always: ['pass', 'fail', 'flaky'],
  'on-failure': ['fail', 'flaky'],
  off: [],
};

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @returns {{ errors: string[], warnings: string[] }} errors non-empty === do not publish
 */
export function validateReport(report, profile, { map = null, base = null, stat = statSync, statuses = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  // Evidence is checked on disk, always. `base` only resolves relative paths (real
  // Playwright reports carry absolute ones); it is never an opt-out from checking.
  // A zero-byte artifact is a broken artifact: a crashed browser writes an empty video.
  const artifactProblem = (p) => {
    const full = isAbsolute(p) ? p : resolve(base ?? process.cwd(), p);
    let s;
    try {
      s = stat(full);
    } catch {
      return 'does not exist on disk';
    }
    if (!s.isFile?.() && s.size === undefined) return 'is not a file';
    return s.size === 0 ? 'is empty (0 bytes): the artifact was not written' : null;
  };

  if (!report || typeof report !== 'object') return { errors: ['report: must be a JSON object'], warnings };

  const capture = report.evidence_capture ?? 'always';
  if (!Object.hasOwn(EVIDENCE_BY_MODE, capture)) {
    err(`evidence_capture: "${capture}" is not one of ${Object.keys(EVIDENCE_BY_MODE).join(' | ')}`);
  }
  if (capture === 'off') {
    err('evidence_capture: off. This run captured no evidence, so none of its verdicts can be published. That mode is for iterating on specs locally.');
  }
  const required = EVIDENCE_BY_MODE[capture] ?? EVIDENCE_BY_MODE.always;
  const needsEvidence = (verdict) => required.includes(verdict);
  if (capture === 'on-failure') {
    warnings.push('evidence_capture: on-failure, so passing cases carry no trace and QA cannot sample them. A false pass in this run is undetectable by review.');
  }

  // --- provenance ---
  for (const f of ['run_id', 'feature', 'app', 'env_name', 'executor', 'model_version']) {
    if (!isStr(report[f])) err(`${f}: required`);
  }

  const envs = profile.environments ?? {};
  if (!isStr(report.env_name)) {
    // already reported
  } else if (!envs[report.env_name]) {
    err(`env_name: "${report.env_name}" is not a registered environment (${Object.keys(envs).join(', ') || 'none'}). Verdicts are only valid against registered deployed environments.`);
  } else if (!isStr(report.env_url)) {
    // Optional would mean a report can dodge the registry cross-check by omitting it.
    err('env_url: required. Without it the registered-URL check cannot run.');
  } else if (isStr(report.app)) {
    const registered = envs[report.env_name].apps?.[report.app];
    if (registered && report.env_url.replace(/\/$/, '') !== registered.replace(/\/$/, '')) {
      err(`env_url: "${report.env_url}" does not match the registered URL for ${report.app} in ${report.env_name} ("${registered}")`);
    }
  }

  if (!isStr(report.commit_sha)) {
    err('commit_sha: required. A run with no build identity cannot be published.');
  }
  if (!isStr(report.sha_source)) {
    err('sha_source: required. The SHA must be read from the environment, not asserted by the executor.');
  }
  // Recomputed, never trusted: the gate holds both SHAs, and not trusting the file it is
  // handed is the entire point of the gate.
  const shaMismatch = isStr(report.sha_before) && isStr(report.sha_after)
    && report.sha_before !== report.sha_after;
  if (shaMismatch) {
    const nonBlocked = (report.cases ?? []).filter((c) => c.verdict !== 'blocked');
    if (nonBlocked.length) {
      err(`sha_mismatch: the deployed build changed mid-run (${report.sha_before} -> ${report.sha_after}) but ${nonBlocked.length} case(s) still carry a verdict; every case must be blocked`);
    }
  }
  if (report.sha_mismatch !== undefined && report.sha_mismatch !== shaMismatch) {
    err(`sha_mismatch: report says ${report.sha_mismatch} but sha_before/sha_after say ${shaMismatch}`);
  }

  // --- sandbox runs are never verdict-eligible ---
  const sandboxValue = profile.sandbox?.mode?.value;
  if (isStr(report.api_mode) && sandboxValue && report.api_mode === sandboxValue) {
    err(`api_mode: "${report.api_mode}" is this host's sandbox mode. Sandbox backends are seeded and always succeed, so their results are structurally false passes and cannot be published.`);
  } else if (!isStr(report.api_mode)) {
    err('api_mode: required. Sandbox and deployed runs must be distinguishable in the record.');
  }

  // --- cases ---
  const cases = report.cases;
  // A host declaring `evidence.extra: [console_log]` is satisfied by the trace: Playwright
  // records console output into it automatically, so requiring the trace requires the
  // console. There is no separate console gate to enforce.
  if (!Array.isArray(cases) || cases.length === 0) {
    err('cases: required, at least one case');
  } else {
    const seen = new Set();
    for (const c of cases) {
      const at = `cases[${c?.id ?? '?'}]`;
      if (!c || typeof c !== 'object') { err(`${at}: must be an object`); continue; }
      if (!isStr(c.id)) { err(`${at}.id: required`); continue; }
      if (seen.has(c.id)) err(`${at}.id: duplicate`);
      seen.add(c.id);

      if (!VERDICTS.includes(c.verdict)) {
        err(`${at}.verdict: "${c.verdict}" is not one of ${VERDICTS.join(' | ')}`);
        continue;
      }

      if (map && !Object.hasOwn(map, c.id)) {
        err(`${at}: not in the case map, so it was never synced to the tracker`);
      }
      // Map membership only proves a task exists; every generated case is in the map from
      // the moment it is created. Approval is a STATUS, so check the status.
      if (statuses) {
        const key = statusLookup(profile.clickup?.statuses ?? DEFAULT_STATUSES)
          .get(String(statuses[c.id] ?? '').trim().toLowerCase());
        if (!key) {
          err(`${at}: no recorded status from the run, so approval cannot be verified. Record statuses.json during /run-tests.`);
        } else if (!EXECUTABLE_KEYS.has(key) && key !== 'quarantined') {
          err(`${at}: was "${statuses[c.id]}" (${key}) when the run happened, which is not an approved state. Only cases QA approved may be published.`);
        }
      }

      if (needsEvidence(c.verdict)) {
        // The trace is the evidence. It carries the video byte-for-byte, the console
        // output, the screenshot film-strip, the DOM snapshots and the network log. It is
        // one file a reviewer opens at trace.playwright.dev, rather than three that
        // split one investigation and store the video twice.
        if (!isStr(c.trace)) {
          err(`${at}.trace: required for a ${c.verdict} verdict. An unevidenced verdict is exactly the unverifiable claim this pipeline exists to prevent.`);
        } else {
          const problem = artifactProblem(c.trace);
          if (problem) err(`${at}.trace: "${c.trace}" ${problem}`);
        }
        // video and console_log are optional carry-throughs: recorded when Playwright
        // wrote them separately, but never a second upload and never a second gate.
        for (const extra of ['video', 'console_log']) {
          const p = c[extra];
          if (!isStr(p) || p.startsWith('inline:')) continue;
          const problem = artifactProblem(p);
          if (problem) err(`${at}.${extra}: "${p}" ${problem}`);
        }
      }

      if (c.verdict === 'fail' && !isStr(c.failure_summary)) {
        err(`${at}.failure_summary: required for a fail verdict. Take it from the Playwright error, never from prose.`);
      }
      if (c.verdict === 'flaky' && (c.retries ?? 0) < 1) {
        err(`${at}: verdict flaky with no retries recorded`);
      }
    }

    // --- summary must match the cases it claims to summarize ---
    if (report.summary && typeof report.summary === 'object') {
      const actual = { pass: 0, fail: 0, flaky: 0, blocked: 0 };
      for (const c of cases) if (VERDICTS.includes(c.verdict)) actual[c.verdict]++;
      for (const v of VERDICTS) {
        if ((report.summary[v] ?? 0) !== actual[v]) {
          err(`summary.${v}: says ${report.summary[v] ?? 0} but ${actual[v]} case(s) have that verdict`);
        }
      }
    } else {
      err('summary: required');
    }

    // --- run-level halt ---
    const blocked = cases.filter((c) => c.verdict === 'blocked').length;
    if (blocked / cases.length > BLOCKED_HALT_RATIO) {
      err(`RUN HALTED: ${blocked} of ${cases.length} cases are blocked (over ${BLOCKED_HALT_RATIO * 100}%). The environment failed, not the feature; fix it and re-run rather than publishing.`);
    }

    if (Array.isArray(report.unmapped_specs) && report.unmapped_specs.length) {
      warnings.push(`${report.unmapped_specs.length} spec(s) ran without a case-ID prefix and are absent from this report`);
    }
    const flaky = cases.filter((c) => c.verdict === 'flaky').length;
    if (flaky) warnings.push(`${flaky} flaky case(s): quarantine them; they stay in the confidence denominator.`);
  }

  return { errors, warnings };
}

// The confidence score lives in case-status.mjs, where the ClickUp statuses it depends on
// are already in hand.

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

if (isMain(import.meta.url)) {
  const reportPath = process.argv[2];
  const profilePath = argValue('--profile');
  if (!reportPath || !profilePath) {
    console.error('usage: node validate-report.mjs <report.json> --profile <config.yaml> --statuses <statuses.json> [--map <clickup-map.json>] [--base <dir>]');
    process.exit(2);
  }
  try {
    const { profile } = loadProfile(profilePath);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const mapPath = argValue('--map');
    const map = mapPath ? JSON.parse(readFileSync(mapPath, 'utf8')) : null;
    const statusesPath = argValue('--statuses');
    if (!statusesPath) {
      // Not a warning. Approval is the gate's whole purpose, and a gate that can be
      // skipped by leaving off a flag is one that gets skipped.
      console.error('REFUSED: --statuses is required. It is the statuses.json recorded at the start of the run, and it is what proves each case was approved. Without it the gate cannot tell an approved case from an unapproved one.');
      process.exit(1);
    }
    const statuses = JSON.parse(readFileSync(statusesPath, 'utf8'));
    // Relative artifact paths resolve against the report's own directory unless told
    // otherwise. Never null: evidence is always checked on disk.
    const base = argValue('--base') ?? dirname(resolve(reportPath));
    const { errors, warnings } = validateReport(report, profile, { map, base, statuses });
    for (const w of warnings) console.error(`warning: ${w}`);
    if (errors.length) {
      console.error(`REFUSED. This report cannot be published: ${reportPath}`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    const s = report.summary;
    console.log(`ok: ${report.cases.length} cases (${s.pass} pass, ${s.fail} fail, ${s.flaky} flaky, ${s.blocked} blocked) on ${report.env_name} @ ${report.commit_sha}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
