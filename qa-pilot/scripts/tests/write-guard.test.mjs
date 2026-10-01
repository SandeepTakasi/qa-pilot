import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DENY, compileConfig, decideControl, decideRequest,
} from '../../templates/write-guard.mjs';

const cfg = (raw = null) => compileConfig(raw, DEFAULT_DENY);

// A GraphQL-style host: queries and mutations share one URL, and only the body tells
// them apart. This is the case URL + method alone cannot handle.
const GRAPHQL = {
  write_signatures: [
    { method: 'POST', url: '/graphql$', body: '"query"\\s*:\\s*"\\s*mutation\\b', note: 'GraphQL mutation' },
    { method: 'DELETE', url: '/api/', note: 'any REST delete' },
    { method: '*', url: '/upload' },
  ],
  allow_signatures: [
    { method: 'POST', url: '/api/search' },
  ],
};

// --- defaults -------------------------------------------------------------------

test('the defaults are plain JSON, so they can be injected into a page as source', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_DENY)), DEFAULT_DENY);
  assert.ok(DEFAULT_DENY.text.every((w) => typeof w === 'string'));
  assert.ok(DEFAULT_DENY.icons.every((w) => typeof w === 'string'));
});

test('the defaults are generic verbs and generic icon names', () => {
  for (const w of ['save', 'delete', 'publish', 'submit', 'upload', 'rename', 'sign out']) {
    assert.ok(DEFAULT_DENY.text.includes(w), w);
  }
  for (const i of ['mdi-delete', 'mdi-pencil', 'mdi-share']) assert.ok(DEFAULT_DENY.icons.includes(i), i);
});

// --- compileConfig ----------------------------------------------------------------

test('with no host config the guard has the defaults and no write signatures', () => {
  const c = cfg(null);
  assert.equal(c.writes.length, 0);
  assert.ok(c.text.test('Delete'));
  assert.ok(c.icons.includes('mdi-delete'));
});

test('host deny words and icons are added to the defaults, never replacing them', () => {
  const c = cfg({ deny_controls: { text: ['^Archive forever$', 'wipe'], icons: ['fa-bomb'] } });
  assert.ok(c.text.test('Save'), 'default still applies');
  assert.ok(c.text.test('WIPE it'), 'host word, case-insensitive');
  assert.ok(c.icons.includes('mdi-delete') && c.icons.includes('fa-bomb'));
});

test('compileConfig does not change the defaults it was given', () => {
  const before = JSON.stringify(DEFAULT_DENY);
  cfg({ deny_controls: { text: ['wipe'], icons: ['fa-bomb'] } });
  assert.equal(JSON.stringify(DEFAULT_DENY), before);
});

test('a default word matches as a word, not inside another word', () => {
  const c = cfg();
  assert.ok(c.text.test('Save changes'));
  assert.ok(!c.text.test('Saved searches'), 'saved is not save');
  assert.ok(c.text.test('Log out'));
});

test('signatures compile with their method and optional body', () => {
  const c = cfg(GRAPHQL);
  assert.equal(c.writes.length, 3);
  assert.equal(c.writes[0].method, 'POST');
  assert.ok(c.writes[0].body instanceof RegExp);
  assert.equal(c.writes[1].body, null);
  assert.equal(c.allows.length, 1);
});

test('a regex that does not compile throws, naming where it is', () => {
  assert.throws(() => cfg({ write_signatures: [{ method: 'POST', url: '(' }] }), /write_signatures\[0\]\.url/);
  assert.throws(() => cfg({ deny_controls: { text: ['['] } }), /deny_controls\.text\[0\]/);
  assert.throws(() => cfg({ allow_signatures: [{ method: 'GET', url: 'x', body: '(' }] }), /allow_signatures\[0\]\.body/);
});

test('a method outside the verb set throws', () => {
  assert.throws(() => cfg({ write_signatures: [{ method: 'post', url: 'x' }] }), /method/);
  assert.throws(() => cfg({ write_signatures: [{ method: 'FETCH', url: 'x' }] }), /method/);
});

test('a config that is not a mapping throws rather than guarding nothing', () => {
  assert.throws(() => cfg('write_signatures'), /mapping/);
  assert.throws(() => cfg({ write_signatures: 'POST /api' }), /write_signatures/);
});

// --- decideControl ------------------------------------------------------------------

const control = (label, extra = {}) => ({ label, icons: [], pageUrl: 'https://app.test/projects', ownRowText: '', ...extra });

test('a control that is not a write is allowed under every policy', () => {
  for (const policy of ['read-only', 'scoped-write', 'unrestricted']) {
    assert.equal(decideControl(control('Open details'), { policy, prefix: 'QA_T_' }, cfg()).action, 'allow', policy);
  }
});

test('a write control: unrestricted allows, read-only blocks', () => {
  assert.equal(decideControl(control('Delete'), { policy: 'unrestricted' }, cfg()).action, 'allow');
  const v = decideControl(control('Delete'), { policy: 'read-only' }, cfg());
  assert.equal(v.action, 'block');
  assert.match(v.reason, /read-only/);
});

test('an icon-only control is recognised by icon class prefix', () => {
  const v = decideControl(control('', { icons: ['v-icon', 'mdi-delete-outline'] }), { policy: 'read-only' }, cfg());
  assert.equal(v.action, 'block');
});

