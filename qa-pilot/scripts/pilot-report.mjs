#!/usr/bin/env node
// The numbers a pilot is judged on, for one feature, from files the pipeline already commits.
// Nothing here is estimated: a number with no source file says so instead of guessing.
//
// Usage: node pilot-report.mjs testing/<feature> [--json]
//   reads <dir>/verdicts/*.json   the run records publish-results commits
//         <dir>/reviews/*.json    one per qa-review session: started_at, finished_at, decisions[]
//         <dir>/bugs.json         the bug ledger
//         <dir>/approved.json, <dir>/specs.json, <dir>/cases.yaml   what CI would select now
// Run it from the repo root, where the paths in specs.json resolve.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { parse } from './lib/yaml.mjs';
import { selectSpecs } from './ci-gate.mjs';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/**
 * @param {{records: object[], reviews: object[], bugs: object|null, selection: {run: object[], skipped: object[]}|null}} input
 */
export function pilotReport({ records, reviews, bugs, selection }) {
  const totals = { pass: 0, fail: 0, flaky: 0, blocked: 0 };
  for (const r of records) for (const c of r.cases ?? []) if (Object.hasOwn(totals, c.verdict)) totals[c.verdict]++;
  const executed = totals.pass + totals.fail + totals.flaky;
  const all = executed + totals.blocked;

  let minutes = 0;
  let decided = 0;
  let timed = 0;
  for (const s of reviews) {
    const ms = Date.parse(s.finished_at) - Date.parse(s.started_at);
    const n = Array.isArray(s.decisions) ? s.decisions.length : 0;
    // A session without both times, or with none decided, says nothing about speed.
    if (!Number.isFinite(ms) || ms < 0 || n === 0) continue;
    minutes += ms / 60000;
    decided += n;
    timed++;
  }

  const entries = bugs ? Object.values(bugs) : [];
  return {
    runs: records.length,
    verdicts: totals,
    flaky_rate_pct: pct(totals.flaky, executed),
    blocked_rate_pct: pct(totals.blocked, all),
    review: timed
      ? { sessions: timed, decisions: decided, minutes_per_decision: Math.round((minutes / decided) * 10) / 10 }
      : null,
    bugs_filed: bugs ? entries.length + entries.reduce((n, e) => n + (Array.isArray(e?.superseded) ? e.superseded.length : 0), 0) : null,
    ci: selection ? { approved_runnable: selection.run.length, dropped_out: selection.skipped } : null,
  };
}

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { throw new Error(`${join(dir, f)} is not valid JSON`); }
  });
}

if (isMain(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) {
    console.error('usage: node pilot-report.mjs testing/<feature> [--json]');
    process.exit(2);
  }
  try {
    const records = readDir(join(dir, 'verdicts'));
    const reviews = readDir(join(dir, 'reviews'));
    const bugs = existsSync(join(dir, 'bugs.json')) ? JSON.parse(readFileSync(join(dir, 'bugs.json'), 'utf8')) : null;
    let selection = null;
    const files = ['approved.json', 'specs.json', 'cases.yaml'].map((f) => join(dir, f));
    if (files.every(existsSync)) {
      const cases = parse(readFileSync(files[2], 'utf8'))?.cases;
      selection = selectSpecs(JSON.parse(readFileSync(files[0], 'utf8')), JSON.parse(readFileSync(files[1], 'utf8')), cases);
    }
    const r = pilotReport({ records, reviews, bugs, selection });
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      const v = r.verdicts;
      const show = (x, unit = '') => (x === null ? 'no data' : `${x}${unit}`);
      console.log(`Runs published:           ${r.runs} (${v.pass} pass, ${v.fail} fail, ${v.flaky} flaky, ${v.blocked} blocked)`);
      console.log(`Flaky rate:               ${show(r.flaky_rate_pct, '%')} of executed cases`);
      console.log(`Blocked rate:             ${show(r.blocked_rate_pct, '%')} of cases`);
      console.log(`QA review time:           ${r.review ? `${r.review.minutes_per_decision} min per decision (${r.review.decisions} decisions, ${r.review.sessions} sessions)` : 'no timed review sessions'}`);
      console.log(`Bugs filed:               ${show(r.bugs_filed)}`);
      if (r.ci) {
        console.log(`CI would run now:         ${r.ci.approved_runnable} approved spec(s)`);
        console.log(`Dropped out of CI:        ${r.ci.dropped_out.length}`);
        for (const s of r.ci.dropped_out) console.log(`  ${s.id}: ${s.reason}`);
      } else {
        console.log('CI would run now:         no data (needs approved.json, specs.json and cases.yaml)');
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
