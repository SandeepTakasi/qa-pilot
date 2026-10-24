#!/usr/bin/env node
// Run the approved suite unattended, without ClickUp.
//
// CI cannot reach ClickUp: the approval lifecycle is driven over MCP by a model, and a
// build runner has neither. It does not need to. `approved.json` is committed, it names
// every case QA accepted and the hash of what they accepted (lib/spec-hash.mjs), so CI can
// answer "what did QA approve, and is it still the same test" from the repo alone.
//
// CI never publishes. It proves a regression and fails the build; putting verdicts in
// ClickUp stays a human-invoked step, because publishing means writing to a tracker as a
// person, and a second write path maintained separately from the first is a second thing
// to keep honest.
//
// Usage: node ci-gate.mjs select --approved <approved.json> --specs <specs.json>
//                         --cases <cases.yaml> [--priority <P0[,P1[,P2]]>]
//                         [--max-skipped <n>] [--json]
//        node ci-gate.mjs verdict --report <report.json> [--expect <select --json output>]
//
// `select` exits 1 when nothing is runnable, so a misconfigured job fails loudly rather
// than passing green having run zero tests. `--max-skipped <n>` extends that to part of
// the suite: more than n skipped approved specs and it exits 1 too. Absent, any number of
// skips is tolerated. `verdict --expect` fails when a selected case is missing from the
// report, so a spec that matched nothing cannot leave the job green.

