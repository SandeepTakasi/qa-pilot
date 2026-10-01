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

const MUTATION = () => ({
  deny_controls: { text: ['^Wipe$'], icons: ['fa-bomb'] },
  write_signatures: [
    { method: 'POST', url: '/graphql$', body: '"query"\\s*:\\s*"mutation', note: 'GraphQL mutation' },
    { method: '*', url: '/upload' },
  ],
  allow_signatures: [{ method: 'POST', url: '/search' }],
});

const addProduction = (p) => {
  p.environments.production = {
    kind: 'production',
    apps: { storefront: 'https://app.host-fake.example.com' },
    sha_source: { url: 'https://app.host-fake.example.com/api/version', json_path: 'build.commit' },
  };
};

// --- tracker ---------------------------------------------------------------------

test('tracker defaults to clickup, which keeps the clickup block required', () => {
  assert.ok(has(errorsFor((p) => { delete p.clickup; }), /^clickup: required/));
  assert.ok(has(errorsFor((p) => { p.tracker = 'clickup'; delete p.clickup; }), /^clickup: required/));
});

test('tracker must be clickup or none', () => {
  assert.ok(has(errorsFor((p) => { p.tracker = 'jira'; }), /tracker: .*clickup \| none/));
});

test('tracker: none needs no clickup block', () => {
  const { errors, profile } = run((p) => { p.tracker = 'none'; delete p.clickup; });
  assert.deepEqual(errors, []);
  assert.equal(profile.tracker, 'none');
});

test('tracker: none ignores a clickup block, warns, and removes it from the normalized profile', () => {
  const { errors, warnings, profile } = run((p) => { p.tracker = 'none'; p.clickup = { nonsense: true }; });
  assert.deepEqual(errors, [], 'the ignored block is not validated');
  assert.ok(has(warnings, /clickup: .*ignored under tracker: none/), warnings.join('\n'));
  assert.equal(Object.hasOwn(profile, 'clickup'), false);
});

test('tracker: none makes every environment local and warns about an explicit tracker upload', () => {
  const { errors, warnings, profile } = run((p) => {
    p.tracker = 'none';
    delete p.clickup;
    p.environments.qa.evidence_upload = 'tracker';
  });
  assert.deepEqual(errors, []);
  assert.equal(profile.environments.qa.evidence_upload, 'local');
  assert.equal(profile.environments.staging.evidence_upload, 'local');
  assert.ok(has(warnings, /environments\.qa\.evidence_upload: tracker is ignored under tracker: none/), warnings.join('\n'));
});

test('effectiveEvidenceUpload is local under tracker: none whatever the environment says', () => {
  assert.equal(effectiveEvidenceUpload({ kind: 'qa' }, { tracker: 'none' }), 'local');
  assert.equal(effectiveEvidenceUpload({ kind: 'qa', evidence_upload: 'tracker' }, { tracker: 'none' }), 'local');
  assert.equal(effectiveEvidenceUpload({ kind: 'qa' }, { tracker: 'clickup' }), 'tracker');
});

// --- context.sources -------------------------------------------------------------

const withSources = (sources) => (p) => { p.context = { sources }; };

test('a context source with a command or a path is valid', () => {
  assert.deepEqual(errorsFor(withSources([
    { name: 'design', description: 'Design system docs, read for any UI feature', path: 'docs/design/**/*.md' },
    { name: 'model', description: 'The product model, read for domain rules', command: 'npm run -s docs:model' },
  ])), []);
});

test('a source needs exactly one of command or path', () => {
  assert.ok(has(errorsFor(withSources([{ name: 'a', description: 'x' }])), /context\.sources\[0\]: set exactly one of command \| path/));
  assert.ok(has(errorsFor(withSources([{ name: 'a', description: 'x', command: 'ls', path: 'docs' }])), /exactly one of command \| path/));
  assert.ok(has(errorsFor(withSources([{ name: 'a', description: 'x', path: '' }])), /exactly one of command \| path/));
});

test('a source needs a non-empty name and description, and names are unique', () => {
  assert.ok(has(errorsFor(withSources([{ description: 'x', path: 'docs' }])), /context\.sources\[0\]\.name: required/));
  assert.ok(has(errorsFor(withSources([{ name: 'a', description: ' ', path: 'docs' }])), /context\.sources\[0\]\.description: required/));
  assert.ok(has(errorsFor(withSources([
    { name: 'a', description: 'x', path: 'docs' }, { name: 'a', description: 'y', path: 'more' },
  ])), /context\.sources\[1\]\.name: "a" is used twice/));
});

test('a path whose last segment is an env file is an error', () => {
  for (const path of ['.env', '.env.local', 'config/.env.production', '**/.env*']) {
    assert.ok(has(errorsFor(withSources([{ name: 'a', description: 'x', path }])), /context\.sources\[0\]\.path: .*\.env/), path);
  }
  assert.deepEqual(errorsFor(withSources([{ name: 'a', description: 'x', path: 'docs/environment.md' }])), []);
});

