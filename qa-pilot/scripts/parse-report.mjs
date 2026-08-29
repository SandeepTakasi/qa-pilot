#!/usr/bin/env node
// Transform a Playwright JSON report + run metadata into the uniform report.json.
// Zero model involvement: every field is copied or computed, never described.
// Schema: qa-pilot/schemas/report.schema.md
//
// Usage: node parse-report.mjs <playwright-report.json> <meta.json> [-o report.json]

import { readFileSync, writeFileSync } from 'node:fs';

const FAILURE_SUMMARY_MAX = 500;
const CASE_ID_RE = /^([A-Z0-9]+-[A-Z0-9]+-\d{3})\b/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;

const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '');

/** Walk the nested suite tree; Playwright nests suites per file and per describe block. */
function* walkSpecs(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) yield spec;
    yield* walkSpecs(suite.suites);
  }
}

/**
 * Verdict from the attempt results themselves, not from Playwright's own classification —
 * a config change (failOnFlakyTests, retries) must not be able to turn a flaky case green.
 */
export function verdictFor(results, { shaMismatch = false } = {}) {
  if (shaMismatch) return 'blocked';
  const statuses = results.map((r) => r.status);
  if (statuses.length === 0) return 'blocked';
  if (statuses.every((s) => s === 'skipped')) return 'blocked';

  const passed = statuses.includes('passed');
  const failed = statuses.some((s) => s === 'failed' || s === 'timedOut' || s === 'interrupted');
  if (passed && failed) return 'flaky'; // passed only on retry — never a pass
  if (failed) return 'fail';
  if (passed) return 'pass';
  return 'blocked';
}

function attachmentPath(results, name) {
  // Take the final attempt's artifact: it is the one that produced the verdict.
  for (let i = results.length - 1; i >= 0; i--) {
    const a = (results[i].attachments ?? []).find((x) => x.name === name && x.path);
    if (a) return a.path;
  }
  return null;
}

function consoleLogPath(results) {
  for (let i = results.length - 1; i >= 0; i--) {
    const a = (results[i].attachments ?? []).find((x) => x.name === 'console.log' || x.name === 'console');
    if (a?.path) return a.path;
    if (a?.body !== undefined) return `inline:${a.name}`;
  }
  return null;
}

/** The first line of the Playwright error, verbatim. Never prose, never a model's summary. */
function failureSummary(results) {
  for (let i = results.length - 1; i >= 0; i--) {
    const msg = results[i].error?.message ?? results[i].errors?.[0]?.message;
    if (msg) {
      const clean = stripAnsi(msg).split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
      return clean.length > FAILURE_SUMMARY_MAX ? `${clean.slice(0, FAILURE_SUMMARY_MAX)}…` : clean;
    }
  }
  return null;
}

/**
 * @param {object} pw parsed Playwright JSON report
 * @param {object} meta run metadata written by /run-tests
 * @returns {object} report.json
 */
export function buildReport(pw, meta) {
  const shaMismatch = Boolean(meta.sha_before && meta.sha_after && meta.sha_before !== meta.sha_after);

  const cases = [];
  const unmapped = [];
  for (const spec of walkSpecs(pw.suites)) {
    const m = CASE_ID_RE.exec(spec.title);
    if (!m) { unmapped.push(spec.title); continue; }
    const results = (spec.tests ?? []).flatMap((t) => t.results ?? []);
    const verdict = verdictFor(results, { shaMismatch });
    const last = results[results.length - 1] ?? {};

    cases.push({
      id: m[1],
      verdict,
      duration_ms: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
      assertions: null, // Playwright's JSON reporter does not expose an assertion count.
      video: attachmentPath(results, 'video'),
      trace: attachmentPath(results, 'trace'),
      console_log: consoleLogPath(results),
      failure_summary: verdict === 'fail' || verdict === 'flaky' ? failureSummary(results) : null,
      retries: Math.max(0, results.length - 1),
    });
  }

  cases.sort((a, b) => a.id.localeCompare(b.id));

  const summary = { pass: 0, fail: 0, flaky: 0, blocked: 0 };
  for (const c of cases) summary[c.verdict]++;

  return {
    run_id: meta.run_id,
    feature: meta.feature,
    app: meta.app,
    env_name: meta.env_name,
    env_url: meta.env_url,
    api_mode: meta.api_mode,
    commit_sha: meta.sha_after ?? meta.sha_before ?? null,
    sha_before: meta.sha_before ?? null,
    sha_after: meta.sha_after ?? null,
    sha_source: meta.sha_source ?? null,
    sha_mismatch: shaMismatch,
    executor: meta.executor,
    model_version: meta.model_version,
    playwright_version: meta.playwright_version ?? pw.config?.version ?? null,
    browser: meta.browser,
    started_at: meta.started_at ?? pw.stats?.startTime ?? null,
    finished_at: meta.finished_at ?? null,
    cases,
    summary,
    unmapped_specs: unmapped, // spec titles with no case ID prefix — cannot be published
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [pwPath, metaPath] = process.argv.slice(2);
  if (!pwPath || !metaPath) {
    console.error('usage: node parse-report.mjs <playwright-report.json> <meta.json> [-o report.json]');
    process.exit(2);
  }
  try {
    const pw = JSON.parse(readFileSync(pwPath, 'utf8'));
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const report = buildReport(pw, meta);
    const out = argValue('-o');
    const json = JSON.stringify(report, null, 2);
    if (out) {
      writeFileSync(out, json + '\n');
      const s = report.summary;
      console.log(`wrote ${out}: ${report.cases.length} cases (${s.pass} pass, ${s.fail} fail, ${s.flaky} flaky, ${s.blocked} blocked)`);
      if (report.unmapped_specs.length) {
        console.error(`warning: ${report.unmapped_specs.length} spec(s) have no case-ID prefix and were dropped:`);
        for (const t of report.unmapped_specs) console.error(`  - ${t}`);
      }
    } else {
      console.log(json);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
