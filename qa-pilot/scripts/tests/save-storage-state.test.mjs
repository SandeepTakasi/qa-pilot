import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadPlaywright, ttyRefusal } from '../save-storage-state.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../save-storage-state.mjs');
const refusalArgs = {
  scriptPath: '/plugins/qa-pilot/scripts/save-storage-state.mjs',
  url: 'https://app.example.com/login',
  out: '.playwright/profiles/storefront-member.json',
  browser: 'chromium',
  cwd: '/repo',
};

/** Build a throwaway host repo with a fake playwright package at `version`. */
function fakeHost({ pkg = 'playwright', version = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pilot-host-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-host' }));
  if (version) {
    const pkgDir = join(dir, 'node_modules', ...pkg.split('/'));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkg, version, main: 'index.js' }));
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = { chromium: {} };');
  }
  return dir;
}

test('resolves playwright at exactly the 1.51 floor', () => {
  const { version, pkg } = loadPlaywright(fakeHost({ version: '1.51.0' }));
  assert.equal(version, '1.51.0');
  assert.equal(pkg, 'playwright');
});

test('resolves newer playwright versions', () => {
  for (const v of ['1.61.1', '1.99.0', '2.0.0']) {
    assert.equal(loadPlaywright(fakeHost({ version: v })).version, v);
  }
});

test('rejects versions below 1.51 — the IndexedDB trap', () => {
  for (const v of ['1.50.1', '1.49.0', '1.9.0', '0.30.0']) {
    assert.throws(
      () => loadPlaywright(fakeHost({ version: v })),
      /indexedDB|1\.51/,
      `${v} should have been rejected`
    );
  }
});

test('falls back to @playwright/test when playwright is absent', () => {
  const { pkg, version } = loadPlaywright(fakeHost({ pkg: '@playwright/test', version: '1.55.0' }));
  assert.equal(pkg, '@playwright/test');
  assert.equal(version, '1.55.0');
});

test('explains itself when Playwright is not installed at all', () => {
  assert.throws(() => loadPlaywright(fakeHost()), /not installed in this repo/);
});

// --- the interactive-terminal requirement ------------------------------------
// Regression: readline on non-TTY stdin never resolves, so the headed browser opened,
// the script hung, and the caller's timeout killed it mid-login. Every single time.

test('a real TTY is allowed straight through', () => {
  assert.equal(ttyRefusal({ ...refusalArgs, isTTY: true }), null);
});

test('without a TTY it refuses with a copy-pasteable command', () => {
  const msg = ttyRefusal({ ...refusalArgs, isTTY: false });
  assert.match(msg, /interactive terminal/);
  assert.match(msg, /cd \/repo/);
  // The resolved script path, not ${CLAUDE_PLUGIN_ROOT}, which would not expand for a user.
  assert.match(msg, /node \/plugins\/qa-pilot\/scripts\/save-storage-state\.mjs/);
  assert.match(msg, /--url https:\/\/app\.example\.com\/login/);
  assert.match(msg, /--out \.playwright\/profiles\/storefront-member\.json/);
  assert.doesNotMatch(msg, /\$\{/, 'the command must contain no unexpanded variables');
});

test('the default browser is left off the command, a non-default one is included', () => {
  assert.doesNotMatch(ttyRefusal({ ...refusalArgs, isTTY: false }), /--browser/);
  assert.match(ttyRefusal({ ...refusalArgs, isTTY: false, browser: 'webkit' }), /--browser webkit/);
});

test('arguments needing quoting are shell-quoted', () => {
  const msg = ttyRefusal({ ...refusalArgs, isTTY: false, cwd: "/repos/my app's repo" });
  assert.match(msg, /cd '\/repos\/my app'\\''s repo'/);
});

test('it refuses in milliseconds rather than hanging, and launches no browser', () => {
  const started = Date.now();
  let status = 0;
  try {
    execFileSync('node', [SCRIPT, '--url', 'https://x.example.com', '--out', 'o.json'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 15_000 });
  } catch (e) {
    status = e.status;
    assert.match(e.stderr, /interactive terminal/);
  }
  assert.equal(status, 2, 'must exit nonzero so a caller knows nothing was saved');
  assert.ok(Date.now() - started < 10_000, 'must not hang waiting on stdin');
});
