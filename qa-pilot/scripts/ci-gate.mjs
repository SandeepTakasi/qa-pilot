#!/usr/bin/env node
// Run the approved suite unattended, without ClickUp.
//
// CI cannot reach ClickUp: the approval lifecycle is driven over MCP by a model, and a
// build runner has neither. It does not need to. `approved.json` is committed, it names
// every case QA accepted and the hash of the spec they accepted, so CI can answer "what
// did QA approve, and is it still the same spec" from the repo alone.
//
// CI never publishes. It proves a regression and fails the build; putting verdicts in
// ClickUp stays a human-invoked step, because publishing means writing to a tracker as a
// person, and a second write path maintained separately from the first is a second thing
// to keep honest.
//
// Usage: node ci-gate.mjs select --approved <approved.json> --specs <specs.json> [--json]
//        node ci-gate.mjs verdict --report <report.json>
//
// `select` exits 1 when nothing is runnable, so a misconfigured job fails loudly rather
// than passing green having run zero tests.

import { readFileSync, existsSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
import { hashSpec } from './parse-report.mjs';

// Over this share of blocked cases, the environment failed rather than the feature. Same
// threshold the publish gate uses, for the same reason.
const BLOCKED_HALT_RATIO = 0.1;

/**
 * Which specs CI should run.
 *
 * A spec whose hash no longer matches the one QA approved is excluded, not run. It may
 * well be a better spec, but nobody has reviewed it, and a green CI run against an
 * unreviewed spec is a claim that a human stands behind something no human has read.
 *
 * @param {Record<string,string>} approved case id -> approved spec hash
 * @param {Record<string,string>} specPaths case id -> spec file path
 * @param {(p: string) => string|null} readSpec injected for tests
 */
export function selectSpecs(approved, specPaths, readSpec) {
  const run = [];
  const skipped = [];

  for (const [id, approvedHash] of Object.entries(approved ?? {})) {
    const path = specPaths?.[id];
    if (!path) {
      skipped.push({ id, reason: 'no spec path recorded for this case, so there is nothing to run' });
      continue;
    }
    const source = readSpec(path);
    if (source === null) {
      skipped.push({ id, path, reason: 'the spec file is missing from the repo, though QA approved it. Commit it, or re-approve the case.' });
      continue;
    }
    const current = hashSpec(source);
    if (current !== approvedHash) {
      skipped.push({
        id, path,
        reason: `the spec changed since QA approved it (approved ${approvedHash}, found ${current}). Publish a run and have QA review it before CI trusts it.`,
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
 * `flaky` fails the build. Pass-on-retry is never a pass anywhere else in this pipeline,
 * and letting CI be the one place it goes green would make CI the place people look when
 * they want a friendlier answer.
 */
export function ciVerdict(report) {
  const cases = report?.cases ?? [];
  const s = report?.summary ?? {};
  const total = cases.length;

  if (total === 0) {
    return { ok: false, reason: 'the run produced no cases, so nothing was proved. Check the spec selection rather than treating this as green.' };
  }

  const blocked = s.blocked ?? 0;
  if (blocked / total > BLOCKED_HALT_RATIO) {
    return {
      ok: false,
      environment_failed: true,
      reason: `${blocked} of ${total} cases are blocked, over ${BLOCKED_HALT_RATIO * 100}%. The environment failed, not the feature. Fix the environment and re-run; do not read this as a regression.`,
    };
  }

  if (report.sha_mismatch) {
    return {
      ok: false,
      environment_failed: true,
      reason: `the deployed build changed mid-run (${report.sha_before} -> ${report.sha_after}), so no verdict from this run is trustworthy. Re-run once the deploy settles.`,
    };
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

  return { ok: true, reason: `${s.pass ?? 0} approved case(s) still pass against ${report.env_name} at ${report.commit_sha}` };
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
      if (!approvedPath || !specsPath) throw new Error('select needs --approved <approved.json> --specs <specs.json>');
      if (!existsSync(approvedPath)) {
        throw new Error(`no approval ledger at ${approvedPath}. CI runs what QA approved, and nothing has been approved yet. Publish a run and review it first.`);
      }
      const { run, skipped } = selectSpecs(
        readJson(approvedPath),
        readJson(specsPath),
        (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
      );
      for (const s of skipped) console.error(`skipped ${s.id}: ${s.reason}`);
      if (run.length === 0) {
        // Zero tests passing is not the same as the suite passing.
        console.error('REFUSED: no approved spec is runnable, so this job would report green having proved nothing.');
        process.exit(1);
      }
      console.log(process.argv.includes('--json')
        ? JSON.stringify(run, null, 2)
        : run.map((r) => r.path).join(' '));
    } else if (mode === 'verdict') {
      const reportPath = argValue('--report');
      if (!reportPath) throw new Error('verdict needs --report <report.json>');
      const v = ciVerdict(readJson(reportPath));
      if (v.ok) {
        console.log(`ok: ${v.reason}`);
      } else {
        console.error(v.environment_failed ? `ENVIRONMENT FAILED: ${v.reason}` : `REGRESSION: ${v.reason}`);
        process.exit(1);
      }
    } else {
      console.error('usage: node ci-gate.mjs select --approved <approved.json> --specs <specs.json> [--json]');
      console.error('       node ci-gate.mjs verdict --report <report.json>');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
