import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { validateProfile, loadProfile } from '../lib/profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, '../../../fixtures/host-fake/qa-pilot.config.yaml');
const golden = () => parse(readFileSync(GOLDEN, 'utf8'));
const errorsFor = (mutate) => {
  const p = golden();
  mutate(p);
  return validateProfile(p).errors;
};

test('golden fixture profile is valid', () => {
  const { profile, errors } = validateProfile(golden());
  assert.deepEqual(errors, []);
  assert.equal(profile.project, 'host-fake');
});

test('loadProfile returns the parsed profile from disk', () => {
  const { profile } = loadProfile(GOLDEN);
  assert.equal(profile.clickup.plan_tier, 'business');
});

test('loadProfile throws for a missing file', () => {
  assert.throws(() => loadProfile(resolve(HERE, 'no-such-profile.yaml')), /not found/);
});

test('indexed_db must be true: the Firebase auth trap', () => {
  const errs = errorsFor((p) => { p.auth.storage_state.indexed_db = false; });
  assert.ok(errs.some((e) => e.includes('indexed_db')), errs.join('\n'));
});

test('an unquoted YAML version number is rejected with the quoting fix named', () => {
  // Regression: YAML floats 1.60 to 1.6, which then read as "below 1.51".
  const errs = errorsFor((p) => { p.auth.playwright_min = 1.60; });
  assert.ok(errs.some((e) => /quote the version/.test(e)), errs.join('\n'));
  assert.ok(!errs.some((e) => /must be >= 1\.51/.test(e)), 'the misleading message must not also fire');
});

test('playwright_min below 1.51 is rejected', () => {
  const errs = errorsFor((p) => { p.auth.playwright_min = '1.50.1'; });
  assert.ok(errs.some((e) => e.includes('playwright_min')), errs.join('\n'));
  assert.deepEqual(errorsFor((p) => { p.auth.playwright_min = '1.51.0'; }), []);
});

test('ui-state assertions are forced when network events are forbidden', () => {
  const errs = errorsFor((p) => { p.assertions.style = 'mixed'; });
  assert.ok(errs.some((e) => e.includes('assertions.style')), errs.join('\n'));
});

test('sha_source requires exactly one of json_path | regex', () => {
  assert.ok(errorsFor((p) => { delete p.environments.qa.sha_source.json_path; })
    .some((e) => e.includes('exactly one')));
  assert.ok(errorsFor((p) => { p.environments.qa.sha_source.regex = '"commit":"([a-f0-9]+)"'; })
    .some((e) => e.includes('exactly one')));
});

test('sha_source regex must have a capture group', () => {
  const errs = errorsFor((p) => {
    delete p.environments.qa.sha_source.json_path;
    p.environments.qa.sha_source.regex = 'commit=[a-f0-9]+';
  });
  assert.ok(errs.some((e) => e.includes('capture group')), errs.join('\n'));
});

test('sha_source is required, since an unreadable SHA cannot be published', () => {
  const errs = errorsFor((p) => { delete p.environments.qa.sha_source; });
  assert.ok(errs.some((e) => e.includes('sha_source')), errs.join('\n'));
});

test('environment app keys must be declared apps', () => {
  const errs = errorsFor((p) => { p.environments.qa.apps.ghost = 'https://ghost.example.com'; });
  assert.ok(errs.some((e) => e.includes('not declared under apps')), errs.join('\n'));
});

test('cross_app is required for multi-app profiles', () => {
  assert.ok(errorsFor((p) => { delete p.cross_app; }).some((e) => e.includes('cross_app')));
  // single-app profile does not need it
  const single = golden();
  delete single.apps.admin;
  delete single.environments.qa.apps.admin;
  delete single.environments.staging.apps.admin;
  delete single.cross_app;
  assert.deepEqual(validateProfile(single).errors, []);
});

test('cross_app.spec_home must name a declared app', () => {
  const errs = errorsFor((p) => { p.cross_app.spec_home = 'nowhere'; });
  assert.ok(errs.some((e) => e.includes('spec_home')), errs.join('\n'));
});

test('models.generation_approved is required and non-empty', () => {
  assert.ok(errorsFor((p) => { delete p.models; }).some((e) => e.includes('models')));
  assert.ok(errorsFor((p) => { p.models.generation_approved = []; })
    .some((e) => e.includes('generation_approved')));
});

test('clickup.folder is accepted and optional', () => {
  assert.deepEqual(validateProfile(golden()).errors, [], 'fixture declares a folder');
  const p = golden();
  delete p.clickup.folder;
  assert.deepEqual(validateProfile(p).errors, [], 'omitting it is allowed');
});

test('clickup.folder must be a real name when set', () => {
  const errs = errorsFor((p) => { p.clickup.folder = ''; });
  assert.ok(errs.some((e) => /clickup\.folder/.test(e)), errs.join('\n'));
});

test('evidence.capture defaults to always and accepts the three modes', () => {
  assert.deepEqual(validateProfile(golden()).errors, []);
  for (const mode of ['always', 'on-failure', 'off']) {
    assert.deepEqual(errorsFor((p) => { p.evidence.capture = mode; }), [], mode);
  }
});

