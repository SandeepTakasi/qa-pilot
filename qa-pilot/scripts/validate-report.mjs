#!/usr/bin/env node
// The publish gate. A report that fails here does not reach ClickUp, which is why QA
// never has to police formatting, and why a Pass without evidence cannot enter the record.
//
// Usage: node validate-report.mjs <report.json> --profile <config.yaml> \
//          --statuses <statuses.json> --cases <cases.yaml> [--map <clickup-map.json>] [--base <dir>]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMain } from './lib/is-main.mjs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadProfile, effectiveEvidenceUpload } from './lib/profile.mjs';
import { parse as parseYaml } from './lib/yaml.mjs';
import { EXECUTABLE_KEYS, DEFAULT_STATUSES, statusLookup } from './lib/statuses.mjs';
import { lintMutation } from './validate-cases.mjs';
import { buildReport } from './parse-report.mjs';

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
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const EXECUTED = ['pass', 'fail', 'flaky'];
// A path the tracker may receive, or the gate must sweep, has to stay inside the run dir.
const escapesRunDir = (p) => typeof p !== 'string' || isAbsolute(p) || p.split(/[\\/]/).includes('..');
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * The mutation, fixture and production rules (report schema, "Mutation, fixture and
 * production refusals"). The profile, the cases file and the disk are the sources; the
 * report is only the claim being checked. Each message starts with its rule number.
 */
function validateMutation(report, profile, casesDoc, { base, needsEvidence, artifactProblem }) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const env = profile.environments?.[report.env_name];
  if (!env) return { errors, warnings }; // already refused as unregistered
  const production = env.kind === 'production';

  if (!casesDoc) {
    // The CLI requires --cases everywhere; this keeps a production report from being
    // waved through by a caller that forgot it.
    if (production) err('rule 1: --cases is required. On a production environment the mutation policy can only come from the feature\'s cases.yaml.');
    return { errors, warnings };
  }

  // --- what the profile says, never the report ---
  if (report.env_kind === undefined || report.env_kind === null) {
    err('env_kind: missing; re-run with 0.3.0. A run recorded before environments declared their kind cannot be checked against the production rules.');
  } else if (report.env_kind !== env.kind) {
    err(`env_kind: report says "${report.env_kind}" but the profile declares kind "${env.kind}" for ${report.env_name}`);
  }
  const capture = report.evidence_capture ?? 'always';
  if (production && capture !== 'always') {
    err(`evidence_capture: must be always on a production environment, but the report says "${capture}". The profile requires always there, and the report is not the source.`);
  }
  const upload = env.evidence_upload ?? effectiveEvidenceUpload(env, { tracker: profile.tracker });

  // --- rule 1: the declaration ---
  if (casesDoc.feature !== report.feature) {
    err(`rule 1: the --cases file is for feature "${casesDoc.feature}" but the report is for "${report.feature}"`);
  }
  const lint = lintMutation(casesDoc);
  for (const e of lint.errors) err(`rule 1: the --cases file fails the lint: ${e}`);
  const policy = lint.policy;
  const prefix = policy === 'scoped-write' && typeof casesDoc.mutation?.prefix === 'string' ? casesDoc.mutation.prefix : null;
  // null equals null; a null claim never equals a non-null declaration.
  const same = (claimed, declared) => (claimed ?? null) === declared;
  const show = (v) => JSON.stringify(v ?? null);
  if (!same(report.mutation_policy, policy)) {
    err(`rule 1: report mutation_policy ${show(report.mutation_policy)} does not match the declared "${policy}"`);
  }
  if (!same(report.mutation_prefix, prefix)) {
    err(`rule 1: report mutation_prefix ${show(report.mutation_prefix)} does not match the declared prefix ${show(prefix)}`);
  }
  const cases = Array.isArray(report.cases) ? report.cases.filter(isObj) : [];
  const fixtures = Array.isArray(report.fixtures) ? report.fixtures.filter(isObj) : [];
  const entities = [
    ...cases.map((c) => ({ at: `cases[${c.id}]`, key: `case ${c.id}`, e: c })),
    ...fixtures.map((f) => ({ at: `fixtures[${f.name} ${f.phase}]`, key: `fixture ${f.name} ${f.phase}`, e: f })),
  ];
  for (const { at, e } of entities) {
    const w = e.writes;
    if (!isObj(w)) continue; // a null record is rule 2's business
    if (!same(w.policy, policy) || !same(w.prefix, prefix)) {
      err(`rule 1: ${at}.writes enforced policy ${show(w.policy)} prefix ${show(w.prefix)}, but the cases file declares "${policy}" prefix ${show(prefix)}`);
    }
  }
  if (production && policy === 'unrestricted') {
    err('rule 1: an unrestricted feature cannot publish from a production environment. Declare mutation.policy read-only or scoped-write in cases.yaml.');
  }

  // --- rule 1b: the record on disk ---
  // A record counts only if it parses and its counts agree with its own events.
  const records = new Map();
  const readRecord = (abs) => {
    if (!records.has(abs)) {
      let rec = null;
      try {
        const r = JSON.parse(readFileSync(abs, 'utf8'));
        const count = (a) => (Array.isArray(r.events) ? r.events.filter((x) => x?.action === a).length : -1);
        if (isObj(r) && r.blocked === count('block') && r.observed === count('observe')) rec = r;
      } catch { /* unreadable reads as not installed */ }
      records.set(abs, rec);
    }
    return records.get(abs);
  };
  const listed = [];
  for (const { at, e } of entities) {
    if (!isObj(e.writes)) continue;
    for (const p of Array.isArray(e.writes.paths) ? e.writes.paths : []) {
      if (escapesRunDir(p)) err(`rule 1b: ${at}.writes path "${p}" must be a relative path inside the run directory`);
      else listed.push(resolve(base, p));
    }
  }

  let pw = null;
  try { pw = JSON.parse(readFileSync(join(base, 'results.json'), 'utf8')); } catch {
    err(`rule 1b: results.json is not readable in the run directory (${base}), so attempts and write records cannot be recounted`);
  }
  if (pw) {
    const writesFiles = {};
    const walk = (suites) => (suites ?? []).flatMap((s) => [...(s.specs ?? []), ...walk(s.suites)]);
    for (const spec of walk(pw.suites)) {
      for (const r of (spec.tests ?? []).flatMap((t) => t.results ?? [])) {
        for (const a of r.attachments ?? []) {
          if (a.name !== 'writes.json' || !a.path) continue;
          const rec = readRecord(resolve(base, a.path));
          if (rec) writesFiles[a.path] = rec;
        }
      }
    }
    const rebuilt = buildReport(pw, { sha_before: report.sha_before, sha_after: report.sha_after }, { runDir: base, writesFiles });
    const expected = new Map();
    const keyed = (list, keyOf) => {
      const n = new Map();
      return list.map((x) => { const k = keyOf(x); n.set(k, (n.get(k) ?? 0) + 1); return [`${k}#${n.get(k)}`, x]; });
    };
    for (const [k, x] of [...keyed(rebuilt.cases, (c) => `case ${c.id}`), ...keyed(rebuilt.fixtures, (f) => `fixture ${f.name} ${f.phase}`)]) expected.set(k, x);
    const claimed = keyed(entities, (x) => x.key);
    for (const [k, { at, e }] of claimed) {
      const truth = expected.get(k);
      expected.delete(k);
      if (!truth) { err(`rule 1b: ${at} is not in results.json`); continue; }
      if (!isDeepStrictEqual(e.writes ?? null, truth.writes ?? null)) {
        err(`rule 1b: ${at}.writes does not match the records on disk and results.json`);
      }
      if (e.retries !== undefined && e.retries !== truth.retries) {
        err(`rule 1b: ${at}.retries says ${e.retries} but results.json gives ${truth.retries}`);
      }
    }
    for (const k of expected.keys()) err(`rule 1b: ${k.replace(/#\d+$/, '')} ran (results.json) but is missing from the report`);
  }

  // Sweep the run directory: every guard record must be one the report lists, or a copy of
  // one (Playwright copies a file attached by path). fixtures/ holds identities, not records.
  let found = [];
  try {
    found = readdirSync(base, { recursive: true })
      .map((p) => String(p))
      .filter((p) => basename(p) === 'writes.json' && p.split(/[\\/]/)[0] !== 'fixtures')
      .map((p) => resolve(base, p));
  } catch { /* an unreadable run dir has already failed the evidence checks */ }
  const listedSet = new Set(listed);
  const pool = new Map();
  for (const p of listedSet) {
    try { const h = sha256File(p); pool.set(h, (pool.get(h) ?? 0) + 1); } catch { /* missing: rule 1b above */ }
  }
  for (const p of found.filter((x) => !listedSet.has(x))) {
    let h = null;
    try { h = sha256File(p); } catch { /* unreadable counts as unmatched */ }
    if (h && (pool.get(h) ?? 0) > 0) pool.set(h, pool.get(h) - 1);
    else err(`rule 1b: ${relative(base, p).split(sep).join('/')} is a guard record no listed record accounts for, so the report dropped the attempt that wrote it`);
  }

  // --- rule 2: the guard was live ---
  if (production || policy !== 'unrestricted') {
    const signatures = Array.isArray(profile.mutation?.write_signatures) ? profile.mutation.write_signatures.length : null;
    for (const { at, e } of entities) {
      if (!EXECUTED.includes(e.verdict)) continue;
      const w = e.writes;
      if (!isObj(w)) { err(`rule 2: ${at}: no write record, so nothing shows the guard ran`); continue; }
      if (w.installed !== true) err(`rule 2: ${at}: the write guard was not installed on every attempt that ran`);
      if (!(w.routed_requests > 0)) err(`rule 2: ${at}: the guard routed no requests, so it never saw the network`);
      for (const p of Array.isArray(w.paths) ? w.paths : []) {
        if (escapesRunDir(p)) continue;
        const rec = readRecord(resolve(base, p));
        if (rec && !(rec.routed_requests > 0)) err(`rule 2: ${at}: ${p} routed no requests`);
      }
      if (signatures !== null && policy !== 'unrestricted' && w.write_signatures !== signatures) {
        err(`rule 2: ${at}: the guard loaded write_signatures ${w.write_signatures} but the profile declares ${signatures}`);
      }
    }
  }

  // --- rules 3 and 4: what the guard recorded ---
  for (const { at, e } of entities) {
    const w = e.writes;
    if (!isObj(w)) continue;
    const blocked = Number(w.blocked) || 0;
    const observed = Number(w.observed) || 0;
    if (policy === 'read-only' && blocked + observed > 0) err(`rule 3: read-only run recorded ${blocked + observed} write(s) in ${at}`);
    if (policy === 'scoped-write' && blocked > 0) err(`rule 4: scoped-write run blocked ${blocked} write(s) outside its scope in ${at}`);
  }

  // --- rule 5: fixtures ---
  const declared = new Map((Array.isArray(casesDoc.fixtures) ? casesDoc.fixtures : [])
    .filter((f) => isObj(f) && isStr(f.name)).map((f) => [f.name, f.teardown]));
  const seen = new Set();
  for (const f of fixtures) {
    if (!declared.has(f.name)) err(`rule 5: fixtures[${f.name} ${f.phase}]: "${f.name}" is not declared in the cases file`);
    const k = `${f.name}|${f.phase}`;
    if (seen.has(k)) err(`rule 5: fixture "${f.name}" ${f.phase} appears twice`);
    seen.add(k);
    if (f.phase === 'teardown' && declared.get(f.name) === 'keep') {
      err(`rule 5: fixture "${f.name}" has a teardown entry but is declared teardown: keep`);
    }
  }
  const caseById = new Map(cases.map((c) => [c.id, c]));
  for (const [name, teardown] of declared) {
    const deps = (Array.isArray(casesDoc.cases) ? casesDoc.cases : [])
      .filter((c) => isObj(c) && c.fixture === name).map((c) => caseById.get(c.id)).filter(Boolean);
    const setup = fixtures.find((f) => f.name === name && f.phase === 'setup');
    const ran = deps.filter((c) => EXECUTED.includes(c.verdict));
    if (!setup) {
      if (ran.length) err(`rule 5: fixture "${name}" has no setup entry, but ${ran.map((c) => c.id).join(', ')} ran inside it`);
      continue;
    }
    if (setup.verdict !== 'pass') {
      for (const c of deps.filter((d) => d.verdict !== 'blocked')) {
        err(`rule 5: cases[${c.id}]: its fixture "${name}" setup did not pass (${setup.verdict}), so it must be blocked, not ${c.verdict}`);
      }
    } else if (teardown === 'delete') {
      const td = fixtures.find((f) => f.name === name && f.phase === 'teardown');
      if (!td || td.verdict !== 'pass') {
        warnings.push(`fixture "${name}" on ${report.env_name}: teardown ${td ? `did not pass (${td.verdict})` : 'never ran'}, so the entity it created was left behind`);
      }
    }
  }

  // Fixtures carry the same trace requirement as cases.
  for (const f of fixtures) {
    if (!needsEvidence(f.verdict)) continue;
    if (!isStr(f.trace)) err(`fixtures[${f.name} ${f.phase}].trace: required for a ${f.verdict} fixture`);
    else {
      const problem = artifactProblem(f.trace);
      if (problem) err(`fixtures[${f.name} ${f.phase}].trace: "${f.trace}" ${problem}`);
    }
  }

  // --- rule 6: local evidence is pinned ---
  if (upload === 'local') {
    for (const { at, e } of entities) {
      if (!isStr(e.trace)) continue;
      if (escapesRunDir(e.trace)) {
        err(`rule 6: ${at}.trace "${e.trace}" must be a relative path inside the run directory, because that path is what the tracker receives`);
        continue;
      }
      if (!isStr(e.trace_sha256)) { err(`rule 6: ${at}.trace_sha256: required when evidence stays local, so the trace can be verified later`); continue; }
      let actual = null;
      try { actual = sha256File(resolve(base, e.trace)); } catch { /* unreadable */ }
      if (actual === null) err(`rule 6: ${at}.trace cannot be read to verify its sha256`);
      else if (actual !== e.trace_sha256) err(`rule 6: ${at}.trace does not match its trace_sha256; the file changed after the run`);
    }
  }

  return { errors, warnings };
}

