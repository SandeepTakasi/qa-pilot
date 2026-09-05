#!/usr/bin/env node
// Load + validate a QA-Pilot host profile (qa-pilot.config.yaml).
// Library: import { loadProfile }.  CLI: node profile.mjs <path> -> normalized JSON on stdout.
// Schema: qa-pilot/schemas/qa-pilot.config.schema.md

import { readFileSync, existsSync } from 'node:fs';
import { isMain } from './is-main.mjs';
import { dirname, resolve } from 'node:path';
import { parse } from './yaml.mjs';
import { STATUS_KEYS, DEFAULT_STATUSES } from './statuses.mjs';

const TOP_KEYS = ['project', 'apps', 'environments', 'auth', 'assertions', 'evidence',
  'selectors', 'models', 'sandbox', 'cross_app', 'clickup'];
const AUTH_MODELS = ['dev-handoff', 'role-accounts', 'mixed'];
const NETWORK_MODES = ['allowed', 'forbidden'];
const ASSERT_STYLES = ['ui-state', 'mixed'];
const EVIDENCE_EXTRAS = ['console_log'];
const CAPTURE_MODES = ['always', 'on-failure', 'off'];
const PLAN_TIERS = ['free', 'unlimited', 'business', 'enterprise'];
// Hostnames that mean production to a person reading them. Deliberately narrow: it must
// not fire on qa.example.com or staging.example.com, since a false refusal here blocks
// legitimate work and teaches people to bypass the check.
const PROD_HOST_RE = /^https?:\/\/(www\.)?(?!(qa|staging|stage|stg|test|testing|dev|develop|development|uat|sandbox|preview|demo|local)[.-])[^/]*\b(prod|production|live)\b[^/]*\/?|^https?:\/\/(www\.)?[a-z0-9-]+\.(com|io|app|net|org|co|ai|dev)\/?$/i;

const SHA_FORMATS = ['commit', 'build-id'];
const PLAYWRIGHT_FLOOR = [1, 51, 0]; // storageState({ indexedDB: true })

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isUrl = (v) => isStr(v) && /^https?:\/\/\S+$/.test(v);

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/**
 * @returns {{ profile: object|null, errors: string[], warnings: string[] }}
 */
