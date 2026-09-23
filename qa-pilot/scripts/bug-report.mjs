#!/usr/bin/env node
// Assemble bug reports for failures QA has confirmed are real defects.
//
// The failure text is Playwright's, copied verbatim. A model paraphrasing an error into a
// bug ticket reintroduces exactly the unverifiable claim this pipeline exists to remove,
// and a developer who cannot trust the error in the ticket reads the trace instead, which
// makes the ticket worthless. Everything here is copied or computed, never described.
//
// Usage: node bug-report.mjs --report <report.json> --cases <cases.yaml> \
//          --confirmed <CASE-ID,CASE-ID|confirmed.json> \
//          [--profile <qa-pilot.config.yaml>] [--bugs <bugs.json>] [--specs <specs.json>]
//
// Prints { create[], comment[], skipped[], ledger } as JSON. It writes nothing: the ClickUp
// writes go over MCP, and the ledger is written back by the skill once they succeed.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from './lib/yaml.mjs';
import { isMain } from './lib/is-main.mjs';
import { loadProfile } from './lib/profile.mjs';

// A pass has no defect to report. `flaky` is included because an intermittent product bug
// is a real thing, but it is labelled as one: quarantine-and-harden is the usual answer,
// and a ticket that hides the intermittency wastes the developer's first hour.
const REPORTABLE = new Set(['fail', 'flaky']);

/**
 * Stable identity for one failure, so the same break does not file a new bug every run.
 *
 * Digits are stripped because Playwright errors carry timeouts, element counts and
 * coordinates that vary between runs while naming the same defect.
 *
 * ponytail: normalized-text hash. A reworded assertion or a genuinely different message
 * for the same underlying defect files a second bug. Fixing that properly means matching
 * on the failing selector plus the assertion type, which is worth doing only if duplicate
 * bugs actually show up in practice.
 */
