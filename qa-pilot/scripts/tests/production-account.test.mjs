import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { validateProfile } from '../lib/profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, '../../../fixtures/host-fake/qa-pilot.config.yaml');

const PROD_MSG = 'environments.production.test_account: required on a production environment, at least 20 characters. Name the account the runs use and how it is restricted (its own tenant, no admin rights, no billing). The write guard is the second layer, not the boundary.';
const STAGING_MSG = 'environments.staging.test_account: at least 20 characters when present.';
const ok20 = 'a'.repeat(20);

// The test_account errors of a profile with a production environment, given its value
// (omit the argument to leave the key out).
const prodErrors = (...ta) => {
  const p = parse(readFileSync(GOLDEN, 'utf8'));
  p.environments.production = {
    kind: 'production',
    apps: { storefront: 'https://app.example.com' },
    sha_source: { url: 'https://app.example.com/api/version', json_path: 'build.commit' },
    ...(ta.length ? { test_account: ta[0] } : {}),
  };
  p.mutation = { write_signatures: [{ method: 'POST', url: '/api/' }] };
  return validateProfile(p).errors.filter((e) => /test_account/.test(e));
};

// Same for the staging environment the golden profile already has.
const stagingErrors = (...ta) => {
  const p = parse(readFileSync(GOLDEN, 'utf8'));
  if (ta.length) p.environments.staging.test_account = ta[0];
  return validateProfile(p).errors.filter((e) => /test_account/.test(e));
};

test('production: a missing test_account is an error with the exact text', () => {
  assert.deepEqual(prodErrors(), [PROD_MSG]);
});

test('production: null, a number and a short value all get the production text', () => {
  assert.deepEqual(prodErrors(null), [PROD_MSG]);
  assert.deepEqual(prodErrors(12345678901234567890), [PROD_MSG]);
  assert.deepEqual(prodErrors('too short'), [PROD_MSG]);
});

test('production: 19 characters after trimming is an error even with padding whitespace', () => {
  assert.deepEqual(prodErrors('   ' + 'a'.repeat(19) + '   '), [PROD_MSG]);
});

test('production: exactly 20 characters is accepted, padded or not', () => {
  assert.deepEqual(prodErrors(ok20), []);
  assert.deepEqual(prodErrors('  ' + ok20 + '  '), []);
});

test('staging: a missing test_account is fine', () => {
  assert.deepEqual(stagingErrors(), []);
});

test('staging: null and a short value get the "when present" text', () => {
  assert.deepEqual(stagingErrors(null), [STAGING_MSG]);
  assert.deepEqual(stagingErrors('short'), [STAGING_MSG]);
  assert.deepEqual(stagingErrors(' ' + 'a'.repeat(19) + ' '), [STAGING_MSG]);
});

test('staging: a valid value is accepted', () => {
  assert.deepEqual(stagingErrors(ok20), []);
});

test('a staging error never says the account is required on a production environment', () => {
  for (const v of [null, 'short', 42]) {
    for (const e of stagingErrors(v)) assert.ok(!/required on a production environment/.test(e), e);
  }
});