test('scoped-write allows a write control whose own row carries the prefix', () => {
  const s = { policy: 'scoped-write', prefix: 'QA_TEST_' };
  assert.equal(decideControl(control('Delete', { ownRowText: 'QA_TEST_alpha  3 items' }), s, cfg()).action, 'allow');
  assert.equal(decideControl(control('Delete', { ownRowText: 'Customer project' }), s, cfg()).action, 'block');
});

test('scoped-write allows a write control on a page inside the scope URL', () => {
  const s = { policy: 'scoped-write', prefix: 'QA_TEST_', scopeUrl: '/projects/p-123(/|$)' };
  assert.equal(decideControl(control('Save', { pageUrl: 'https://app.test/projects/p-123/edit' }), s, cfg()).action, 'allow');
  assert.equal(decideControl(control('Save', { pageUrl: 'https://app.test/projects/p-999/edit' }), s, cfg()).action, 'block');
});

test('an unparseable scope URL blocks rather than throwing inside a click listener', () => {
  const s = { policy: 'scoped-write', prefix: 'QA_TEST_', scopeUrl: '(' };
  assert.equal(decideControl(control('Save'), s, cfg()).action, 'block');
});

test('an unknown or missing policy blocks write controls', () => {
  assert.equal(decideControl(control('Delete'), { policy: 'readonly' }, cfg()).action, 'block');
  assert.equal(decideControl(control('Delete'), {}, cfg()).action, 'block');
});

// --- decideRequest ------------------------------------------------------------------

const req = (method, url, body = null) => ({ method, url, body });
const MUTATION = JSON.stringify({ query: 'mutation Rename { rename(id: 1) { id } }' });
const QUERY = JSON.stringify({ query: 'query List { projects { id } }' });

test('a body signature separates a mutation from a query on the same URL', () => {
  const c = cfg(GRAPHQL);
  assert.equal(decideRequest(req('POST', 'https://api.test/graphql', QUERY), { policy: 'read-only' }, c).action, 'allow');
  assert.equal(decideRequest(req('POST', 'https://api.test/graphql', MUTATION), { policy: 'read-only' }, c).action, 'block');
});

test('a request with no body never matches a body signature', () => {
  const c = cfg(GRAPHQL);
  assert.equal(decideRequest(req('POST', 'https://api.test/graphql', null), { policy: 'read-only' }, c).action, 'allow');
});

test('a write request: read-only blocks, scoped-write and unrestricted observe', () => {
  const c = cfg(GRAPHQL);
  const r = req('DELETE', 'https://api.test/api/projects/1');
  assert.equal(decideRequest(r, { policy: 'read-only' }, c).action, 'block');
  assert.equal(decideRequest(r, { policy: 'scoped-write' }, c).action, 'observe');
  assert.equal(decideRequest(r, { policy: 'unrestricted' }, c).action, 'observe');
});

test('method must match unless the signature says *', () => {
  const c = cfg(GRAPHQL);
  assert.equal(decideRequest(req('GET', 'https://api.test/api/projects/1'), { policy: 'read-only' }, c).action, 'allow');
  assert.equal(decideRequest(req('put', 'https://api.test/upload/x'), { policy: 'read-only' }, c).action, 'block');
});

test('a request method is matched case-insensitively against the uppercase signature', () => {
  const c = cfg(GRAPHQL);
  assert.equal(decideRequest(req('delete', 'https://api.test/api/projects/1'), { policy: 'read-only' }, c).action, 'block');
});

test('an allow signature wins over a write signature', () => {
  const c = cfg({ ...GRAPHQL, write_signatures: [{ method: 'POST', url: '/api/' }] });
  assert.equal(decideRequest(req('POST', 'https://api.test/api/search'), { policy: 'read-only' }, c).action, 'allow');
  assert.equal(decideRequest(req('POST', 'https://api.test/api/save'), { policy: 'read-only' }, c).action, 'block');
});

test('an unknown policy blocks write requests', () => {
  const c = cfg(GRAPHQL);
  assert.equal(decideRequest(req('DELETE', 'https://api.test/api/x'), { policy: 'nope' }, c).action, 'block');
});

test('url matching is case-sensitive, as the schema says', () => {
  const c = cfg({ write_signatures: [{ method: 'POST', url: '/Save$' }] });
  assert.equal(decideRequest(req('POST', 'https://api.test/save'), { policy: 'read-only' }, c).action, 'allow');
});

// --- page injection (C2): every function works when rebuilt from its source ---------

test('each function behaves identically when rebuilt from its own source text', () => {
  const rebuild = (fn) => new Function(`return ${fn.toString()}`)();
  const [compile2, control2, request2] = [compileConfig, decideControl, decideRequest].map(rebuild);
  const c1 = cfg(GRAPHQL);
  const c2 = compile2(GRAPHQL, JSON.parse(JSON.stringify(DEFAULT_DENY)));
  const controls = [control('Delete'), control('Open'), control('Delete', { ownRowText: 'QA_TEST_x' }),
    control('', { icons: ['mdi-pencil'] })];
  for (const s of [{ policy: 'read-only' }, { policy: 'scoped-write', prefix: 'QA_TEST_' }, { policy: 'unrestricted' }]) {
    for (const k of controls) assert.deepEqual(control2(k, s, c2), decideControl(k, s, c1));
    for (const r of [req('POST', 'https://api.test/graphql', MUTATION), req('POST', 'https://api.test/graphql', QUERY),
      req('DELETE', 'https://api.test/api/1'), req('GET', 'https://api.test/x')]) {
      assert.deepEqual(request2(r, s, c2), decideRequest(r, s, c1));
    }
  }
});