import { readFileSync, existsSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
import { specHash } from './lib/spec-hash.mjs';
import { parse } from './lib/yaml.mjs';

// Over this share of blocked cases, the environment failed rather than the feature. Same
// threshold the publish gate uses, for the same reason.
const BLOCKED_HALT_RATIO = 0.1;

const PRIORITIES = ['P0', 'P1', 'P2'];

/**
 * Which specs CI should run.
 *
 * A spec whose hash no longer matches the one QA approved is excluded, not run. It may
 * well be a better spec, but nobody has reviewed it, and a green CI run against an
 * unreviewed spec is a claim that a human stands behind something no human has read. The
 * hash covers the spec, its local imports and the case's steps, expected outcomes,
 * preconditions and fixture (lib/spec-hash.mjs), so an edited helper or a changed expectation
 * drops out the same way.
 *
 * @param {Record<string,string>} approved case id -> approved hash
 * @param {Record<string,string>} specPaths case id -> spec file path
 * @param {Array<object>} cases the parsed cases.yaml list
 * @param {{read?: (p: string) => string|null, priorities?: string[]}} [opts] read is
 *   injected for tests; priorities keeps only cases at those priorities
 */
export function selectSpecs(approved, specPaths, cases, { read, priorities } = {}) {
  const run = [];
  const skipped = [];
  const byId = new Map((Array.isArray(cases) ? cases : []).filter((c) => typeof c?.id === 'string').map((c) => [c.id, c]));

  for (const [id, approvedHash] of Object.entries(approved ?? {})) {
    const entry = byId.get(id);
    if (!entry) {
      skipped.push({ id, reason: 'no longer in cases.yaml. Delete its key from approved.json to retire it, or restore the case.' });
      continue;
    }
    if (priorities) {
      if (!PRIORITIES.includes(entry.priority)) {
        // Reported even when the filter would have left it out: dropping it silently would
        // hide a case nobody can place.
        skipped.push({ id, reason: 'no valid priority in cases.yaml, so its priority is unknown' });
        continue;
      }
      // Leaving it out is the job's intent, not a problem, so there is no skip line.
      if (!priorities.includes(entry.priority)) continue;
    }
    const path = specPaths?.[id];
    if (!path) {
      skipped.push({ id, reason: 'no spec path recorded for this case, so there is nothing to run' });
      continue;
    }
    // The default output is a space-separated list a shell splits on, so a path with
    // whitespace would reach the runner as two paths that do not exist.
    if (/\s/.test(path)) {
      skipped.push({ id, path, reason: 'the spec path contains whitespace, which a shell splits into separate arguments. Rename the file or directory.' });
      continue;
    }
    const current = specHash(path, entry, read ? { read } : undefined);
    if (current === null) {
      skipped.push({ id, path, reason: 'the spec file is missing from the repo, though QA approved it. Commit it, or re-approve the case.' });
      continue;
    }
    if (current !== approvedHash) {
      skipped.push({
        id, path,
        reason: `the spec, a file it imports, or the case's steps, expected outcomes, preconditions or fixture changed since QA approved it (approved ${approvedHash}, found ${current}). Publish a run and have QA review it before CI trusts it.`,
      });
      continue;
    }
    run.push({ id, path });
  }

  return { run, skipped };
}

/**
 * What the run means for the build.
 *
 * Green means every selected approved case ran and passed. Anything less is red: a blocked
 * case proved nothing, so "most of them passed" is not a pass. `flaky` fails the build too.
 * Pass-on-retry is never a pass anywhere else in this pipeline, and letting CI be the one
 * place it goes green would make CI the place people look when they want a friendlier answer.
 *
 * @param {object} report report.json from parse-report
 * @param {{expected?: string[]}} [opts] the case ids `select` chose; any that did not run fails
 */
export function ciVerdict(report, { expected } = {}) {
  const cases = report?.cases ?? [];
  const total = cases.length;
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  const env = (reason) => ({ ok: false, environment_failed: true, reason });

  // Global setup, a global timeout or a config error: nothing after it can be trusted.
  if (errors.length) {
    return env(`Playwright reported ${errors.length} error(s) outside any test, such as a failed global setup or a timed-out run:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  }
  if (total === 0) {
    return { ok: false, reason: 'the run produced no cases, so nothing was proved. Check the spec selection rather than treating this as green.' };
  }
  const blocked = cases.filter((c) => c.verdict === 'blocked');
  if (blocked.length / total > BLOCKED_HALT_RATIO) {
    return env(`${blocked.length} of ${total} cases are blocked, over ${BLOCKED_HALT_RATIO * 100}%. The environment failed, not the feature. Fix the environment and re-run; do not read this as a regression.`);
  }
  if (report.sha_mismatch) {
    return env(`the deployed build changed mid-run (${report.sha_before} -> ${report.sha_after}), so no verdict from this run is trustworthy. Re-run once the deploy settles.`);
  }

  const failed = cases.filter((c) => c.verdict === 'fail');
  const flaky = cases.filter((c) => c.verdict === 'flaky');
  if (failed.length || flaky.length) {
    const lines = [
      ...failed.map((c) => `  FAIL  ${c.id}: ${c.failure_summary ?? 'no error recorded'}`),
      ...flaky.map((c) => `  FLAKY ${c.id}: passed only on retry, which is never a pass. ${c.failure_summary ?? ''}`.trimEnd()),
    ];
    return {
      ok: false,
      regression: true,
      reason: `${failed.length} failing and ${flaky.length} flaky case(s) that QA had approved as passing:\n${lines.join('\n')}`,
    };
  }

  if (blocked.length) {
    return env(`${blocked.length} approved case(s) were blocked, so they proved nothing: ${blocked.map((c) => c.id).join(', ')}. Usually a failed setup project or an expired session.`);
  }
  const badFixtures = (report.fixtures ?? []).filter((f) => f.verdict !== 'pass');
  if (badFixtures.length) {
    return env(`fixture spec(s) did not pass: ${badFixtures.map((f) => `${f.name} ${f.phase} (${f.verdict})`).join(', ')}.`);
  }

  const ran = new Set(cases.map((c) => c.id));
  const notRun = (expected ?? []).filter((id) => !ran.has(id));
  const unmapped = report.unmapped_specs ?? [];
  if (notRun.length || unmapped.length) {
    return {
      ok: false,
      incomplete: true,
      reason: [
        notRun.length && `${notRun.length} selected approved case(s) never ran: ${notRun.join(', ')}. Playwright reads file arguments as patterns, so a path with ( ) [ ] or a config testIgnore can match nothing.`,
        unmapped.length && `${unmapped.length} test(s) ran without a case-ID title, so their results count for nothing: ${unmapped.join(', ')}.`,
      ].filter(Boolean).join(' '),
    };
  }

  return { ok: true, reason: `${total} approved case(s) still pass against ${report.env_name} at ${report.commit_sha}` };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

if (isMain(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === 'select') {
      const approvedPath = argValue('--approved');
      const specsPath = argValue('--specs');
      const casesPath = argValue('--cases');
      // The approval hash includes the case's own definition from cases.yaml, so CI cannot
      // check an approval without the cases file.
      if (!approvedPath || !specsPath || !casesPath) throw new Error('select needs --approved <approved.json> --specs <specs.json> --cases <cases.yaml>');

      // Presence, not truthiness: `--priority ""` and a trailing `--priority` are the
      // unknown value "", so a job can never silently fall back to running everything.
      let priorities;
      if (process.argv.includes('--priority')) {
        priorities = (argValue('--priority') ?? '').split(',').map((v) => v.trim());
        const unknown = priorities.find((v) => !PRIORITIES.includes(v));
        if (unknown !== undefined) throw new Error(`select: unknown priority "${unknown}"; use P0, P1 or P2`);
      }

      // Presence again, for the same reason: `--max-skipped ""` is invalid, never "unlimited".
      let maxSkipped;
      if (process.argv.includes('--max-skipped')) {
        const v = argValue('--max-skipped') ?? '';
        if (!/^\d+$/.test(v)) throw new Error('select: --max-skipped must be a whole number, 0 or more');
        maxSkipped = Number(v);
      }

      if (!existsSync(approvedPath)) {
        throw new Error(`no approval ledger at ${approvedPath}. CI runs what QA approved, and nothing has been approved yet. Publish a run and review it first.`);
      }
      if (!existsSync(casesPath)) throw new Error(`no cases file at ${casesPath}`);
      const cases = parse(readFileSync(casesPath, 'utf8'))?.cases;
      if (!Array.isArray(cases)) throw new Error(`no cases[] in ${casesPath}`);
      const { run, skipped } = selectSpecs(readJson(approvedPath), readJson(specsPath), cases, { priorities });
      for (const s of skipped) console.error(`skipped ${s.id}: ${s.reason}`);
      if (run.length === 0) {
        // Zero tests passing is not the same as the suite passing.
        console.error(`REFUSED: no approved spec ${priorities ? `at priority ${priorities.join(',')} ` : ''}is runnable, so this job would report green having proved nothing.`);
        process.exit(1);
      }
      // Before the run list is printed, so a refused job hands its caller nothing to run.
      if (maxSkipped !== undefined && skipped.length > maxSkipped) {
        console.error(`REFUSED: ${skipped.length} approved spec(s) were skipped and --max-skipped allows ${maxSkipped}, so this job would report green on part of the suite.`);
        process.exit(1);
      }
      console.log(process.argv.includes('--json')
        ? JSON.stringify(run, null, 2)
        : run.map((r) => r.path).join(' '));
    } else if (mode === 'verdict') {
      const reportPath = argValue('--report');
      if (!reportPath) throw new Error('verdict needs --report <report.json>');
      // The `select --json` output: every id in it must appear in the report.
      const expectPath = argValue('--expect');
      let expected;
      if (expectPath) {
        const sel = readJson(expectPath);
        if (!Array.isArray(sel)) throw new Error(`--expect: ${expectPath} must be the JSON list that select --json prints`);
        expected = sel.map((r) => r?.id).filter((id) => typeof id === 'string');
      }
      const v = ciVerdict(readJson(reportPath), { expected });
      if (v.ok) {
        console.log(`ok: ${v.reason}`);
      } else {
        const label = v.environment_failed ? 'ENVIRONMENT FAILED' : v.regression ? 'REGRESSION' : v.incomplete ? 'INCOMPLETE' : 'REFUSED';
        console.error(`${label}: ${v.reason}`);
        process.exit(1);
      }
    } else {
      console.error('usage: node ci-gate.mjs select --approved <approved.json> --specs <specs.json> --cases <cases.yaml> [--priority P0[,P1]] [--max-skipped <n>] [--json]');
      console.error('       node ci-gate.mjs verdict --report <report.json> [--expect <select.json>]');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