test('context must hold a non-empty sources list and nothing else', () => {
  assert.ok(has(errorsFor((p) => { p.context = {}; }), /context\.sources: required, a non-empty list/));
  assert.ok(has(errorsFor(withSources([])), /context\.sources: required, a non-empty list/));
  assert.ok(has(errorsFor((p) => { p.context = { sources: [{ name: 'a', description: 'x', path: 'd' }], extra: 1 }; }), /context\.extra: unknown key/));
  assert.ok(has(errorsFor(withSources([{ name: 'a', description: 'x', path: 'd', url: 'x' }])), /context\.sources\[0\]\.url: unknown key/));
});

// --- mutation ---------------------------------------------------------------------

test('a well-formed mutation block is valid and kept in the normalized profile', () => {
  const { errors, profile } = run((p) => { p.mutation = MUTATION(); });
  assert.deepEqual(errors, []);
  assert.equal(profile.mutation.write_signatures.length, 2);
});

test('production requires a mutation block with at least one write signature', () => {
  assert.ok(has(errorsFor(addProduction), /mutation: required when any environment has kind production/));
  assert.ok(has(errorsFor((p) => { addProduction(p); p.mutation = { write_signatures: [] }; }),
    /mutation\.write_signatures: at least one entry is required when any environment has kind production/));
  assert.deepEqual(errorsFor((p) => { addProduction(p); p.mutation = MUTATION(); }), []);
});

test('mutation stays optional, and write_signatures may be empty, with no production environment', () => {
  assert.deepEqual(errorsFor((p) => { p.mutation = { deny_controls: { text: ['wipe'] } }; }), []);
  assert.deepEqual(errorsFor((p) => { p.mutation = { write_signatures: [] }; }), []);
});

test('a signature method must be an uppercase HTTP verb or *', () => {
  for (const method of ['post', 'FETCH', undefined]) {
    const m = MUTATION();
    m.write_signatures[0].method = method;
    assert.ok(has(errorsFor((p) => { p.mutation = m; }), /mutation\.write_signatures\[0\]\.method: must be one of GET \| HEAD/), String(method));
  }
});

test('signature url is required and every regex must compile', () => {
  const noUrl = MUTATION(); delete noUrl.write_signatures[1].url;
  assert.ok(has(errorsFor((p) => { p.mutation = noUrl; }), /mutation\.write_signatures\[1\]\.url: required/));
  const badUrl = MUTATION(); badUrl.allow_signatures[0].url = '(';
  assert.ok(has(errorsFor((p) => { p.mutation = badUrl; }), /mutation\.allow_signatures\[0\]\.url: does not compile/));
  const badBody = MUTATION(); badBody.write_signatures[0].body = '[';
  assert.ok(has(errorsFor((p) => { p.mutation = badBody; }), /mutation\.write_signatures\[0\]\.body: does not compile/));
  const badText = MUTATION(); badText.deny_controls.text = ['('];
  assert.ok(has(errorsFor((p) => { p.mutation = badText; }), /mutation\.deny_controls\.text\[0\]: does not compile/));
});

test('deny icons must be non-empty strings and note must be a string', () => {
  const m = MUTATION(); m.deny_controls.icons = [''];
  assert.ok(has(errorsFor((p) => { p.mutation = m; }), /mutation\.deny_controls\.icons\[0\]/));
  const n = MUTATION(); n.write_signatures[0].note = 3;
  assert.ok(has(errorsFor((p) => { p.mutation = n; }), /mutation\.write_signatures\[0\]\.note: must be a string/));
});

test('unknown keys anywhere in mutation are errors, so a typo cannot leave the guard blind', () => {
  assert.ok(has(errorsFor((p) => { p.mutation = { write_signature: [{ method: 'POST', url: 'x' }] }; }), /mutation\.write_signature: unknown key/));
  const d = MUTATION(); d.deny_controls.labels = ['x'];
  assert.ok(has(errorsFor((p) => { p.mutation = d; }), /mutation\.deny_controls\.labels: unknown key/));
  const s = MUTATION(); s.write_signatures[0].headers = 'x';
  assert.ok(has(errorsFor((p) => { p.mutation = s; }), /mutation\.write_signatures\[0\]\.headers: unknown key/));
});

test('mutation and its lists must have the right shapes', () => {
  assert.ok(has(errorsFor((p) => { p.mutation = 'yes'; }), /mutation: must be a mapping/));
  assert.ok(has(errorsFor((p) => { p.mutation = { write_signatures: { method: 'POST' } }; }), /mutation\.write_signatures: must be a list/));
  assert.ok(has(errorsFor((p) => { p.mutation = { write_signatures: ['POST /x'] }; }), /mutation\.write_signatures\[0\]: must be a mapping/));
  assert.ok(has(errorsFor((p) => { p.mutation = { deny_controls: ['x'] }; }), /mutation\.deny_controls: must be a mapping/));
});
