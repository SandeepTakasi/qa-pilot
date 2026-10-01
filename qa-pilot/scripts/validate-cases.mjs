#!/usr/bin/env node
// Validate testing/<feature>/cases.yaml against the case schema + the host profile.
// Schema: qa-pilot/schemas/cases.schema.md
// Usage: node validate-cases.mjs <cases.yaml> --profile <qa-pilot.config.yaml>

import { readFileSync, existsSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
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
// Phrasing that describes a feeling about the screen rather than something a spec can
// check. `successful` is matched only as a predicate ("the save was successful") and as
// the adverb, never as an adjective: "a successful payment shows the receipt number" is a
// perfectly checkable expectation, and refusing it is the kind of false positive that
// teaches a team the linter is wrong. Deliberately NOT anchored to the whole string: anchoring meant "Verify that the
// page works as expected" sailed through, since the padding stopped it matching, which is
// how a lint gets a reputation for catching nothing.
const VAGUE_RE = /\b(works|working) (fine|correctly|properly|as expected)\b|\bas expected\b|\blooks? (ok|okay|fine|right|correct|good)\b|\bis (ok|okay|fine|correct)\b|\b(is|was|are|were) successful\b|\bsuccessfully\b|\bno (issues?|errors?|problems?)\b|\bbehaves? (properly|correctly)\b|\bdisplayed correctly\b|\bworks\b(?!\s+(out|with|like|around)\b)/i;

// What makes an expectation easy to bind to: literal text, a number, or a named piece of
// UI. This is a WARNING, never a refusal. Deciding by keyword whether a sentence names
// something observable is a guess, and a gate that wrongly refuses good work is one people
// route around, which costs more than the vague expectations it catches.
const ANCHOR_RE = /"[^"]+"|'[^']+'|\u201c[^\u201d]+\u201d|\d|\b(button|link|field|input|dialog|modal|toast|banner|panel|section|form|row|column|table|list|badge|chip|icon|menu|tab|card|header|label|message|error|tooltip|checkbox|dropdown|url|route|title|heading|count|total|number|value|text|item|entry|summary)s?\b/i;

// Only phrasing that really means the wire. Bare `request`/`response`/`fetch` were banned
// before, which flagged "the request form appears" and "the fetch button is disabled":
// ordinary UI wording, and false positives are what teach a team to ignore a linter.
const NETWORK_RE = /\b(API (call|request|response)s?|network (request|response|call|activity|tab)s?|HTTP (request|response|call|status)s?|payloads?|endpoints?|XHR|status\s+[1-5]\d{2}|\b[1-5]xx)\b|\b(waits? for|intercepts?|mocks?|stubs?) (the )?(request|response|fetch|call)s?\b|\b(request|response) (is |was )?(sent|returned|received|made)\b/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const strList = (v) => Array.isArray(v) && v.every(isStr);

const POLICIES = ['read-only', 'scoped-write', 'unrestricted'];
const PREFIX_RE = /^[A-Za-z0-9_-]{3,}$/;
const FIXTURE_NAME_RE = /^[a-z0-9-]+$/;
const TEARDOWNS = ['keep', 'delete'];

/**
 * The mutation and fixture rules on their own, so the publish gate can hold the cases file
 * it is handed to the same standard as authoring does. `policy` is the effective policy,
 * meaningful only when `errors` is empty.
 * @returns {{ errors: string[], warnings: string[], policy: string }}
 */
