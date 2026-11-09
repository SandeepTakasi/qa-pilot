#!/usr/bin/env node
// Turn one finished run into what the tracker may receive: the publish sequence as one command.
//
// Usage: node publish.mjs <run-dir> --feature-dir testing/<feature> --profile <qa-pilot.config.yaml>
//                         --statuses <current statuses.json>
//   <run-dir>       testing/<feature>/runs/<run_id>, as /qa-pilot:run-tests left it
//   --statuses      each case's status now (from the tracker, or statuses.json under tracker: none);
//                   the run's own <run-dir>/statuses.json is what proves approval at run time
//
// In order, each step one of the existing scripts, stopping at the first refusal:
//   1. parse-report     results.json + meta.json        -> <run-dir>/report.json
//   2. validate-report  the publish gate; a refusal stops everything, and nothing is written
//   3. case-status      --transitions                   -> <run-dir>/transitions.json
//   4. case-status      score after the transitions     -> <run-dir>/confidence.json
//   5. publish-payload  what the tracker may receive    -> <run-dir>/payload.json, and
//                       the run record                  -> <feature-dir>/verdicts/<run_id>.json
//   then the approval ledger, <feature-dir>/approved.json, last, once every step has passed.
// Prints payload.json. Exit 0 on success, 1 on a refusal or error, 2 on bad usage.
// The order matters: 0.4.2 scored before the transitions and published a P0 it was sending
// back to review as Ready. Each step's warnings pass through on stderr.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { loadProfile } from './lib/profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

class Refused extends Error {}

function step(label, script, args, { okExit = [0] } = {}) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: 'utf8' });
  if (r.stderr) process.stderr.write(r.stderr);
  if (!okExit.includes(r.status)) throw new Refused(`publish stopped at ${label} (exit ${r.status}); nothing was published`);
  return r.stdout;
}

export function publish({ runDir, featureDir, profilePath, statuses }) {
  const { profile } = loadProfile(profilePath);
  const tracker = profile.tracker ?? 'clickup';
  const at = (f) => join(runDir, f);
  const cases = join(featureDir, 'cases.yaml');
  const approved = join(featureDir, 'approved.json');
  for (const f of [at('meta.json'), at('results.json'), at('statuses.json'), cases, statuses]) {
    if (!existsSync(f)) throw new Refused(`missing ${f}; a run is never reconstructed`);
  }

  step('parse-report', 'parse-report.mjs', [at('results.json'), at('meta.json')]);

  const gate = [at('report.json'), '--profile', profilePath, '--cases', cases, '--statuses', at('statuses.json')];
  if (tracker !== 'none') gate.push('--map', join(featureDir, 'clickup-map.json'));
  step('validate-report', 'validate-report.mjs', gate);

  const t = step('case-status --transitions', 'case-status.mjs', ['--transitions', '--cases', cases, '--statuses', statuses,
    '--verdicts', at('report.json'), '--approved', approved, '--profile', profilePath]);
  const { approved_ledger: ledger } = JSON.parse(t);
  writeFileSync(at('transitions.json'), t);

  // Exit 1 here only means no case is executable once the transitions apply; the score is complete.
  const c = step('case-status (score)', 'case-status.mjs', ['--cases', cases, '--statuses', statuses,
    '--verdicts', at('report.json'), '--apply-transitions', at('transitions.json'), '--profile', profilePath], { okExit: [0, 1] });
  try { JSON.parse(c); } catch { throw new Refused('publish stopped at case-status (score): it printed no score'); }
  writeFileSync(at('confidence.json'), c);

  const payload = step('publish-payload', 'publish-payload.mjs', [at('report.json'), '--profile', profilePath,
    '--transitions', at('transitions.json'), '--confidence', at('confidence.json'), '--record-dir', join(featureDir, 'verdicts')]);
  writeFileSync(at('payload.json'), payload);

  writeFileSync(approved, JSON.stringify(ledger, null, 2) + '\n');
  return JSON.parse(payload);
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
  const runDir = argv[0];
  const featureDir = flag('--feature-dir');
  const profilePath = flag('--profile');
  const statuses = flag('--statuses');
  if (!runDir || runDir.startsWith('--') || !featureDir || !profilePath || !statuses) {
    console.error('usage: node publish.mjs <run-dir> --feature-dir testing/<feature> --profile <qa-pilot.config.yaml> --statuses <current statuses.json>');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(publish({ runDir, featureDir, profilePath, statuses }), null, 2));
  } catch (e) {
    console.error(e instanceof Refused ? `REFUSED: ${e.message}` : e.message);
    process.exit(1);
  }
}