/**
 * @returns {{ errors: string[], warnings: string[] }} errors non-empty === do not publish
 */
export function validateReport(report, profile, { map = null, base = null, stat = statSync, statuses = null, casesDoc = null } = {}) {
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

  const mutation = validateMutation(report, profile, casesDoc, {
    base: base ?? process.cwd(), needsEvidence, artifactProblem,
  });
  errors.push(...mutation.errors);
  warnings.push(...mutation.warnings);

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
    console.error('usage: node validate-report.mjs <report.json> --profile <config.yaml> --statuses <statuses.json> --cases <cases.yaml> [--map <clickup-map.json>] [--base <dir>]');
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
    const casesPath = argValue('--cases');
    if (!casesPath) {
      // Same reasoning as --statuses: the cases file is the only source of the mutation
      // policy and the fixture declarations, so it is required on every environment.
      console.error('REFUSED: rule 1: --cases is required. It is the feature\'s cases.yaml, the only source of the mutation policy and fixture declarations this run is checked against.');
      process.exit(1);
    }
    const casesDoc = parseYaml(readFileSync(casesPath, 'utf8'));
    // Relative artifact paths resolve against the report's own directory unless told
    // otherwise. Never null: evidence is always checked on disk.
    const base = argValue('--base') ?? dirname(resolve(reportPath));
    const { errors, warnings } = validateReport(report, profile, { map, base, statuses, casesDoc });
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