export function lintMutation(doc) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  if (!isObj(doc)) return { errors: ['cases file: must be a YAML mapping'], warnings };

  // Absent means unrestricted, so 0.2.0 case files stay valid off production.
  let policy = 'unrestricted';
  const m = doc.mutation;
  if (m !== undefined) {
    if (!isObj(m)) {
      err('mutation: must be a mapping, e.g. { policy: read-only }');
    } else {
      for (const k of Object.keys(m)) if (!['policy', 'prefix'].includes(k)) err(`mutation.${k}: unknown key (allowed: policy, prefix)`);
      if (m.policy === undefined) err(`mutation.policy: required, one of ${POLICIES.join(' | ')}`);
      else if (!POLICIES.includes(m.policy)) err(`mutation.policy: "${m.policy}" is not one of ${POLICIES.join(' | ')}`);
      else policy = m.policy;
      if (m.policy === 'scoped-write') {
        // The guard unlocks a control only where its own row carries the prefix, so a
        // short or spaced prefix would match far more than the feature's own entities.
        if (m.prefix === undefined) err('mutation.prefix: required under scoped-write, the name prefix every entity this feature creates carries');
        else if (typeof m.prefix !== 'string' || !PREFIX_RE.test(m.prefix)) err(`mutation.prefix: "${m.prefix}" must match ${PREFIX_RE.source}`);
      } else if (m.prefix !== undefined) {
        err('mutation.prefix: only allowed under scoped-write');
      }
    }
  }

  const declared = new Set();
  const fx = doc.fixtures;
  if (fx !== undefined) {
    if (!Array.isArray(fx)) {
      err('fixtures: must be a list of { name, teardown }');
    } else {
      if (fx.length && isObj(m) && m.policy === 'read-only') {
        err('fixtures: not allowed under mutation.policy: read-only. A fixture creates an entity, which a read-only feature cannot do.');
      }
      fx.forEach((f, i) => {
        const at = `fixtures[${i}]`;
        if (!isObj(f)) { err(`${at}: must be a mapping of name and teardown`); return; }
        if (!isStr(f.name)) err(`${at}.name: required`);
        else if (!FIXTURE_NAME_RE.test(f.name)) err(`${at}.name: "${f.name}" must match ${FIXTURE_NAME_RE.source}`);
        else if (declared.has(f.name)) err(`${at}.name: "${f.name}" is declared twice`);
        else declared.add(f.name);
        if (!TEARDOWNS.includes(f.teardown)) err(`${at}.teardown: required, one of ${TEARDOWNS.join(' | ')}`);
      });
    }
  }

  const named = new Set();
  for (const [i, c] of (Array.isArray(doc.cases) ? doc.cases : []).entries()) {
    if (!isObj(c) || c.fixture === undefined) continue;
    const at = isStr(c.id) ? `cases[${c.id}]` : `cases[${i}]`;
    if (!isStr(c.fixture)) err(`${at}.fixture: must be a fixture name`);
    else if (!declared.has(c.fixture)) err(`${at}.fixture: "${c.fixture}" is not declared in fixtures`);
    else named.add(c.fixture);
  }
  if (Array.isArray(fx)) {
    fx.forEach((f, i) => {
      if (isObj(f) && declared.has(f.name) && !named.has(f.name)) {
        warnings.push(`fixtures[${i}]: "${f.name}" is named by no case, so its setup would run, and write, for nothing`);
      }
    });
  }
  return { errors, warnings, policy };
}

/**
 * @param {object} doc parsed cases.yaml
 * @param {object} profile validated host profile
 * @param {{ featureDir?: string }} opts
 * @returns {string[]} errors (empty === valid)
 */
/**
 * @returns {string[]} errors, with a `warnings` property carrying non-fatal notes.
 *   Kept as an array so `errors.length` still reads as "is this publishable".
 */
export function validateCases(doc, profile, { featureDir = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const withWarnings = (list) => Object.defineProperty(list, 'warnings', { value: warnings });
  const done = () => withWarnings(errors);

  if (!isObj(doc)) return withWarnings(['cases file: must be a YAML mapping']);

  if (!isStr(doc.feature)) err('feature: required, non-empty string');
  else if (featureDir && doc.feature !== featureDir) {
    err(`feature: "${doc.feature}" does not match its directory "${featureDir}"`);
  }

  // --- model gate ---
  const approved = profile?.models?.generation_approved ?? [];
  if (!isStr(doc.model_version)) {
    err('model_version: required. Cases must record the model that authored them.');
  } else if (approved.length && !approved.includes(doc.model_version)) {
    err(`model_version: "${doc.model_version}" is not in models.generation_approved (${approved.join(', ')}). QA must approve a model before its cases enter the pipeline.`);
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
      err(`cases: ${cases.length} exceeds the ${MAX_CASES}-case cap. Split this into sub-features rather than generating volume.`);
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
        err(`${at}.expected: required, at least one verifiable outcome, because no assertions means no test`);
      } else {
        let verifiable = 0;
        c.expected.forEach((e, j) => {
          const where = `${at}.expected[${j}]`;
          if (!ANCHOR_RE.test(e)) {
            warn(`${where}: "${e}" names nothing obvious for a spec to bind to. Exact text in quotes, a number, or a named element makes it unambiguous, and without one the spec author picks a selector on your behalf.`);
          }
          if (e.trim().length < 10 || VAGUE_RE.test(e)) {
            err(`${where}: "${e}" states no observable outcome. Name the element, text, or state a Playwright assertion could check.`);
            return;
          }
          if (networkForbidden && NETWORK_RE.test(e)) {
            err(`${where}: "${e}" asserts on network activity, which this host forbids (assertions.network_events: forbidden). Such waits silently no-op and produce false greens; assert on rendered UI state instead.`);
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
    err('scenario_mix: required. Declare each of ' + MIX_SLOTS.join(', ') + ' as covered or n_a.');
  } else {
    for (const k of Object.keys(mix)) {
      if (!MIX_SLOTS.includes(k)) err(`scenario_mix.${k}: unknown slot (allowed: ${MIX_SLOTS.join(', ')})`);
    }
    const coveredSlots = new Set([...typesPresent].map((t) => SLOT_FOR_TYPE[t]).filter(Boolean));
    for (const slot of MIX_SLOTS) {
      const v = mix[slot];
      if (v === undefined) { err(`scenario_mix.${slot}: required. Mark it covered or give an n_a reason.`); continue; }
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

  // --- mutation and fixtures ---
  const mutation = lintMutation(doc);
  for (const e of mutation.errors) err(e);
  for (const w of mutation.warnings) warn(w);

  return done();
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

if (isMain(import.meta.url)) {
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
    for (const w of errors.warnings ?? []) console.error(`warning: ${w}`);
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
