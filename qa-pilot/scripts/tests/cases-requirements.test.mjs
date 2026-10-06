import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from '../lib/yaml.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { validateCases, lintRequirements } from '../validate-cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../fixtures/host-fake');
const { profile } = loadProfile(resolve(FIXTURES, 'qa-pilot.config.yaml'));
const golden = () => parse(readFileSync(resolve(FIXTURES, 'testing/checkout/cases.yaml'), 'utf8'));

const ID = '^[A-Za-z0-9][A-Za-z0-9._-]*$';
const req = (id = 'R1', criteria = [{ id: 'C1', text: 'An order total is shown' }]) => ({ id, title: 'Orders', criteria });
const withReq = (requirements, cases = []) => ({ requirements, cases });
const errorsOf = (doc) => lintRequirements(doc).errors;
const warningsOf = (doc) => lintRequirements(doc).warnings;

// --- a file with neither key -----------------------------------------------------------

test('a file with neither requirements nor covers gets no errors and no warnings', () => {
  assert.deepEqual(lintRequirements({ cases: [{ id: 'ORD-LIST-001' }] }), { errors: [], warnings: [] });
  assert.deepEqual(lintRequirements({}), { errors: [], warnings: [] });
});

test('the golden cases file still validates, with no new warnings', () => {
  const errors = validateCases(golden(), profile);
  assert.deepEqual([...errors], []);
  assert.ok(!errors.warnings.some((w) => /covered by no case/.test(w)));
});

test('a valid block with full coverage gives nothing', () => {
  const doc = withReq([req('R1', [{ id: 'C1', text: 'x' }, { id: 'C2', text: 'y' }])], [{ id: 'ORD-LIST-001', covers: ['R1/C1', 'R1/C2'] }]);
  assert.deepEqual(lintRequirements(doc), { errors: [], warnings: [] });
});

// --- the requirements key --------------------------------------------------------------

test('requirements must be a non-empty list, null and [] included', () => {
  const msg = ['requirements: must be a non-empty list of { id, title, criteria }'];
  assert.deepEqual(errorsOf({ requirements: [] }), msg);
  assert.deepEqual(errorsOf({ requirements: null }), msg);
  assert.deepEqual(errorsOf({ requirements: 'R1' }), msg);
  assert.deepEqual(errorsOf({ requirements: { id: 'R1' } }), msg);
});

test('an entry must be a mapping', () => {
  assert.deepEqual(errorsOf({ requirements: ['R1'] }), ['requirements[0]: must be a mapping of id, title and criteria']);
  assert.deepEqual(errorsOf({ requirements: [req(), null] }), ['requirements[1]: must be a mapping of id, title and criteria']);
  assert.deepEqual(errorsOf({ requirements: [req(), [1]] }), ['requirements[1]: must be a mapping of id, title and criteria']);
});

test('an unknown entry key is an error', () => {
  assert.deepEqual(errorsOf({ requirements: [{ ...req(), owner: 'x' }] }), ['requirements[0].owner: unknown key (allowed: id, title, criteria)']);
});

test('an entry id that is missing or null is required', () => {
  assert.deepEqual(errorsOf({ requirements: [{ title: 'T', criteria: [{ id: 'C1', text: 'x' }] }] }), ['requirements[0].id: required']);
  assert.deepEqual(errorsOf({ requirements: [{ ...req(), id: null }] }), ['requirements[0].id: required']);
});

test('a non-string entry id gets its own message, never "must match"', () => {
  const msg = ['requirements[0].id: must be a string; quote it, e.g. id: "1"'];
  for (const id of [1, 1.1, true, ['R1'], { a: 1 }]) assert.deepEqual(errorsOf({ requirements: [{ ...req(), id }] }), msg);
});

