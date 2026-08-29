import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadProfile } from '../lib/profile.mjs';
import { pluck, extractSha, readEnvSha } from '../read-env-sha.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { profile } = loadProfile(resolve(HERE, '../../../fixtures/host-fake/qa-pilot.config.yaml'));
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

const fakeFetch = (body, { ok = true, status = 200 } = {}) => async () => ({
  ok, status, text: async () => body,
});

test('pluck walks dot paths including array indices', () => {
  const o = { build: { commit: 'abc' }, list: [{ sha: 'def' }] };
  assert.equal(pluck(o, 'build.commit'), 'abc');
  assert.equal(pluck(o, 'list.0.sha'), 'def');
  assert.equal(pluck(o, 'build.missing'), undefined);
  assert.equal(pluck(o, 'nope.deep.path'), undefined);
});

test('extracts a SHA via json_path', () => {
  const body = JSON.stringify({ build: { commit: SHA, at: '2026-08-30' } });
  assert.equal(extractSha(body, { json_path: 'build.commit' }), SHA);
});

test('extracts a SHA via regex', () => {
  const body = `<meta name="build" content="commit=${SHA}">`;
  assert.equal(extractSha(body, { regex: 'commit=([a-f0-9]+)' }), SHA);
});

test('accepts a short SHA and normalizes case', () => {
  assert.equal(extractSha(JSON.stringify({ c: 'A1B2C3D' }), { json_path: 'c' }), 'a1b2c3d');
});

test('rejects a value that is not a SHA — a wrong path must not stamp a fake provenance', () => {
  assert.throws(() => extractSha(JSON.stringify({ build: { commit: 'v2.14.3' } }),
    { json_path: 'build.commit' }), /not a commit SHA/);
  assert.throws(() => extractSha(JSON.stringify({ build: { commit: 1234 } }),
    { json_path: 'build.commit' }), /not a commit SHA/);
});

test('reports a missing json_path rather than guessing', () => {
  assert.throws(() => extractSha(JSON.stringify({ version: SHA }), { json_path: 'build.commit' }),
    /is not present in the response/);
});

test('reports non-JSON responses when json_path is configured', () => {
  assert.throws(() => extractSha('<html>Not Found</html>', { json_path: 'build.commit' }),
    /did not return JSON/);
});

test('reports a non-matching regex', () => {
  assert.throws(() => extractSha('nothing here', { regex: 'commit=([a-f0-9]+)' }), /did not match/);
});

test('readEnvSha returns sha plus its source', async () => {
  const out = await readEnvSha(profile, 'qa', 'storefront', {
    fetchImpl: fakeFetch(JSON.stringify({ build: { commit: SHA } })),
  });
  assert.equal(out.sha, SHA);
  assert.equal(out.source, 'https://qa.host-fake.example.com/api/version');
  assert.equal(out.env, 'qa');
  assert.ok(!Number.isNaN(Date.parse(out.fetched_at)));
});

test('unregistered environments are refused, and the message lists the registered ones', async () => {
  await assert.rejects(
    () => readEnvSha(profile, 'my-laptop', 'storefront', { fetchImpl: fakeFetch('{}') }),
    /not in the registry \(registered: qa, staging\)/
  );
});

test('an app with no URL in that environment is refused', async () => {
  await assert.rejects(
    () => readEnvSha(profile, 'qa', 'ghost-app', { fetchImpl: fakeFetch('{}') }),
    /has no URL in environment "qa"/
  );
});

test('an HTTP error is surfaced, not swallowed', async () => {
  await assert.rejects(
    () => readEnvSha(profile, 'qa', 'storefront', { fetchImpl: fakeFetch('', { ok: false, status: 503 }) }),
    /HTTP 503/
  );
});

test('an unreachable source says why it matters', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    () => readEnvSha(profile, 'qa', 'storefront', { fetchImpl: boom }),
    /cannot be published/
  );
});