export function failureSignature(caseId, failureSummary) {
  const normalized = String(failureSummary ?? '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return createHash('sha256').update(`${caseId}\n${normalized}`).digest('hex').slice(0, 16);
}

const bullets = (items) => (items ?? []).map((s) => `- ${s}`).join('\n');

/** The bug body. Every line is copied from the report, the cases file or the profile. */
export function bugBody(c, kase, report, { specPath = null, traceName = null } = {}) {
  const intermittent = c.verdict === 'flaky';
  const sections = [];

  sections.push(`**${kase.title}**`);
  sections.push(
    intermittent
      ? `This case failed and then passed on retry, so the defect is **intermittent**. ` +
        `It reproduces some of the time, which is itself the finding: do not close it because one manual attempt worked.`
      : `This case failed against a deployed build. QA reviewed the evidence and confirmed the test is correct and the feature is broken.`,
  );

  sections.push(`## What failed\n\nPlaywright's error, verbatim:\n\n\`\`\`\n${c.failure_summary}\n\`\`\``);

  sections.push(
    `## Steps to reproduce\n\n` +
    `**Preconditions**\n${bullets(kase.preconditions)}\n\n` +
    `**Steps**\n${(kase.steps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
  );

  sections.push(`## Expected\n\n${bullets(kase.expected)}`);

  const build = report.sha_format === 'build-id'
    ? `${report.commit_sha} (build id, not a commit: trace it to source through your release records)`
    : report.commit_sha;
  sections.push(
    `## Where\n\n` +
    `| | |\n|---|---|\n` +
    `| Environment | ${report.env_name} |\n` +
    `| URL | ${report.env_url} |\n` +
    `| Build | ${build} |\n` +
    `| App | ${report.app} |\n` +
    `| API mode | ${report.api_mode} |\n` +
    `| Browser | ${report.browser ?? 'unknown'} |\n` +
    `| Run | ${report.run_id} |\n` +
    `| Run by | ${report.executor} |`,
  );

  if (specPath) {
    sections.push(
      `## Re-run it\n\n\`\`\`bash\nnpx playwright test ${specPath}\n\`\`\`\n\n` +
      `The spec is committed, so this reproduces on any machine and re-runs as a regression check once the fix lands.`,
    );
  }

  sections.push(
    `## Evidence\n\n` +
    (traceName
      ? `The Playwright trace is attached to the case task as \`${traceName}\`. Download it, then open it at https://trace.playwright.dev. It carries the video, console output, network log and a DOM snapshot of every step.\n\n`
      : `The Playwright trace is attached to the case task for this run. Download it, then open it at https://trace.playwright.dev.\n\n`) +
    `Treat the trace as a credential: it contains the session token that authenticated the run.`,
  );

  sections.push(`Filed by QA-Pilot from case ${c.id}. Reopen the case rather than editing this description if the failure changes.`);

  return sections.join('\n\n');
}

/**
 * @param {object} report parsed report.json
 * @param {Array} cases from cases.yaml
 * @param {string[]} confirmed case IDs QA confirmed as real defects
 * @param {object} opts profile, existing ledger, spec paths
 * @returns {{create: object[], comment: object[], skipped: object[], ledger: object}}
 */
export function buildBugs(report, cases, confirmed, {
  profile = {}, ledger = {}, specs = {},
} = {}) {
  const create = [];
  const comment = [];
  const skipped = [];
  const nextLedger = { ...ledger };

  const caseById = new Map(cases.map((c) => [c.id, c]));
  const resultById = new Map((report.cases ?? []).map((c) => [c.id, c]));

  // Where bugs go. Naming a list is optional so a first pilot is not blocked on ClickUp
  // admin, but an unnamed one lands in the feature list, which mixes bugs into the case
  // board and is worth saying out loud rather than doing quietly.
  const bugList = profile.clickup?.bug_list ?? null;

  for (const id of confirmed) {
    const result = resultById.get(id);
    const kase = caseById.get(id);
    if (!result) {
      skipped.push({ id, reason: `not in this run's report, so there is no evidence to file against` });
      continue;
    }
    if (!kase) {
      skipped.push({ id, reason: `not in cases.yaml, so its steps and expectations are unknown` });
      continue;
    }
    if (!REPORTABLE.has(result.verdict)) {
      skipped.push({ id, reason: `verdict is "${result.verdict}", not a failure. Only fail and flaky describe a defect.` });
      continue;
    }
    if (!result.failure_summary) {
      skipped.push({ id, reason: `no failure summary recorded, so the bug would assert a break it cannot evidence` });
      continue;
    }

    const signature = failureSignature(id, result.failure_summary);
    const known = ledger[id];
    const traceName = result.trace ? `${id}-${report.run_id}.zip` : null;

    if (known?.task_id && known.signature === signature) {
      // Same case, same failure. A weekly regression run would otherwise file this bug
      // every week, and a board of duplicates is a board nobody reads.
      comment.push({
        id,
        task_id: known.task_id,
        body:
          `Still failing on \`${report.run_id}\` against ${report.env_name} at build \`${report.commit_sha}\`.\n\n` +
          `\`\`\`\n${result.failure_summary}\n\`\`\`\n\n` +
          `Same failure signature as when this was filed, so it is the same defect rather than a new one. ` +
          `The trace for this run is attached to case ${id}.`,
      });
      nextLedger[id] = {
        ...known,
        signature,
        last_seen_run: report.run_id,
        seen_count: (known.seen_count ?? 1) + 1,
      };
      continue;
    }

    create.push({
      id,
      // The case ID leads so the board sorts by feature and a developer can grep back to
      // the case. Never search by title to find this later: use the ledger.
      title: `${id}: ${kase.title}`,
      list: bugList,
      list_source: bugList ? 'clickup.bug_list' : 'the feature list (no clickup.bug_list set)',
      tags: ['qa-pilot', ...(result.verdict === 'flaky' ? ['intermittent'] : [])],
      priority: kase.priority,
      link_to_case: id,
      trace_attachment: traceName,
      body: bugBody(result, kase, report, { specPath: specs[id] ?? null, traceName }),
      // A previously filed bug whose signature changed means the failure moved. Say so,
      // rather than silently opening a second ticket that looks like a duplicate.
      supersedes: known?.task_id && known.signature !== signature
        ? { task_id: known.task_id, note: 'the failure changed, so this is a different defect from the one filed earlier' }
        : null,
    });
    nextLedger[id] = {
      task_id: null, // filled in by the skill once ClickUp returns the id
      signature,
      first_seen_run: report.run_id,
      last_seen_run: report.run_id,
      seen_count: 1,
      // A changed failure does not mean the old defect was fixed, and that bug may still
      // be open. Keeping its id is the only remaining link once this entry replaces the
      // old one.
      superseded: known?.task_id && known.signature !== signature
        ? [...(known.superseded ?? []), known.task_id]
        : known?.superseded,
    };
  }

  const warnings = [];
  if (!bugList && create.length) {
    warnings.push('clickup.bug_list is not set, so these bugs land in the feature list beside the case tasks. Name a bug list in the profile to keep the case board clean.');
  }
  return { create, comment, skipped, ledger: nextLedger, warnings };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

if (isMain(import.meta.url)) {
  const reportPath = argValue('--report');
  const casesPath = argValue('--cases');
  const confirmedArg = argValue('--confirmed');
  if (!reportPath || !casesPath || !confirmedArg) {
    console.error('usage: node bug-report.mjs --report <report.json> --cases <cases.yaml> --confirmed <CASE-ID,...|confirmed.json> [--profile <p>] [--bugs <bugs.json>] [--specs <specs.json>]');
    process.exit(2);
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const doc = parse(readFileSync(casesPath, 'utf8'));
    if (!Array.isArray(doc?.cases)) throw new Error(`no cases[] in ${casesPath}`);

    // Either a comma-separated list or a JSON file holding an array of case IDs.
    let confirmed;
    if (confirmedArg.endsWith('.json')) {
      const raw = JSON.parse(readFileSync(confirmedArg, 'utf8'));
      confirmed = Array.isArray(raw) ? raw : Object.keys(raw);
    } else {
      confirmed = confirmedArg.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (confirmed.length === 0) throw new Error('--confirmed named no cases');

    const profilePath = argValue('--profile');
    const profile = profilePath ? loadProfile(profilePath).profile : {};
    if (!profilePath) console.error('warning: no --profile given, so no bug list is known and every bug will land in the feature list');

    const bugsPath = argValue('--bugs');
    let ledger = {};
    if (bugsPath) {
      try { ledger = JSON.parse(readFileSync(bugsPath, 'utf8')); }
      catch { console.error(`warning: no bug ledger at ${bugsPath} yet; treating every failure as newly found`); }
    } else {
      console.error('warning: no --bugs ledger given, so a failure already filed will be filed again');
    }

    let specs = {};
    const specsPath = argValue('--specs');
    if (specsPath) specs = JSON.parse(readFileSync(specsPath, 'utf8'));

    const out = buildBugs(report, doc.cases, confirmed, { profile, ledger, specs });
    for (const w of out.warnings) console.error(`warning: ${w}`);
    for (const s of out.skipped) console.error(`skipped ${s.id}: ${s.reason}`);
    console.log(JSON.stringify(out, null, 2));
    // Nothing to file is a real answer, not a failure: QA may have confirmed only cases
    // that were already filed.
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