test('a string entry id must match the pattern', () => {
  assert.deepEqual(errorsOf({ requirements: [req('-R1')] }), [`requirements[0].id: "-R1" must match ${ID}`]);
  assert.deepEqual(errorsOf({ requirements: [req('R 1')] }), [`requirements[0].id: "R 1" must match ${ID}`]);
  assert.deepEqual(errorsOf({ requirements: [req('')] }), [`requirements[0].id: "" must match ${ID}`]);
  assert.deepEqual(errorsOf({ requirements: [req('R/1')] }), [`requirements[0].id: "R/1" must match ${ID}`]);
});

test('a requirement id is capped at 64 characters', () => {
  assert.deepEqual(errorsOf({ requirements: [req('R'.repeat(64))] }), []);
  const long = 'R'.repeat(65);
  assert.deepEqual(errorsOf({ requirements: [req(long)] }), [`requirements[0].id: "${long}" must be at most 64 characters`]);
});

test('the 64 cap does not apply to criterion ids', () => {
  assert.deepEqual(errorsOf({ requirements: [req('R1', [{ id: 'C'.repeat(65), text: 'x' }])] }), []);
});

test('a requirement id used by an earlier entry is declared twice', () => {
  assert.deepEqual(errorsOf({ requirements: [req('R1'), req('R2'), req('R1')] }), ['requirements[2].id: "R1" is declared twice']);
});

test('an id gets at most one error, the first row in table order', () => {
  // a bad pattern and a bad length at once: only the pattern error
  const both = `-${'R'.repeat(70)}`;
  assert.deepEqual(errorsOf({ requirements: [req(both)] }), [`requirements[0].id: "${both}" must match ${ID}`]);
  // a repeat of an id that is itself invalid is reported as invalid, not as a duplicate
  assert.deepEqual(errorsOf({ requirements: [req('-R'), req('-R')] }), [
    `requirements[0].id: "-R" must match ${ID}`,
    `requirements[1].id: "-R" must match ${ID}`,
  ]);
});

test('a title must be a non-empty string', () => {
  const msg = ['requirements[0].title: required, non-empty string'];
  const noTitle = { id: 'R1', criteria: [{ id: 'C1', text: 'x' }] };
  assert.deepEqual(errorsOf({ requirements: [noTitle] }), msg);
  for (const title of [null, 5, '', '   ', ['T']]) assert.deepEqual(errorsOf({ requirements: [{ ...noTitle, title }] }), msg);
});

test('criteria must be a non-empty list', () => {
  const msg = ['requirements[0].criteria: required, at least one criterion'];
  assert.deepEqual(errorsOf({ requirements: [{ id: 'R1', title: 'T' }] }), msg);
  for (const criteria of [null, [], 'C1', { id: 'C1' }]) assert.deepEqual(errorsOf({ requirements: [req('R1', criteria)] }), msg);
});

// --- criteria --------------------------------------------------------------------------

test('a criterion must be a mapping', () => {
  assert.deepEqual(errorsOf({ requirements: [req('R1', ['C1'])] }), ['requirements[0].criteria[0]: must be a mapping of id and text']);
  assert.deepEqual(errorsOf({ requirements: [req('R1', [{ id: 'C1', text: 'x' }, null])] }), ['requirements[0].criteria[1]: must be a mapping of id and text']);
});

test('an unknown criterion key is an error', () => {
  assert.deepEqual(errorsOf({ requirements: [req('R1', [{ id: 'C1', text: 'x', priority: 'P0' }])] }), ['requirements[0].criteria[0].priority: unknown key (allowed: id, text)']);
});

test('a criterion id that is missing or null is required', () => {
  assert.deepEqual(errorsOf({ requirements: [req('R1', [{ text: 'x' }])] }), ['requirements[0].criteria[0].id: required']);
  assert.deepEqual(errorsOf({ requirements: [req('R1', [{ id: null, text: 'x' }])] }), ['requirements[0].criteria[0].id: required']);
});

test('a non-string criterion id gets its own message', () => {
  const msg = ['requirements[0].criteria[0].id: must be a string; quote it, e.g. id: "1"'];
  for (const id of [1, 2.5, false, ['C1']]) assert.deepEqual(errorsOf({ requirements: [req('R1', [{ id, text: 'x' }])] }), msg);
});

