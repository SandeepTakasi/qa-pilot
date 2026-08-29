import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright } from '../save-storage-state.mjs';

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
