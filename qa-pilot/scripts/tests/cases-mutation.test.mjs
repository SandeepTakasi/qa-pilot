import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { validateCases, lintMutation } from '../validate-cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const { profile } = loadProfile(resolve(FIXTURES, 'qa-pilot.config.yaml'));
const golden = () => parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8'));
const lint = (mutate) => { const d = golden(); mutate(d); return validateCases(d, profile); };
const has = (list, re) => list.some((m) => re.test(m));

const SCOPED = { policy: 'scoped-write', prefix: 'QA_TEST_' };

// --- mutation -----------------------------------------------------------------------

test('a cases file with no mutation stays valid (the default is unrestricted)', () => {
  assert.deepEqual(lint(() => {}), []);
});

test('each policy is accepted in its legal shape', () => {
  assert.deepEqual(lint((d) => { d.mutation = { policy: 'read-only' }; }), []);
  assert.deepEqual(lint((d) => { d.mutation = { policy: 'unrestricted' }; }), []);
  assert.deepEqual(lint((d) => { d.mutation = { ...SCOPED }; }), []);
});

test('mutation must be a mapping with a known policy', () => {
  assert.ok(has(lint((d) => { d.mutation = 'read-only'; }), /mutation: must be a mapping/));
  assert.ok(has(lint((d) => { d.mutation = {}; }), /mutation\.policy: required/));
  assert.ok(has(lint((d) => { d.mutation = { policy: 'readonly' }; }), /mutation\.policy: .*read-only \| scoped-write \| unrestricted/));
});

test('unknown keys under mutation are errors', () => {
  assert.ok(has(lint((d) => { d.mutation = { policy: 'read-only', scope: 'x' }; }), /mutation\.scope: unknown key/));
});

test('scoped-write needs a prefix of at least three safe characters', () => {
  assert.ok(has(lint((d) => { d.mutation = { policy: 'scoped-write' }; }), /mutation\.prefix: required under scoped-write/));
  for (const prefix of ['QA', 'QA TEST', 'qa.test', '']) {
    assert.ok(has(lint((d) => { d.mutation = { policy: 'scoped-write', prefix }; }), /mutation\.prefix: .*\[A-Za-z0-9_-\]\{3,\}/), JSON.stringify(prefix));
  }
});

test('a prefix is forbidden under any other policy', () => {
  for (const policy of ['read-only', 'unrestricted']) {
    assert.ok(has(lint((d) => { d.mutation = { policy, prefix: 'QA_TEST_' }; }), /mutation\.prefix: only allowed under scoped-write/), policy);
  }
});

// --- fixtures -----------------------------------------------------------------------

const withFixture = (d, fixtures = [{ name: 'shared-project', teardown: 'delete' }]) => {
  d.mutation = { ...SCOPED };
  d.fixtures = fixtures;
  d.cases[0].fixture = fixtures[0]?.name;
};

test('a declared fixture that a case names is valid', () => {
  assert.deepEqual(lint((d) => withFixture(d)), []);
  assert.deepEqual(lint((d) => withFixture(d, [{ name: 'p1', teardown: 'keep' }])), []);
});

test('fixtures must be a list of mappings with a valid name and teardown', () => {
  assert.ok(has(lint((d) => { d.fixtures = { name: 'x' }; }), /fixtures: must be a list/));
  assert.ok(has(lint((d) => { d.fixtures = ['x']; }), /fixtures\[0\]: must be a mapping/));
  assert.ok(has(lint((d) => withFixture(d, [{ teardown: 'keep' }])), /fixtures\[0\]\.name: required/));
  assert.ok(has(lint((d) => withFixture(d, [{ name: 'Shared_Project', teardown: 'keep' }])), /fixtures\[0\]\.name: .*\^\[a-z0-9-\]\+\$/));
  assert.ok(has(lint((d) => withFixture(d, [{ name: 'p1' }])), /fixtures\[0\]\.teardown: .*keep \| delete/));
  assert.ok(has(lint((d) => withFixture(d, [{ name: 'p1', teardown: 'drop' }])), /fixtures\[0\]\.teardown: .*keep \| delete/));
});

test('fixture names are unique', () => {
  assert.ok(has(lint((d) => withFixture(d, [{ name: 'p1', teardown: 'keep' }, { name: 'p1', teardown: 'delete' }])),
    /fixtures\[1\]\.name: "p1" is declared twice/));
});

test('fixtures are refused under read-only: nothing can be created', () => {
  const errs = lint((d) => { withFixture(d); d.mutation = { policy: 'read-only' }; });
  assert.ok(has(errs, /fixtures: not allowed under mutation\.policy: read-only/), errs.join('\n'));
});

test('fixtures are allowed when mutation is absent (unrestricted)', () => {
  assert.deepEqual(lint((d) => { withFixture(d); delete d.mutation; }), []);
});

test('a case must name a declared fixture', () => {
  assert.ok(has(lint((d) => { withFixture(d); d.cases[1].fixture = 'missing'; }), /cases\[[A-Z0-9-]+\]\.fixture: "missing" is not declared in fixtures/));
  assert.ok(has(lint((d) => { d.cases[0].fixture = 'p1'; }), /cases\[[A-Z0-9-]+\]\.fixture: "p1" is not declared in fixtures/));
  assert.ok(has(lint((d) => { withFixture(d); d.cases[1].fixture = 3; }), /cases\[[A-Z0-9-]+\]\.fixture: must be a fixture name/));
});

test('a declared fixture no case names is a warning, not an error', () => {
  const errs = lint((d) => { withFixture(d); delete d.cases[0].fixture; });
  assert.deepEqual([...errs], []);
  assert.ok(has(errs.warnings, /fixtures\[0\]: "shared-project" is named by no case/), errs.warnings.join('\n'));
});

// --- the same lint, reusable by the publish gate ---------------------------------------

test('lintMutation returns the mutation and fixture findings on their own', () => {
  const d = golden();
  d.mutation = { policy: 'scoped-write' };
  const { errors, warnings } = lintMutation(d);
  assert.ok(has(errors, /mutation\.prefix: required/));
  assert.deepEqual(warnings, []);
  assert.deepEqual(lintMutation(golden()), { errors: [], warnings: [], policy: 'unrestricted' });
  const ro = golden();
  ro.mutation = { policy: 'read-only' };
  assert.equal(lintMutation(ro).policy, 'read-only');
});