test('a string criterion id must match the pattern', () => {
  assert.deepEqual(errorsOf({ requirements: [req('R1', [{ id: '_C', text: 'x' }])] }), [`requirements[0].criteria[0].id: "_C" must match ${ID}`]);
});

test('a criterion id repeated in one requirement is declared twice there', () => {
  const doc = { requirements: [req('R1'), req('R2', [{ id: 'C1', text: 'x' }, { id: 'C2', text: 'y' }, { id: 'C1', text: 'z' }])] };
  assert.deepEqual(errorsOf(doc), ['requirements[1].criteria[2].id: "C1" is declared twice in requirements[1]']);
});

test('two requirements may each have the same criterion id', () => {
  assert.deepEqual(errorsOf({ requirements: [req('R1'), req('R2')] }), []);
});

test('a criterion text must be a non-empty string', () => {
  const msg = ['requirements[0].criteria[0].text: required, non-empty string'];
  assert.deepEqual(errorsOf({ requirements: [req('R1', [{ id: 'C1' }])] }), msg);
  for (const text of [null, 5, '', '  ', ['x']]) assert.deepEqual(errorsOf({ requirements: [req('R1', [{ id: 'C1', text }])] }), msg);
});

test('errors in a block are reported together, in entry order', () => {
  const doc = { requirements: [{ id: 1, title: '', criteria: [{ id: 'C1' }] }, { id: 'R2', title: 'T', criteria: [] }] };
  assert.deepEqual(errorsOf(doc), [
    'requirements[0].id: must be a string; quote it, e.g. id: "1"',
    'requirements[0].title: required, non-empty string',
    'requirements[0].criteria[0].text: required, non-empty string',
    'requirements[1].criteria: required, at least one criterion',
  ]);
});

// --- covers ----------------------------------------------------------------------------

test('covers must be a list of strings, null included', () => {
  const msg = (at) => [`cases[${at}].covers: must be a list of strings`];
  const doc = (covers) => withReq([req()], [{ id: 'ORD-LIST-001', covers }]);
  assert.deepEqual(errorsOf(doc(null)), msg('ORD-LIST-001'));
  assert.deepEqual(errorsOf(doc('R1/C1')), msg('ORD-LIST-001'));
  assert.deepEqual(errorsOf(doc({ 'R1/C1': 1 })), msg('ORD-LIST-001'));
  assert.deepEqual(errorsOf(doc(['R1/C1', 5])), msg('ORD-LIST-001'));
});

test('a case without an id is addressed by its zero-based position', () => {
  const doc = withReq([req()], [{ id: 'ORD-LIST-001', covers: ['R1/C1'] }, { covers: 'R1/C1' }, 'not a case', { id: 7, covers: null }]);
  assert.deepEqual(errorsOf(doc), ['cases[1].covers: must be a list of strings', 'cases[3].covers: must be a list of strings']);
});

test('a covers entry must have the form <requirement id>/<criterion id>', () => {
  const form = (e) => `cases[ORD-LIST-001].covers: "${e}" must have the form <requirement id>/<criterion id>`;
  const doc = (...covers) => withReq([req()], [{ id: 'ORD-LIST-001', covers }]);
  for (const e of ['R1', 'R1/', '/C1', 'R1/C1/C2', 'R 1/C1', '-R/C1', '']) assert.deepEqual(errorsOf(doc(e)), [form(e)]);
});

test('a well-formed covers entry must name a declared criterion', () => {
  const doc = (...covers) => withReq([req()], [{ id: 'ORD-LIST-001', covers }]);
  assert.deepEqual(errorsOf(doc('R1/C9')), ['cases[ORD-LIST-001].covers: "R1/C9" names no declared criterion']);
  assert.deepEqual(errorsOf(doc('R9/C1')), ['cases[ORD-LIST-001].covers: "R9/C1" names no declared criterion']);
  assert.deepEqual(errorsOf(doc('R1/C1')), []);
});

