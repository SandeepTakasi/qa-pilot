#!/usr/bin/env node
// Load + validate a QA-Pilot host profile (qa-pilot.config.yaml).
// Library: import { loadProfile }.  CLI: node profile.mjs <path> -> normalized JSON on stdout.
// Schema: qa-pilot/schemas/qa-pilot.config.schema.md

import { readFileSync, existsSync } from 'node:fs';
import { isMain } from './is-main.mjs';
import { dirname, resolve } from 'node:path';
import { parse } from './yaml.mjs';
import { STATUS_KEYS, DEFAULT_STATUSES } from './statuses.mjs';

const TOP_KEYS = ['project', 'tracker', 'apps', 'environments', 'stabilization', 'auth',
  'assertions', 'evidence', 'selectors', 'models', 'sandbox', 'context', 'mutation',
  'cross_app', 'clickup'];
const TRACKERS = ['clickup', 'none'];
const ENV_KINDS = ['qa', 'staging', 'production'];
const EVIDENCE_UPLOADS = ['tracker', 'reference', 'local'];
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '*'];
const SIGNATURE_KEYS = ['method', 'url', 'body', 'note'];
const AUTH_MODELS = ['dev-handoff', 'role-accounts', 'mixed'];
const NETWORK_MODES = ['allowed', 'forbidden'];
const ASSERT_STYLES = ['ui-state', 'mixed'];
const EVIDENCE_EXTRAS = ['console_log'];
const CAPTURE_MODES = ['always', 'on-failure', 'off'];
const PLAN_TIERS = ['free', 'unlimited', 'business', 'enterprise'];
// Hostnames that mean production to a person reading them. Only ever a warning now: an
// environment declares its kind, and the guess missed the commonest shape (app.<domain>).
// Still narrow, so it does not nag about qa.example.com or staging.example.com.
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
 * Where an environment's traces go: `local` everywhere under `tracker: none` (there is
 * nowhere to upload to) and on production, else its explicit `evidence_upload`, else
 * `reference` (the tracker gets the fields and failure text, the trace stays on the machine
 * that ran it). The loader writes this into the normalized profile so no skill or script
 * re-derives it.
 */
