#!/usr/bin/env node
// The publish gate. A report that fails here does not reach ClickUp — which is why QA
// never has to police formatting, and why a Pass without evidence cannot enter the record.
//
// Usage: node validate-report.mjs <report.json> --profile <config.yaml> \
//          [--map <clickup-map.json>] [--base <dir for relative artifact paths>]

import { readFileSync, statSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { loadProfile } from './lib/profile.mjs';

const VERDICTS = ['pass', 'fail', 'flaky', 'blocked'];
const EVIDENCE_REQUIRED = ['pass', 'fail', 'flaky']; // blocked cases never executed
const BLOCKED_HALT_RATIO = 0.1;

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @returns {{ errors: string[], warnings: string[] }} errors non-empty === do not publish
 */
export function validateReport(report, profile, { map = null, base = null, stat = statSync } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  // Evidence is checked on disk, always. `base` only resolves relative paths (real
  // Playwright reports carry absolute ones); it is never an opt-out from checking.
  // A zero-byte artifact is a broken artifact — a crashed browser writes an empty video.
  const artifactProblem = (p) => {
    const full = isAbsolute(p) ? p : resolve(base ?? process.cwd(), p);
    let s;
    try {
      s = stat(full);
    } catch {
      return 'does not exist on disk';
    }
    if (!s.isFile?.() && s.size === undefined) return 'is not a file';
    return s.size === 0 ? 'is empty (0 bytes) — the artifact was not written' : null;
  };

  if (!report || typeof report !== 'object') return { errors: ['report: must be a JSON object'], warnings };

  // --- provenance ---
  for (const f of ['run_id', 'feature', 'app', 'env_name', 'executor', 'model_version']) {
    if (!isStr(report[f])) err(`${f}: required`);
  }

  const envs = profile.environments ?? {};
  if (!isStr(report.env_name)) {
    // already reported
  } else if (!envs[report.env_name]) {
    err(`env_name: "${report.env_name}" is not a registered environment (${Object.keys(envs).join(', ') || 'none'}) — verdicts are only valid against registered deployed environments`);
  } else if (!isStr(report.env_url)) {
    // Optional would mean a report can dodge the registry cross-check by omitting it.
    err('env_url: required — without it the registered-URL check cannot run');
  } else if (isStr(report.app)) {
    const registered = envs[report.env_name].apps?.[report.app];
    if (registered && report.env_url.replace(/\/$/, '') !== registered.replace(/\/$/, '')) {
      err(`env_url: "${report.env_url}" does not match the registered URL for ${report.app} in ${report.env_name} ("${registered}")`);
    }
  }

  if (!isStr(report.commit_sha)) {
    err('commit_sha: required — a run with no build identity cannot be published');
  }
  if (!isStr(report.sha_source)) {
    err('sha_source: required — the SHA must be read from the environment, not asserted by the executor');
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
    err(`api_mode: "${report.api_mode}" is this host's sandbox mode — sandbox backends are seeded and always succeed, so their results are structurally false passes and cannot be published`);
  } else if (!isStr(report.api_mode)) {
    err('api_mode: required — sandbox and deployed runs must be distinguishable in the record');
  }

  // --- cases ---
  const cases = report.cases;
  const needConsole = (profile.evidence?.extra ?? []).includes('console_log');
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
        err(`${at}: not in the approved case map — only cases QA approved may be published`);
      }

      if (EVIDENCE_REQUIRED.includes(c.verdict)) {
        for (const artifact of ['video', 'trace']) {
          const p = c[artifact];
          if (!isStr(p)) {
            err(`${at}.${artifact}: required for a ${c.verdict} verdict — an unevidenced verdict is exactly the unverifiable claim this pipeline exists to prevent`);
            continue;
          }
          const problem = artifactProblem(p);
          if (problem) err(`${at}.${artifact}: "${p}" ${problem}`);
        }
        if (needConsole) {
          if (!isStr(c.console_log)) {
            err(`${at}.console_log: required for a ${c.verdict} verdict — this host declares console_log evidence because its operations never reach the network tab`);
          } else if (!c.console_log.startsWith('inline:')) {
            const problem = artifactProblem(c.console_log);
            if (problem) err(`${at}.console_log: "${c.console_log}" ${problem}`);
          }
        }
      }

      if (c.verdict === 'fail' && !isStr(c.failure_summary)) {
        err(`${at}.failure_summary: required for a fail verdict — take it from the Playwright error, never from prose`);
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
      err(`RUN HALTED: ${blocked} of ${cases.length} cases are blocked (over ${BLOCKED_HALT_RATIO * 100}%) — the environment failed, not the feature; fix it and re-run rather than publishing`);
    }

    if (Array.isArray(report.unmapped_specs) && report.unmapped_specs.length) {
      warnings.push(`${report.unmapped_specs.length} spec(s) ran without a case-ID prefix and are absent from this report`);
    }
    const flaky = cases.filter((c) => c.verdict === 'flaky').length;
    if (flaky) warnings.push(`${flaky} flaky case(s) — quarantine them; they stay in the confidence denominator`);
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
    console.error('usage: node validate-report.mjs <report.json> --profile <config.yaml> [--map <clickup-map.json>] [--base <dir>]');
    process.exit(2);
  }
  try {
    const { profile } = loadProfile(profilePath);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const mapPath = argValue('--map');
    const map = mapPath ? JSON.parse(readFileSync(mapPath, 'utf8')) : null;
    // Relative artifact paths resolve against the report's own directory unless told
    // otherwise. Never null: evidence is always checked on disk.
    const base = argValue('--base') ?? dirname(resolve(reportPath));
    const { errors, warnings } = validateReport(report, profile, { map, base });
    for (const w of warnings) console.error(`warning: ${w}`);
    if (errors.length) {
      console.error(`REFUSED — this report cannot be published: ${reportPath}`);
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