test('covers entries resolve per requirement, not across them', () => {
  const doc = withReq([req('R1', [{ id: 'C1', text: 'x' }]), req('R2', [{ id: 'C2', text: 'y' }])], [{ id: 'ORD-LIST-001', covers: ['R1/C2'] }]);
  assert.deepEqual(errorsOf(doc), ['cases[ORD-LIST-001].covers: "R1/C2" names no declared criterion']);
});

test('every bad covers entry is reported, in list order', () => {
  const doc = withReq([req()], [{ id: 'ORD-LIST-001', covers: ['R1/C9', 'R1', 'R1/C1'] }]);
  assert.deepEqual(errorsOf(doc), [
    'cases[ORD-LIST-001].covers: "R1/C9" names no declared criterion',
    'cases[ORD-LIST-001].covers: "R1" must have the form <requirement id>/<criterion id>',
  ]);
});

test('covers with no requirements key says so, even as an empty list', () => {
  const used = (at) => `cases[${at}].covers: used, but no requirements are declared`;
  assert.deepEqual(errorsOf({ cases: [{ id: 'ORD-LIST-001', covers: ['R1/C1'] }] }), [used('ORD-LIST-001')]);
  assert.deepEqual(errorsOf({ cases: [{ id: 'ORD-LIST-001', covers: [] }] }), [used('ORD-LIST-001')]);
  assert.deepEqual(errorsOf({ cases: [{ covers: ['bad'] }] }), [used(0)]);
});

test('covers: null with no requirements gives both lines, list message first', () => {
  assert.deepEqual(errorsOf({ cases: [{ id: 'ORD-LIST-001', covers: null }] }), [
    'cases[ORD-LIST-001].covers: must be a list of strings',
    'cases[ORD-LIST-001].covers: used, but no requirements are declared',
  ]);
});

test('with no requirements, a mixed covers list skips the form and resolution rows', () => {
  assert.deepEqual(errorsOf({ cases: [{ id: 'ORD-LIST-001', covers: ['R1/C1', 5, 'nonsense'] }] }), [
    'cases[ORD-LIST-001].covers: must be a list of strings',
    'cases[ORD-LIST-001].covers: used, but no requirements are declared',
  ]);
});

test('a mixed covers list still checks, resolves and counts its string entries', () => {
  const doc = withReq([req('R1', [{ id: 'C1', text: 'x' }, { id: 'C2', text: 'y' }])], [{ id: 'ORD-LIST-001', covers: ['R1/C1', 5, 'R1/C9', 'bad'] }]);
  const { errors, warnings } = lintRequirements(doc);
  assert.deepEqual(errors, [
    'cases[ORD-LIST-001].covers: must be a list of strings',
    'cases[ORD-LIST-001].covers: "R1/C9" names no declared criterion',
    'cases[ORD-LIST-001].covers: "bad" must have the form <requirement id>/<criterion id>',
  ]);
  assert.deepEqual(warnings, ['criterion R1/C2 is covered by no case']);
});

test('covers against an empty or non-list requirements is not resolved', () => {
  const cases = [{ id: 'ORD-LIST-001', covers: ['R1/C1'] }];
  assert.deepEqual(errorsOf({ requirements: [], cases }), ['requirements: must be a non-empty list of { id, title, criteria }']);
  assert.deepEqual(errorsOf({ requirements: null, cases }), ['requirements: must be a non-empty list of { id, title, criteria }']);
});

test('covers resolves against the entries and criteria whose ids are strings', () => {
  // the numeric requirement id is an error, but the valid sibling still resolves
  const doc = withReq([req(1), req('R2')], [{ id: 'ORD-LIST-001', covers: ['R2/C1', 'R1/C1'] }]);
  assert.deepEqual(errorsOf(doc), [
    'requirements[0].id: must be a string; quote it, e.g. id: "1"',
    'cases[ORD-LIST-001].covers: "R1/C1" names no declared criterion',
  ]);
});