test('an unknown capture mode is rejected', () => {
  const errs = errorsFor((p) => { p.evidence.capture = 'sometimes'; });
  assert.ok(errs.some((e) => /evidence\.capture/.test(e)), errs.join('\n'));
});

test('on-failure warns that QA can no longer sample passes', () => {
  const p = golden(); p.evidence.capture = 'on-failure';
  const { errors, warnings } = validateProfile(p);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /cannot sample passes/.test(w)), warnings.join('\n'));
});

test('off warns that nothing can be published', () => {
  const p = golden(); p.evidence.capture = 'off';
  const { warnings } = validateProfile(p);
  assert.ok(warnings.some((w) => /no run can be published/.test(w)), warnings.join('\n'));
});

// --- per-host status vocabulary ---------------------------------------------

test('a complete status map is accepted', () => {
  assert.deepEqual(validateProfile(golden()).errors, []);
});

test('a half-declared status map is rejected rather than half-applied', () => {
  const errs = errorsFor((p) => { delete p.clickup.statuses.retest; });
  assert.ok(errs.some((e) => /clickup\.statuses\.retest: required/.test(e)), errs.join('\n'));
});

test('an unknown lifecycle key is rejected, since a typo would silently do nothing', () => {
  const errs = errorsFor((p) => { p.clickup.statuses.aproved = 'oops'; });
  assert.ok(errs.some((e) => /unknown lifecycle key/.test(e)), errs.join('\n'));
});

test('two lifecycle states cannot share one ClickUp status', () => {
  const errs = errorsFor((p) => { p.clickup.statuses.retest = p.clickup.statuses.approved; });
  assert.ok(errs.some((e) => /each lifecycle state needs a status of its own/.test(e)), errs.join('\n'));
});

test('duplicate detection ignores case and surrounding space', () => {
  const errs = errorsFor((p) => { p.clickup.statuses.retest = '  ACCEPTED '; });
  assert.ok(errs.some((e) => /needs a status of its own/.test(e)), errs.join('\n'));
});

test('omitting the status map is allowed but warns that canonical names are assumed', () => {
  const p = golden();
  delete p.clickup.statuses;
  const { errors, warnings } = validateProfile(p);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /canonical names are assumed/.test(w)), warnings.join('\n'));
});

test('unknown top-level keys are rejected', () => {
  const errs = errorsFor((p) => { p.enviroments = {}; });
  assert.ok(errs.some((e) => e.includes('unknown top-level key: enviroments')), errs.join('\n'));
});

test('missing required blocks are all reported at once', () => {
  const errs = validateProfile({ project: 'x' }).errors;
  for (const k of ['apps', 'environments', 'auth', 'assertions', 'selectors', 'models', 'sandbox', 'clickup']) {
    assert.ok(errs.some((e) => e.startsWith(k)), `expected an error for ${k}: ${errs.join(' | ')}`);
  }
});

test('warns when forbidden network assertions have no console evidence', () => {
  const p = golden();
  p.evidence.extra = [];
  const { warnings } = validateProfile(p);
  assert.ok(warnings.some((w) => w.includes('video-only')), warnings.join('\n'));
});

// --- production environments -------------------------------------------------

// The kind is declared, so a production-looking URL only warns (a mistyped kind should be
// noticed) and never refuses. The full kind rules live in env-kind.test.mjs.
const prodWarningsFor = (url) => {
  const d = golden();
  const env = Object.values(d.environments)[0];
  env.apps[Object.keys(env.apps)[0]] = url;
  const { errors, warnings } = validateProfile(d);
  assert.deepEqual(errors.filter((e) => /looks like production/.test(e)), [], url);
  return warnings.filter((w) => /looks like production/.test(w));
};

test('a production URL on a qa environment warns rather than refuses', () => {
  assert.equal(prodWarningsFor('https://prod.example.com').length, 1);
});

test('a bare apex domain on a qa environment warns rather than refuses', () => {
  assert.equal(prodWarningsFor('https://example.com').length, 1);
});

test('qa and staging hostnames are never mistaken for production', () => {
  // A warning that fires on every legitimate host is one people learn to ignore.
  for (const url of [
    'https://qa.example.com', 'https://staging.example.com',
    'https://qa-thing.example.com', 'https://dev.example.com', 'http://localhost:5173',
  ]) {
    assert.deepEqual(prodWarningsFor(url), [], url);
  }
});

test('allow_production is retired and refused', () => {
  const d = golden();
  const env = Object.values(d.environments)[0];
  env.apps[Object.keys(env.apps)[0]] = 'https://prod.example.com';
  env.allow_production = true;
  const { errors } = validateProfile(d);
  assert.equal(errors.some((e) => /retired in 0\.3\.0; declare kind: production/.test(e)), true, errors.join('\n'));
});

test('clickup.bug_list is optional but must be a real name when set', () => {
  assert.deepEqual(errorsFor((d) => { d.clickup.bug_list = 'Storefront Bugs'; }), []);
  assert.deepEqual(errorsFor((d) => { delete d.clickup.bug_list; }), []);
  const errs = errorsFor((d) => { d.clickup.bug_list = ''; });
  assert.equal(errs.some((e) => /bug_list/.test(e)), true);
});
