import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { validateCases } from '../validate-cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const { profile } = loadProfile(resolve(FIXTURES, 'qa-pilot.config.yaml'));
const golden = () => parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8'));
const errorsFor = (mutate, p = profile) => { const d = golden(); mutate(d); return validateCases(d, p); };

test('golden cases fixture is valid', () => {
  assert.deepEqual(validateCases(golden(), profile, { featureDir: 'checkout' }), []);
});

test('feature must match its directory', () => {
  const errs = validateCases(golden(), profile, { featureDir: 'payments' });
  assert.ok(errs.some((e) => e.includes('does not match its directory')), errs.join('\n'));
});

test('a case with no expected outcomes is rejected: no assertions, no test', () => {
  const errs = errorsFor((d) => { d.cases[0].expected = []; });
  assert.ok(errs.some((e) => e.includes('no assertions means no test')), errs.join('\n'));
});

test('vague expected outcomes are rejected', () => {
  for (const vague of ['it works', 'looks correct', 'as expected', 'successfully', 'no issues']) {
    const errs = errorsFor((d) => { d.cases[0].expected = [vague]; });
    assert.ok(errs.some((e) => e.includes('states no observable outcome')), `"${vague}" slipped through: ${errs.join(' | ')}`);
  }
});

test('network-flavoured assertions are rejected when the host forbids them', () => {
  const errs = errorsFor((d) => {
    d.cases[0].expected = ['The POST /orders request returns status 201'];
  });
  assert.ok(errs.some((e) => e.includes('silently no-op')), errs.join('\n'));
});

test('network assertions are allowed when the host permits them', () => {
  const permissive = structuredClone(profile);
  permissive.assertions = { network_events: 'allowed', style: 'mixed' };
  const errs = errorsFor((d) => {
    d.cases[0].expected = ['The POST /orders request returns status 201'];
  }, permissive);
  assert.deepEqual(errs, []);
});

test('the 25-case cap is enforced', () => {
  const errs = errorsFor((d) => {
    const t = d.cases[0];
    d.cases = Array.from({ length: 26 }, (_, i) => ({
      ...structuredClone(t), id: `CHECKOUT-BULK-${String(i + 10).padStart(3, '0')}`,
    }));
  });
  assert.ok(errs.some((e) => e.includes('26 exceeds the 25-case cap')), errs.join('\n'));
});

test('case ids must follow the FEATURE-SUB-NNN grammar and be unique', () => {
  assert.ok(errorsFor((d) => { d.cases[0].id = 'checkout-1'; }).some((e) => e.includes('must match')));
  assert.ok(errorsFor((d) => { d.cases[1].id = d.cases[0].id; }).some((e) => e.includes('duplicate id')));
});

test('unapproved generation models are rejected', () => {
  const errs = errorsFor((d) => { d.model_version = 'some-new-model-9'; });
  assert.ok(errs.some((e) => e.includes('models.generation_approved')), errs.join('\n'));
});

test('scenario mix must declare every slot', () => {
  const errs = errorsFor((d) => { delete d.scenario_mix.permission; });
  assert.ok(errs.some((e) => e.includes('scenario_mix.permission: required')), errs.join('\n'));
});

test('a slot marked covered with no matching case is rejected', () => {
  const errs = errorsFor((d) => { d.scenario_mix['data-validation'] = 'covered'; });
  assert.ok(errs.some((e) => e.includes('marked covered but no case has that type')), errs.join('\n'));
});

test('a slot marked n_a while cases of that type exist is rejected', () => {
  const errs = errorsFor((d) => { d.scenario_mix.permission = { n_a: 'no roles here' }; });
  assert.ok(errs.some((e) => e.includes('marked n_a but cases of that type exist')), errs.join('\n'));
});

test('n_a requires a reason', () => {
  const errs = errorsFor((d) => { d.scenario_mix['data-validation'] = { n_a: '' }; });
  assert.ok(errs.some((e) => e.includes('give a reason')), errs.join('\n'));
});

test('an edge-type case satisfies the boundary slot', () => {
  const d = golden();
  assert.equal(d.cases.find((c) => c.type === 'edge').id, 'CHECKOUT-QTY-003');
  assert.deepEqual(validateCases(d, profile), []);
});

test('steps are required', () => {
  assert.ok(errorsFor((d) => { d.cases[0].steps = []; }).some((e) => e.includes('at least one step')));
});