// --- warnings --------------------------------------------------------------------------

test('an uncovered criterion is a warning, in declaration order, one per criterion', () => {
  const doc = withReq(
    [req('R1', [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }]), req('R2', [{ id: 'C1', text: 'c' }, { id: 'C2', text: 'd' }])],
    [{ id: 'ORD-LIST-001', covers: ['R2/C1', 'R1/C2'] }],
  );
  assert.deepEqual(lintRequirements(doc), {
    errors: [],
    warnings: ['criterion R1/C1 is covered by no case', 'criterion R2/C2 is covered by no case'],
  });
});

test('with no cases at all every criterion is a warning', () => {
  assert.deepEqual(warningsOf({ requirements: [req('R1', [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }])] }), [
    'criterion R1/C1 is covered by no case',
    'criterion R1/C2 is covered by no case',
  ]);
});

test('only covers entries that resolve count toward coverage', () => {
  const doc = withReq([req()], [{ id: 'ORD-LIST-001', covers: ['R1/C9', 'R1'] }]);
  assert.deepEqual(warningsOf(doc), ['criterion R1/C1 is covered by no case']);
});

test('a covers error alone never suppresses the warnings', () => {
  const doc = withReq([req('R1', [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }])], [{ id: 'ORD-LIST-001', covers: ['R1/C1', 'R1/C9'] }]);
  const { errors, warnings } = lintRequirements(doc);
  assert.equal(errors.length, 1);
  assert.deepEqual(warnings, ['criterion R1/C2 is covered by no case']);
});

test('an error in the requirements block suppresses every warning', () => {
  const doc = { requirements: [req('R1', [{ id: 'C1', text: 'a' }]), { ...req('R2'), owner: 'x' }], cases: [] };
  const { errors, warnings } = lintRequirements(doc);
  assert.equal(errors.length, 1);
  assert.deepEqual(warnings, []);
  assert.deepEqual(warningsOf({ requirements: [] }), []);
});

// --- folded into validateCases ---------------------------------------------------------

test('validateCases carries the requirement errors and warnings', () => {
  const d = golden();
  d.requirements = [req('R1', [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }])];
  d.cases[0].covers = ['R1/C1', 'R1/C9'];
  const errors = validateCases(d, profile);
  assert.deepEqual([...errors], [`cases[${d.cases[0].id}].covers: "R1/C9" names no declared criterion`]);
  assert.ok(errors.warnings.includes('criterion R1/C2 is covered by no case'));
});

test('validateCases with a clean block adds warnings and no errors', () => {
  const d = golden();
  d.requirements = [req('R1', [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }])];
  d.cases[0].covers = ['R1/C1'];
  const errors = validateCases(d, profile);
  assert.deepEqual([...errors], []);
  assert.ok(errors.warnings.includes('criterion R1/C2 is covered by no case'));
  assert.ok(!errors.warnings.includes('criterion R1/C1 is covered by no case'));
});

test('validateCases rejects covers when no requirements are declared', () => {
  const d = golden();
  d.cases[0].covers = ['R1/C1'];
  assert.deepEqual([...validateCases(d, profile)], [`cases[${d.cases[0].id}].covers: used, but no requirements are declared`]);
});

test('the CLI prints requirement warnings as "warning: <text>" and still exits 0', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const d = golden();
  d.requirements = [req('R1', [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }])];
  d.cases[0].covers = ['R1/C1'];
  const root = mkdtempSync(resolve(tmpdir(), 'req-lint-'));
  try {
    const dir = resolve(root, d.feature);
    mkdirSync(dir);
    const file = resolve(dir, 'cases.yaml');
    // the repo's own yaml reader is parse-only; JSON is valid YAML
    writeFileSync(file, JSON.stringify(d));
    const r = spawnSync(process.execPath, [resolve(HERE, '../validate-cases.mjs'), file, '--profile', resolve(FIXTURES, 'qa-pilot.config.yaml')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^warning: criterion R1\/C2 is covered by no case$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
