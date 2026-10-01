#!/usr/bin/env node
// Everything a publish may send to the tracker, computed rather than chosen. The skill posts
// exactly what this prints and nothing else, because redaction written in prose gets skipped.
// Schema: qa-pilot/schemas/report.schema.md ("What the tracker receives")
//
// Usage: node publish-payload.mjs <report.json> --profile <qa-pilot.config.yaml> \
//          --transitions <case-status --transitions output> --confidence <case-status output>
//
// The mode follows the environment's effective evidence_upload, read from the profile:
//   tracker  the 0.2.0 field set, and the trace to attach
//   local    no application data: ids, verdicts, build, run, trace path and sha256 only
//   none     tracker: none, a plan of local file writes; nothing is sent anywhere
// It makes no network call and writes nothing.

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { loadProfile, effectiveEvidenceUpload } from './lib/profile.mjs';
import { DEFAULT_STATUSES, displayName } from './lib/statuses.mjs';

const VERDICTS = ['pass', 'fail', 'flaky', 'blocked'];
const escapesRunDir = (p) => typeof p !== 'string' || isAbsolute(p) || p.split(/[\\/]/).includes('..');

/**
 * @param {object} report validated report.json
 * @param {object} profile normalized host profile
 * @param {{ transitions: object, confidence: object }} inputs the two case-status outputs
 */
export function buildPayload(report, profile, { transitions, confidence } = {}) {
  const env = profile.environments?.[report.env_name];
  if (!env) throw new Error(`env_name "${report.env_name}" is not a registered environment in the profile; refusing to guess what the tracker may receive`);
  const conf = confidence?.confidence ?? confidence;
  if (!conf || typeof conf !== 'object' || !('label' in conf)) {
    throw new Error('--confidence is required: the case-status output whose confidence object the run summary reports');
  }
  const mode = profile.tracker === 'none' ? 'none'
    : effectiveEvidenceUpload(env, { tracker: profile.tracker });

  const names = profile.clickup?.statuses ?? DEFAULT_STATUSES;
  const target = new Map((transitions?.transitions ?? []).map((t) => [t.id, displayName(names, t.to)]));
  const cases = Array.isArray(report.cases) ? report.cases : [];
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, cases.filter((c) => c.verdict === v).length]));
  const blockedPct = cases.length ? Math.round((counts.blocked / cases.length) * 1000) / 10 : 0;

  if (mode === 'local') {
    // Decision 4: exactly these fields. Adding one here is a decision, not a convenience.
    return {
      mode,
      cases: cases.map((c) => {
        if (c.trace && escapesRunDir(c.trace)) {
          throw new Error(`trace path "${c.trace}" for ${c.id} must be a relative path inside the run directory before it can be sent`);
        }
        return {
          case_id: c.id,
          verdict: c.verdict,
          target_status: target.get(c.id) ?? null,
          env_name: report.env_name,
          build_id: report.commit_sha,
          run_id: report.run_id,
          trace_path: c.trace ?? null,
          trace_sha256: c.trace_sha256 ?? null,
        };
      }),
      summary: {
        run_id: report.run_id,
        env_name: report.env_name,
        build_id: report.commit_sha,
        counts,
        blocked_pct: blockedPct,
        confidence: { score: conf.score ?? null, label: conf.label },
        ready: Boolean(conf.ready),
      },
    };
  }

  // The full summary, for a tracker that may receive it or a local file.
  const summary = {
    run_id: report.run_id, // first, so a re-publish finds its own prior comment
    env_name: report.env_name,
    build_sha: report.commit_sha,
    counts,
    blocked_pct: blockedPct,
    confidence: { score: conf.score ?? null, label: conf.label, why: conf.why ?? null },
    ready: Boolean(conf.ready),
    executor: report.executor,
    reviewer_note: 'Traces open at https://trace.playwright.dev by drag-and-drop, entirely in the browser.',
  };

  if (mode === 'none') {
    const runDir = `testing/${report.feature}/runs/${report.run_id}/`;
    return {
      mode,
      statuses_file: `testing/${report.feature}/statuses.json`,
      status_writes: Object.fromEntries([...target]),
      summary_file: `${runDir}summary.json`,
      summary,
      bugs_dir: `${runDir}bugs/`,
    };
  }

  return {
    mode,
    cases: cases.map((c) => ({
      case_id: c.id,
      target_status: target.get(c.id) ?? null,
      fields: {
        Verdict: c.verdict,
        'Build SHA': report.commit_sha,
        Env: report.env_name,
        'API Mode': report.api_mode,
        App: report.app,
        Executor: report.executor,
        'Run Date': report.finished_at,
        'Flake Count': c.retries ?? 0,
        'Model Version': report.model_version,
      },
      // One artifact per case per run, named so a task's attachments read as run history.
      attach: c.trace ? { path: c.trace, name: `${c.id}-${report.run_id}.zip` } : null,
    })),
    summary,
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

if (isMain(import.meta.url)) {
  const reportPath = process.argv[2];
  const profilePath = argValue('--profile');
  const transitionsPath = argValue('--transitions');
  const confidencePath = argValue('--confidence');
  if (!reportPath || !profilePath || !transitionsPath || !confidencePath) {
    console.error('usage: node publish-payload.mjs <report.json> --profile <qa-pilot.config.yaml> --transitions <transitions.json> --confidence <case-status.json>');
    process.exit(2);
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const { profile } = loadProfile(profilePath);
    const transitions = JSON.parse(readFileSync(transitionsPath, 'utf8'));
    const confidence = JSON.parse(readFileSync(confidencePath, 'utf8'));
    console.log(JSON.stringify(buildPayload(report, profile, { transitions, confidence }), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
