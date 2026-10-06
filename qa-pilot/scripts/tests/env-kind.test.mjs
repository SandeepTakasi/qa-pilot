import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { validateProfile, effectiveEvidenceUpload } from '../lib/profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, '../../../fixtures/host-fake/qa-pilot.config.yaml');
const golden = () => parse(readFileSync(GOLDEN, 'utf8'));
const run = (mutate) => {
  const p = golden();
  mutate(p);
  return validateProfile(p);
};
const errorsFor = (mutate) => run(mutate).errors;
const has = (list, re) => list.some((m) => re.test(m));

// A production environment of the commonest shape: an app. subdomain, which the 0.2.0
// hostname guess read as non-production.
const addProduction = (p, extra = {}) => {
  p.environments.production = {
    kind: 'production',
    apps: { storefront: 'https://app.host-fake.example.com' },
    test_account: 'qa-runner@example.com, own tenant, no admin rights',
    sha_source: { url: 'https://app.host-fake.example.com/api/version', json_path: 'build.commit' },
    ...extra,
  };
};

// --- kind -------------------------------------------------------------------

test('every environment must declare its kind', () => {
  const errs = errorsFor((p) => { delete p.environments.qa.kind; });
  assert.ok(has(errs, /environments\.qa\.kind: required/), errs.join('\n'));
});

test('kind must be qa, staging or production', () => {
  const errs = errorsFor((p) => { p.environments.qa.kind = 'prod'; });
  assert.ok(has(errs, /environments\.qa\.kind: .*qa \| staging \| production/), errs.join('\n'));
});

test('the declared kind wins over the hostname: app.<domain> can be production', () => {
  const { errors, warnings } = run((p) => addProduction(p));
  assert.deepEqual(errors.filter((e) => /environments\.production\.(kind|apps|evidence_upload)/.test(e)), []);
  assert.ok(!has(warnings, /looks like production/), warnings.join('\n'));
});

// --- the retired switch ------------------------------------------------------

test('allow_production is an error that points at kind', () => {
  const errs = errorsFor((p) => { p.environments.qa.allow_production = true; });
  assert.ok(has(errs, /environments\.qa\.allow_production: retired in 0\.3\.0; declare kind: production/), errs.join('\n'));
});

test('allow_production: false is still retired, not silently accepted', () => {
  const errs = errorsFor((p) => { p.environments.qa.allow_production = false; });
  assert.ok(has(errs, /retired in 0\.3\.0/), errs.join('\n'));
});

// --- the hostname guess survives only as a warning ----------------------------

test('a production-looking URL on a non-production kind warns and never errors', () => {
  for (const url of ['https://prod.example.com', 'https://example.com']) {
    const { errors, warnings } = run((p) => { p.environments.qa.apps.storefront = url; });
    assert.ok(!has(errors, /looks like production/), `${url}: ${errors.join('\n')}`);
    assert.ok(has(warnings, /environments\.qa\.apps\.storefront: .* looks like production/), `${url}: ${warnings.join('\n')}`);
  }
});

// --- evidence_upload ----------------------------------------------------------

test('evidence_upload must be tracker or local', () => {
  const errs = errorsFor((p) => { p.environments.qa.evidence_upload = 'clickup'; });
  assert.ok(has(errs, /environments\.qa\.evidence_upload: .*tracker \| local/), errs.join('\n'));
});

test('tracker on a production environment is an error', () => {
  const errs = errorsFor((p) => addProduction(p, { evidence_upload: 'tracker' }));
  assert.ok(has(errs, /environments\.production\.evidence_upload: tracker is refused on a production environment/), errs.join('\n'));
});

test('effective evidence_upload: an explicit value wins, else local for production, else tracker', () => {
  assert.equal(effectiveEvidenceUpload({ kind: 'qa' }), 'tracker');
  assert.equal(effectiveEvidenceUpload({ kind: 'staging' }), 'tracker');
  assert.equal(effectiveEvidenceUpload({ kind: 'staging', evidence_upload: 'local' }), 'local');
  assert.equal(effectiveEvidenceUpload({ kind: 'production' }), 'local');
  assert.equal(effectiveEvidenceUpload({ kind: 'production', evidence_upload: 'local' }), 'local');
});

test('an explicit evidence_upload survives into the normalized profile', () => {
  const { profile, errors } = run((p) => { p.environments.staging.evidence_upload = 'local'; });
  assert.deepEqual(errors, []);
  assert.equal(profile.environments.staging.evidence_upload, 'local');
});

test('the normalized profile carries the effective evidence_upload for qa and staging', () => {
  const { profile, errors } = validateProfile(golden());
  assert.deepEqual(errors, []);
  assert.equal(profile.environments.qa.evidence_upload, 'tracker');
  assert.equal(profile.environments.staging.evidence_upload, 'tracker');
});

test('validation does not mutate the input it was given', () => {
  const p = golden();
  validateProfile(p);
  assert.equal(Object.hasOwn(p.environments.qa, 'evidence_upload'), false);
});

// --- production requires full capture -----------------------------------------

test('production requires evidence.capture: always', () => {
  for (const capture of ['on-failure', 'off']) {
    const errs = errorsFor((p) => { addProduction(p); p.evidence.capture = capture; });
    assert.ok(has(errs, /evidence\.capture: must be always when any environment has kind production/), `${capture}: ${errs.join('\n')}`);
  }
});

test('production accepts the default capture, which is always', () => {
  const errs = errorsFor((p) => { addProduction(p); delete p.evidence.capture; });
  assert.ok(!has(errs, /evidence\.capture/), errs.join('\n'));
});

test('on-failure capture stays legal with no production environment', () => {
  const errs = errorsFor((p) => { p.evidence.capture = 'on-failure'; });
  assert.ok(!has(errs, /evidence\.capture/), errs.join('\n'));
});

// --- stabilization -------------------------------------------------------------

test('stabilization.env may name a registered non-production environment', () => {
  const { errors, profile } = run((p) => { p.stabilization = { env: 'staging' }; });
  assert.deepEqual(errors, []);
  assert.equal(profile.stabilization.env, 'staging');
});

test('stabilization.env must be registered', () => {
  const errs = errorsFor((p) => { p.stabilization = { env: 'nowhere' }; });
  assert.ok(has(errs, /stabilization\.env: "nowhere" is not a registered environment/), errs.join('\n'));
});

test('stabilization.env must not be a production environment', () => {
  const errs = errorsFor((p) => { addProduction(p); p.stabilization = { env: 'production' }; });
  assert.ok(has(errs, /stabilization\.env: "production" has kind production/), errs.join('\n'));
});

test('stabilization must be a mapping with env, and nothing else', () => {
  assert.ok(has(errorsFor((p) => { p.stabilization = 'staging'; }), /stabilization: must be a mapping/));
  assert.ok(has(errorsFor((p) => { p.stabilization = {}; }), /stabilization\.env: required/));
  assert.ok(has(errorsFor((p) => { p.stabilization = { env: 'staging', runs: 3 }; }), /stabilization\.runs: unknown key/));
});