export function validateProfile(raw, { profilePath = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);

  if (!isObj(raw)) return { profile: null, errors: ['profile: must be a YAML mapping'], warnings };

  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.includes(k)) err(`unknown top-level key: ${k} (allowed: ${TOP_KEYS.join(', ')})`);
  }

  if (!isStr(raw.project)) err('project: required, must be a non-empty string');

  // --- apps ---
  const appNames = [];
  if (!isObj(raw.apps) || Object.keys(raw.apps).length === 0) {
    err('apps: required, must contain at least one app');
  } else {
    for (const [name, app] of Object.entries(raw.apps)) {
      appNames.push(name);
      if (!isObj(app)) { err(`apps.${name}: must be a mapping`); continue; }
      for (const f of ['framework', 'spec_dir', 'repo']) {
        if (!isStr(app[f])) err(`apps.${name}.${f}: required, must be a non-empty string`);
      }
    }
  }

  // --- environments ---
  if (!isObj(raw.environments) || Object.keys(raw.environments).length === 0) {
    err('environments: required, must contain at least one environment');
  } else {
    if (Object.keys(raw.environments).length === 1) {
      warnings.push('environments: only one environment registered, so there is no QA/staging split');
    }
    for (const [envName, env] of Object.entries(raw.environments)) {
      if (!isObj(env)) { err(`environments.${envName}: must be a mapping`); continue; }
      if (!isObj(env.apps) || Object.keys(env.apps).length === 0) {
        err(`environments.${envName}.apps: required, must map app names to base URLs`);
      } else {
        for (const [appName, url] of Object.entries(env.apps)) {
          if (appNames.length && !appNames.includes(appName)) {
            err(`environments.${envName}.apps.${appName}: not declared under apps{}`);
          }
          if (!isUrl(url)) err(`environments.${envName}.apps.${appName}: must be an http(s) URL`);
        }
      }
      // Production is not a place to run this. Specs create and mutate real records under
      // stored credentials, and every run writes a trace containing those credentials
      // (see "What a trace contains" in the ClickUp setup guide). A host that genuinely
      // must point at a production hostname can say so explicitly with
      // `allow_production: true`, which keeps the decision recorded in the profile rather
      // than made silently by whoever typed the URL.
      if (env.allow_production !== true) {
        for (const [appName, url] of Object.entries(isObj(env.apps) ? env.apps : {})) {
          if (typeof url === 'string' && PROD_HOST_RE.test(url)) {
            err(`environments.${envName}.apps.${appName}: "${url}" looks like production. QA-Pilot specs create and mutate real data, and each run writes a trace containing session tokens that is then uploaded to the tracker. Point this at a QA or staging deployment, or set environments.${envName}.allow_production: true to accept that.`);
          }
        }
      } else {
        warnings.push(`environments.${envName}: allow_production is set. Runs against it will create real records, and their traces will carry live session tokens into the tracker.`);
      }

      const s = env.sha_source;
      if (!isObj(s)) {
        err(`environments.${envName}.sha_source: required. A deploy SHA that cannot be read cannot be published.`);
      } else {
        if (!isUrl(s.url)) err(`environments.${envName}.sha_source.url: required, must be an http(s) URL`);
        if (s.format !== undefined && !SHA_FORMATS.includes(s.format)) {
          err(`environments.${envName}.sha_source.format: must be ${SHA_FORMATS.join(' | ')} (default: commit)`);
        }
        if (s.format === 'build-id') {
          warnings.push(`environments.${envName}.sha_source.format: build-id identifies the deployed bundle but not the commit, so a verdict cannot be traced to source without correlating through your release records. Prefer a commit once the environment can serve one.`);
        }
        const hasPath = isStr(s.json_path);
        const hasRegex = isStr(s.regex);
        if (hasPath === hasRegex) {
          err(`environments.${envName}.sha_source: set exactly one of json_path | regex`);
        }
        if (hasRegex) {
          try {
            // `re|` always matches empty, so exec('').length-1 is the group count.
            const groups = new RegExp(s.regex + '|').exec('').length - 1;
            if (groups < 1) err(`environments.${envName}.sha_source.regex: must contain one capture group around the SHA`);
          } catch {
            err(`environments.${envName}.sha_source.regex: not a valid regular expression`);
          }
        }
      }
    }
  }

  // --- auth ---
  if (!isObj(raw.auth)) {
    err('auth: required');
  } else {
    if (!AUTH_MODELS.includes(raw.auth.model)) {
      err(`auth.model: required, one of ${AUTH_MODELS.join(' | ')}`);
    }
    const pv = parseSemver(raw.auth.playwright_min);
    if (typeof raw.auth.playwright_min === 'number') {
      // Unquoted YAML floats 1.60 to 1.6, which then reads as "below 1.51".
      err(`auth.playwright_min: quote the version ("${raw.auth.playwright_min}"), otherwise YAML reads it as a number and 1.60 becomes 1.6`);
    } else if (!pv) err('auth.playwright_min: required, must be a semver string (e.g. "1.51.0")');
    else if (cmpSemver(pv, PLAYWRIGHT_FLOOR) < 0) {
      err(`auth.playwright_min: must be >= 1.51.0. storageState({ indexedDB: true }) landed in 1.51, and IndexedDB-persisted auth (Firebase) silently fails below it.`);
    }
    const ss = raw.auth.storage_state;
    if (!isObj(ss)) {
      err('auth.storage_state: required');
    } else {
      if (ss.indexed_db !== true) {
        err('auth.storage_state.indexed_db: must be true. Saved profiles omit IndexedDB otherwise, and Firebase-style sessions will not restore.');
      }
      if (ss.dir !== undefined && !isStr(ss.dir)) err('auth.storage_state.dir: must be a non-empty string when set');
    }
  }

  // --- assertions ---
  let networkForbidden = false;
  if (!isObj(raw.assertions)) {
    err('assertions: required');
  } else {
    if (!NETWORK_MODES.includes(raw.assertions.network_events)) {
      err(`assertions.network_events: required, one of ${NETWORK_MODES.join(' | ')}`);
    }
    networkForbidden = raw.assertions.network_events === 'forbidden';
    if (!ASSERT_STYLES.includes(raw.assertions.style)) {
      err(`assertions.style: required, one of ${ASSERT_STYLES.join(' | ')}`);
    }
    if (networkForbidden && raw.assertions.style !== 'ui-state') {
      err('assertions.style: must be ui-state when network_events is forbidden');
    }
  }

  // --- evidence ---
  let evidenceExtra = [];
  if (raw.evidence !== undefined) {
    if (!isObj(raw.evidence)) err('evidence: must be a mapping when set');
    else if (raw.evidence.extra !== undefined) {
      if (!Array.isArray(raw.evidence.extra)) err('evidence.extra: must be a list');
      else {
        evidenceExtra = raw.evidence.extra;
        for (const e of evidenceExtra) {
          if (!EVIDENCE_EXTRAS.includes(e)) err(`evidence.extra: unknown value "${e}" (allowed: ${EVIDENCE_EXTRAS.join(', ')})`);
        }
      }
    }
  }
  // Capturing a trace roughly doubles a run's wall clock and costs ~700KB per case, so
  // hosts may trade evidence for speed. The default stays `always`, because evidence for
  // PASSES is the valuable kind: a failure already evidences itself through its error,
  // whereas a pass is a claim that something works.
  const capture = raw.evidence?.capture ?? 'always';
  if (!CAPTURE_MODES.includes(capture)) {
    err(`evidence.capture: must be one of ${CAPTURE_MODES.join(' | ')} (default: always)`);
  }
  if (capture === 'on-failure') {
    warnings.push('evidence.capture: on-failure keeps no evidence for passing cases, so QA cannot sample passes and a false pass becomes undetectable. The sampling rules are the backstop against fabricated or shallow green runs; consider always for P0 work.');
  }
  if (capture === 'off') {
    warnings.push('evidence.capture: off captures nothing, so no run can be published. Use it only while iterating on specs locally.');
  }

  if (networkForbidden && evidenceExtra.length === 0) {
    warnings.push('evidence.extra: empty while network assertions are forbidden, so failures will be video-only and hard to triage');
  }

  // --- selectors ---
  if (!isObj(raw.selectors)) {
    err('selectors: required');
  } else {
    if (!isStr(raw.selectors.testid_attribute)) err('selectors.testid_attribute: required, e.g. data-testid');
    if (raw.selectors.policy_doc !== undefined) {
      if (!isStr(raw.selectors.policy_doc)) err('selectors.policy_doc: must be a non-empty string when set');
      else if (profilePath) {
        const docPath = resolve(dirname(resolve(profilePath)), raw.selectors.policy_doc.split('#')[0]);
        if (!existsSync(docPath)) warnings.push(`selectors.policy_doc: "${raw.selectors.policy_doc}" not found on disk`);
      }
    }
  }

  // --- models ---
  if (!isObj(raw.models)) {
    err('models: required');
  } else {
    const list = raw.models.generation_approved;
    if (!Array.isArray(list) || list.length === 0) {
      err('models.generation_approved: required, at least one approved model id. Case design is the highest-judgment stage and drift is silent.');
    } else if (!list.every(isStr)) {
      err('models.generation_approved: every entry must be a non-empty model id string');
    }
  }

  // --- sandbox ---
  if (!isObj(raw.sandbox) || !isObj(raw.sandbox.mode)) {
    err('sandbox.mode: required. Declare the stabilization mode (env_var + value).');
  } else {
    if (!isStr(raw.sandbox.mode.env_var)) err('sandbox.mode.env_var: required, e.g. VITE_API_MODE');
    if (!isStr(raw.sandbox.mode.value)) err('sandbox.mode.value: required, e.g. mocks');
  }

  // --- cross_app (required when multi-app) ---
  if (appNames.length > 1) {
    if (!isObj(raw.cross_app)) {
      err('cross_app: required when more than one app is declared');
    } else {
      const w = raw.cross_app.propagation_window_s;
      if (!Number.isInteger(w) || w < 1 || w > 600) {
        err('cross_app.propagation_window_s: required, integer 1..600');
      }
      if (!isStr(raw.cross_app.spec_home)) err('cross_app.spec_home: required, name of the app whose spec_dir hosts cross-app specs');
      else if (!appNames.includes(raw.cross_app.spec_home)) {
        err(`cross_app.spec_home: "${raw.cross_app.spec_home}" is not a declared app`);
      }
    }
  }

  // --- clickup ---
  if (!isObj(raw.clickup)) {
    err('clickup: required');
  } else {
    if (!PLAN_TIERS.includes(raw.clickup.plan_tier)) {
      err(`clickup.plan_tier: required, one of ${PLAN_TIERS.join(' | ')} (sets the API rate budget)`);
    }
    if (!isStr(raw.clickup.space)) err('clickup.space: required, the ClickUp space holding QA work');

    // Optional, but name it whenever the space holds more than one folder. Without it
    // "the feature's list in space X" is ambiguous, and a feature list can be created in
    // the wrong place, next to unrelated manual QA work.
    // Optional: the list bugs are filed into. Unset is legal, so a first pilot is not
    // blocked on ClickUp admin, but then bugs land beside the case tasks.
    if (raw.clickup.bug_list !== undefined && !isStr(raw.clickup.bug_list)) {
      err('clickup.bug_list: must be a non-empty string when set, the list confirmed defects are filed into');
    }
    if (raw.clickup.folder !== undefined && !isStr(raw.clickup.folder)) {
      err('clickup.folder: must be a non-empty string when set, the folder inside the space that holds feature lists');
    }

    // Status names are per-host: one team's "Under Review" is another's "ready for
    // review". Optional, but complete if present, since a half-declared map would match
    // some states and silently miss others.
    const st = raw.clickup.statuses;
    if (st !== undefined) {
      if (!isObj(st)) {
        err('clickup.statuses: must be a mapping of lifecycle key to the status name as it appears in ClickUp');
      } else {
        for (const k of Object.keys(st)) {
          if (!STATUS_KEYS.includes(k)) {
            err(`clickup.statuses.${k}: unknown lifecycle key (allowed: ${STATUS_KEYS.join(', ')})`);
          }
        }
        for (const k of STATUS_KEYS) {
          if (!isStr(st[k])) {
            err(`clickup.statuses.${k}: required once clickup.statuses is set; name it exactly as ClickUp shows it`);
          }
        }
        const seen = new Map();
        for (const k of STATUS_KEYS) {
          if (!isStr(st[k])) continue;
          const norm = st[k].trim().toLowerCase();
          if (seen.has(norm)) {
            err(`clickup.statuses: "${st[k]}" is used for both ${seen.get(norm)} and ${k}; each lifecycle state needs a status of its own or the pipeline cannot tell them apart`);
          } else seen.set(norm, k);
        }
      }
    } else {
      warnings.push(`clickup.statuses: not declared, so the canonical names are assumed (${STATUS_KEYS.map((k) => DEFAULT_STATUSES[k]).join(', ')}). Declare them if your ClickUp uses different wording.`);
    }
  }

  return { profile: errors.length ? null : raw, errors, warnings };
}

/** Read + validate a profile file. Throws on invalid, with all errors in the message. */
export function loadProfile(path) {
  if (!existsSync(path)) {
    throw new Error(`host profile not found: ${path}\nRun /qa-pilot:qa-init to create one.`);
  }
  let raw;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`host profile is not valid YAML: ${path}\n${e.message}`);
  }
  const { profile, errors, warnings } = validateProfile(raw, { profilePath: path });
  if (errors.length) {
    throw new Error(`host profile is invalid: ${path}\n` + errors.map((e) => `  - ${e}`).join('\n'));
  }
  return { profile, warnings };
}

if (isMain(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node profile.mjs <path-to-qa-pilot.config.yaml>');
    process.exit(2);
  }
  try {
    const { profile, warnings } = loadProfile(path);
    for (const w of warnings) console.error(`warning: ${w}`);
    console.log(JSON.stringify(profile, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
