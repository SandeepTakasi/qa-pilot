#!/usr/bin/env node
// Validate testing/<feature>/cases.yaml against the case schema + the host profile.
// Schema: qa-pilot/schemas/cases.schema.md
// Usage: node validate-cases.mjs <cases.yaml> --profile <qa-pilot.config.yaml>

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parse } from './lib/yaml.mjs';
import { loadProfile } from './lib/profile.mjs';

const MAX_CASES = 25;
const ID_RE = /^[A-Z0-9]+-[A-Z0-9]+-\d{3}$/;
const PRIORITIES = ['P0', 'P1', 'P2'];
const TYPES = ['happy', 'negative', 'edge', 'permission', 'data-validation'];
const MIX_SLOTS = ['happy', 'negative', 'boundary', 'permission', 'data-validation'];
// `edge` cases satisfy the `boundary` slot; every other slot maps to its own type.
const SLOT_FOR_TYPE = { happy: 'happy', negative: 'negative', edge: 'boundary', permission: 'permission', 'data-validation': 'data-validation' };

// An expected outcome with no observable subject cannot become an assertion.
const VAGUE_RE = /^\W*(it |the (page|app|ui|screen) )?(works|is (ok|fine|correct|right)|looks (ok|fine|right|correct)|as expected|successful(ly)?|succeeds|no (issues?|errors?|problems?)|behaves (properly|correctly)|is displayed correctly|passes)\W*$/i;
// Network-flavoured phrasing — silently no-ops where operations never hit the network.
const NETWORK_RE = /\b(requests?|responses?|API calls?|network|payloads?|endpoints?|XHR|fetch|status\s+[1-5]\d{2}|[1-5]xx)\b/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const strList = (v) => Array.isArray(v) && v.every(isStr);

/**
 * @param {object} doc parsed cases.yaml
 * @param {object} profile validated host profile
 * @param {{ featureDir?: string }} opts
 * @returns {string[]} errors (empty === valid)
 */
export function validateCases(doc, profile, { featureDir = null } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!isObj(doc)) return ['cases file: must be a YAML mapping'];

  if (!isStr(doc.feature)) err('feature: required, non-empty string');
  else if (featureDir && doc.feature !== featureDir) {
    err(`feature: "${doc.feature}" does not match its directory "${featureDir}"`);
  }

  // --- model gate ---
  const approved = profile?.models?.generation_approved ?? [];
  if (!isStr(doc.model_version)) {
    err('model_version: required — cases must record the model that authored them');
  } else if (approved.length && !approved.includes(doc.model_version)) {
    err(`model_version: "${doc.model_version}" is not in models.generation_approved (${approved.join(', ')}) — QA must approve a model before its cases enter the pipeline`);
  }

  if (!isStr(doc.generated_at) || Number.isNaN(Date.parse(doc.generated_at))) {
    err('generated_at: required, ISO 8601 timestamp');
  }

  // --- cases ---
  const cases = doc.cases;
  const typesPresent = new Set();
  if (!Array.isArray(cases) || cases.length === 0) {
    err('cases: required, at least one case');
  } else {
    if (cases.length > MAX_CASES) {
      err(`cases: ${cases.length} exceeds the ${MAX_CASES}-case cap — split this into sub-features rather than generating volume`);
    }
    const seen = new Set();
    const networkForbidden = profile?.assertions?.network_events === 'forbidden';

    cases.forEach((c, i) => {
      const at = isObj(c) && isStr(c.id) ? `cases[${c.id}]` : `cases[${i}]`;
      if (!isObj(c)) { err(`${at}: must be a mapping`); return; }

      if (!isStr(c.id)) err(`${at}.id: required`);
      else if (!ID_RE.test(c.id)) err(`${at}.id: must match <FEATURE>-<SUBFEATURE>-<NNN>, e.g. AUTH-LOGIN-003`);
      else if (seen.has(c.id)) err(`${at}.id: duplicate id`);
      else seen.add(c.id);

      if (!isStr(c.title)) err(`${at}.title: required`);
      if (!PRIORITIES.includes(c.priority)) err(`${at}.priority: required, one of ${PRIORITIES.join(' | ')}`);
      if (!TYPES.includes(c.type)) err(`${at}.type: required, one of ${TYPES.join(' | ')}`);
      else typesPresent.add(c.type);

      if (c.preconditions !== undefined && !strList(c.preconditions)) {
        err(`${at}.preconditions: must be a list of non-empty strings`);
      }
      if (!strList(c.steps) || c.steps.length === 0) err(`${at}.steps: required, at least one step`);

      // --- assertion lint ---
      if (!strList(c.expected) || c.expected.length === 0) {
        err(`${at}.expected: required, at least one verifiable outcome — no assertions means no test`);
      } else {
        let verifiable = 0;
        c.expected.forEach((e, j) => {
          const where = `${at}.expected[${j}]`;
          if (e.trim().length < 10 || VAGUE_RE.test(e)) {
            err(`${where}: "${e}" states no observable outcome — name the element, text, or state a Playwright assertion could check`);
            return;
          }
          if (networkForbidden && NETWORK_RE.test(e)) {
            err(`${where}: "${e}" asserts on network activity, which this host forbids (assertions.network_events: forbidden) — such waits silently no-op and produce false greens; assert on rendered UI state instead`);
            return;
          }
          verifiable++;
        });
        if (verifiable === 0) err(`${at}: no expected outcome survives the assertion lint`);
      }
    });
  }

  // --- scenario mix ---
  const mix = doc.scenario_mix;
  if (!isObj(mix)) {
    err('scenario_mix: required — declare each of ' + MIX_SLOTS.join(', ') + ' as covered or n_a');
  } else {
    for (const k of Object.keys(mix)) {
      if (!MIX_SLOTS.includes(k)) err(`scenario_mix.${k}: unknown slot (allowed: ${MIX_SLOTS.join(', ')})`);
    }
    const coveredSlots = new Set([...typesPresent].map((t) => SLOT_FOR_TYPE[t]).filter(Boolean));
    for (const slot of MIX_SLOTS) {
      const v = mix[slot];
      if (v === undefined) { err(`scenario_mix.${slot}: required — mark it covered or give an n_a reason`); continue; }
      if (v === 'covered') {
        if (!coveredSlots.has(slot)) err(`scenario_mix.${slot}: marked covered but no case has that type`);
      } else if (isObj(v) && 'n_a' in v) {
        if (!isStr(v.n_a)) err(`scenario_mix.${slot}.n_a: give a reason why this scenario type does not apply`);
        else if (coveredSlots.has(slot)) err(`scenario_mix.${slot}: marked n_a but cases of that type exist`);
      } else {
        err(`scenario_mix.${slot}: must be "covered" or { n_a: "<reason>" }`);
      }
    }
  }

  return errors;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const casesPath = process.argv[2];
  const profilePath = argValue('--profile');
  if (!casesPath || !profilePath) {
    console.error('usage: node validate-cases.mjs <cases.yaml> --profile <qa-pilot.config.yaml>');
    process.exit(2);
  }
  try {
    if (!existsSync(casesPath)) throw new Error(`cases file not found: ${casesPath}`);
    const { profile } = loadProfile(profilePath);
    const doc = parse(readFileSync(casesPath, 'utf8'));
    const featureDir = basename(dirname(resolve(casesPath)));
    const errors = validateCases(doc, profile, { featureDir });
    if (errors.length) {
      console.error(`cases file is invalid: ${casesPath}`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(`ok: ${doc.cases.length} cases`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