export function effectiveEvidenceUpload(env, { tracker = 'clickup' } = {}) {
  if (tracker === 'none') return 'local';
  // The loader refuses tracker and reference on production; this keeps an unvalidated
  // profile from leaking.
  if (env?.kind === 'production') return 'local';
  if (EVIDENCE_UPLOADS.includes(env?.evidence_upload)) return env.evidence_upload;
  return 'reference';
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

  // Which tracker the record lives in. `none` runs the pipeline on local files.
  const tracker = raw.tracker ?? 'clickup';
  if (!TRACKERS.includes(tracker)) err(`tracker: "${tracker}" is not one of ${TRACKERS.join(' | ')} (default: clickup)`);

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
      // What the environment is, declared rather than guessed. Everything production
      // implies (local evidence, full capture, a write guard) keys off this.
      if (env.kind === undefined) {
        err(`environments.${envName}.kind: required, one of ${ENV_KINDS.join(' | ')}. Declare what this environment is; the hostname is no longer used to guess.`);
      } else if (!ENV_KINDS.includes(env.kind)) {
        err(`environments.${envName}.kind: "${env.kind}" is not one of ${ENV_KINDS.join(' | ')}`);
      }
      if (Object.hasOwn(env, 'allow_production')) {
        err(`environments.${envName}.allow_production: retired in 0.3.0; declare kind: production`);
      }
      if (env.evidence_upload !== undefined && !EVIDENCE_UPLOADS.includes(env.evidence_upload)) {
        err(`environments.${envName}.evidence_upload: must be ${EVIDENCE_UPLOADS.join(' | ')}`);
      }
      if (tracker === 'none' && env.evidence_upload === 'tracker') {
        warnings.push(`environments.${envName}.evidence_upload: tracker is ignored under tracker: none; evidence stays local`);
      }
      // The account a production run signs in as is the real boundary, so it is named.
      const ta = env.test_account;
      const taOk = typeof ta === 'string' && ta.trim().length >= 20;
      if (env.kind === 'production') {
        if (!taOk) {
          err(`environments.${envName}.test_account: required on a production environment, at least 20 characters. Name the account the runs use and how it is restricted (its own tenant, no admin rights, no billing). The write guard is the second layer, not the boundary.`);
        }
      } else if (ta !== undefined && !taOk) {
        err(`environments.${envName}.test_account: at least 20 characters when present.`);
      }
      if (env.kind === 'production' && ['tracker', 'reference'].includes(env.evidence_upload)) {
        // A trace carries the session credential that authenticated the run and every
        // request body it touched (see "What a trace contains" in the ClickUp setup guide),
        // and reference would still send the failure text.
        err(`environments.${envName}.evidence_upload: ${env.evidence_upload} is refused on a production environment. Its traces carry the session credential and every request body they touched, so production evidence stays local.`);
      }
      // The hostname guess survives only to catch a mistyped kind.
      if (env.kind !== 'production') {
        for (const [appName, url] of Object.entries(isObj(env.apps) ? env.apps : {})) {
          if (typeof url === 'string' && PROD_HOST_RE.test(url)) {
            warnings.push(`environments.${envName}.apps.${appName}: "${url}" looks like production, but kind is ${env.kind ?? 'unset'}. The declared kind wins; check it is not a typo.`);
          }
        }
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
  const envEntries = isObj(raw.environments) ? Object.entries(raw.environments).filter(([, e]) => isObj(e)) : [];
  if (CAPTURE_MODES.includes(capture) && capture !== 'always'
    && envEntries.some(([, e]) => e.kind === 'production')) {
    err(`evidence.capture: must be always when any environment has kind production (got ${capture}). On production a pass is the claim most worth checking, and ${capture} keeps nothing for passes.`);
  }

  // --- stabilization (optional) ---
  // A deployed environment where a new spec may earn its three greens when the sandbox
  // cannot model the flow. Never production: stabilizing means running before anyone trusts it.
  if (raw.stabilization !== undefined) {
    const st = raw.stabilization;
    if (!isObj(st)) {
      err('stabilization: must be a mapping, e.g. { env: staging }');
    } else {
      for (const k of Object.keys(st)) {
        if (k !== 'env') err(`stabilization.${k}: unknown key (allowed: env)`);
      }
      const known = new Map(envEntries);
      if (!isStr(st.env)) err('stabilization.env: required, the name of a registered environment');
      else if (!known.has(st.env)) err(`stabilization.env: "${st.env}" is not a registered environment`);
      else if (known.get(st.env).kind === 'production') {
        err(`stabilization.env: "${st.env}" has kind production. Stabilization runs a spec before anyone trusts it, which production must not host.`);
      }
    }
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
  if (tracker === 'none') {
    // Ignored, not validated: nothing reads it, and it is dropped from the normalized profile.
    if (raw.clickup !== undefined) {
      warnings.push('clickup: present but ignored under tracker: none, and removed from the normalized profile');
    }
  } else if (!isObj(raw.clickup)) {
    err('clickup: required');
  } else {
    // Optional and read by nothing; checked only so a typo does not pass silently.
    if (raw.clickup.plan_tier !== undefined && !PLAN_TIERS.includes(raw.clickup.plan_tier)) {
      err(`clickup.plan_tier: one of ${PLAN_TIERS.join(' | ')} when present`);
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

  // --- context (optional) ---
  // Places a host documents behaviour, read before code when authoring cases.
  if (raw.context !== undefined) {
    if (!isObj(raw.context)) {
      err('context: must be a mapping with a sources list');
    } else {
      for (const k of Object.keys(raw.context)) if (k !== 'sources') err(`context.${k}: unknown key (allowed: sources)`);
      const sources = raw.context.sources;
      if (!Array.isArray(sources) || sources.length === 0) {
        err('context.sources: required, a non-empty list when context is set');
      } else {
        const names = new Set();
        sources.forEach((s, i) => {
          const at = `context.sources[${i}]`;
          if (!isObj(s)) { err(`${at}: must be a mapping`); return; }
          for (const k of Object.keys(s)) {
            if (!['name', 'description', 'command', 'path'].includes(k)) err(`${at}.${k}: unknown key (allowed: name, description, command, path)`);
          }
          if (!isStr(s.name)) err(`${at}.name: required, a non-empty string`);
          else if (names.has(s.name)) err(`${at}.name: "${s.name}" is used twice; names must be unique`);
          else names.add(s.name);
          if (!isStr(s.description)) err(`${at}.description: required. Say what it holds and which features it covers.`);
          if (isStr(s.command) === isStr(s.path)) err(`${at}: set exactly one of command | path, as a non-empty string`);
          // Env files hold secrets. They are never read, so naming one is a mistake.
          if (isStr(s.path) && /^\.env/.test(s.path.split('/').filter(Boolean).pop() ?? '')) {
            err(`${at}.path: "${s.path}" names .env files, which are never read as context`);
          }
        });
      }
    }
  }

  // --- mutation (optional; required with a production environment) ---
  // What a write looks like on this host, for the write guard. Every key is checked,
  // since a misspelt one would leave the guard with nothing to match and no complaint.
  const hasProduction = envEntries.some(([, e]) => e.kind === 'production');
  const regexProblem = (src, flags) => {
    try { new RegExp(src, flags); return null; } catch (e) { return e.message; }
  };
  const checkSignatures = (list, key) => {
    if (list === undefined) return 0;
    if (!Array.isArray(list)) { err(`mutation.${key}: must be a list`); return 0; }
    list.forEach((s, i) => {
      const at = `mutation.${key}[${i}]`;
      if (!isObj(s)) { err(`${at}: must be a mapping`); return; }
      for (const k of Object.keys(s)) {
        if (!SIGNATURE_KEYS.includes(k)) err(`${at}.${k}: unknown key (allowed: ${SIGNATURE_KEYS.join(', ')})`);
      }
      if (!HTTP_METHODS.includes(s.method)) err(`${at}.method: must be one of ${HTTP_METHODS.join(' | ')} (uppercase)`);
      for (const f of ['url', 'body']) {
        if (s[f] === undefined && f === 'body') continue;
        if (!isStr(s[f])) { err(`${at}.${f}: required, a regex string`); continue; }
        const problem = regexProblem(s[f], '');
        if (problem) err(`${at}.${f}: does not compile: ${problem}`);
      }
      if (s.note !== undefined && typeof s.note !== 'string') err(`${at}.note: must be a string`);
    });
    return list.length;
  };
  if (raw.mutation === undefined) {
    if (hasProduction) err('mutation: required when any environment has kind production, with at least one write_signatures entry, so the write guard knows what a write looks like on this host');
  } else if (!isObj(raw.mutation)) {
    err('mutation: must be a mapping');
  } else {
    const m = raw.mutation;
    for (const k of Object.keys(m)) {
      if (!['deny_controls', 'write_signatures', 'allow_signatures'].includes(k)) {
        err(`mutation.${k}: unknown key (allowed: deny_controls, write_signatures, allow_signatures)`);
      }
    }
    if (m.deny_controls !== undefined) {
      const d = m.deny_controls;
      if (!isObj(d)) {
        err('mutation.deny_controls: must be a mapping of text and icons');
      } else {
        for (const k of Object.keys(d)) if (!['text', 'icons'].includes(k)) err(`mutation.deny_controls.${k}: unknown key (allowed: text, icons)`);
        if (d.text !== undefined) {
          if (!Array.isArray(d.text)) err('mutation.deny_controls.text: must be a list of regex strings');
          else d.text.forEach((t, i) => {
            if (!isStr(t)) err(`mutation.deny_controls.text[${i}]: must be a non-empty regex string`);
            else {
              const problem = regexProblem(t, 'i');
              if (problem) err(`mutation.deny_controls.text[${i}]: does not compile: ${problem}`);
            }
          });
        }
        if (d.icons !== undefined) {
          if (!Array.isArray(d.icons)) err('mutation.deny_controls.icons: must be a list of icon class names');
          else d.icons.forEach((c, i) => { if (!isStr(c)) err(`mutation.deny_controls.icons[${i}]: must be a non-empty string`); });
        }
      }
    }
    const writes = checkSignatures(m.write_signatures, 'write_signatures');
    checkSignatures(m.allow_signatures, 'allow_signatures');
    // A non-list was already reported above; do not report it twice.
    if (hasProduction && writes === 0 && Array.isArray(m.write_signatures ?? [])) {
      err('mutation.write_signatures: at least one entry is required when any environment has kind production');
    }
  }

  if (errors.length) return { profile: null, errors, warnings };
  // The normalized profile: a copy, so validating never changes what the caller holds.
  const profile = structuredClone(raw);
  for (const env of Object.values(profile.environments)) env.evidence_upload = effectiveEvidenceUpload(env, { tracker });
  // Under tracker: none no script may read a status name from an ignored block.
  if (tracker === 'none') delete profile.clickup;
  return { profile, errors, warnings };
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
