#!/usr/bin/env node
// Capture a Playwright storageState by handing a headed browser to a human to log in.
// Captures IndexedDB as well as cookies and localStorage — Firebase Auth and friends
// persist tokens in IndexedDB, and a profile saved without it silently fails to restore.
// Requires Playwright >= 1.51 resolved from the HOST repo (run this from the host repo root).
//
// Usage: node save-storage-state.mjs --url <login-url> --out <path> [--browser chromium]

import { createRequire } from 'node:module';
import { isMain } from './lib/is-main.mjs';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const MIN = [1, 51, 0];

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/**
 * This step needs a human at a keyboard: a browser opens, a person signs in, and only
 * they can say when that finished. Without a TTY the prompt below never resolves — the
 * browser sits open, the caller's timeout eventually kills it, and nothing is saved.
 * So refuse up front, before launching anything, and hand back the exact command to run.
 */
export function ttyRefusal({ isTTY, scriptPath, url, out, browser, cwd }) {
  if (isTTY) return null;
  const cmd = [
    'node', shellQuote(scriptPath),
    '--url', shellQuote(url),
    '--out', shellQuote(out),
    ...(browser && browser !== 'chromium' ? ['--browser', shellQuote(browser)] : []),
  ].join(' ');
  return [
    'save-storage-state needs an interactive terminal, and this session does not have one.',
    '',
    'Signing in is something only you can do, and only you can say when it finished —',
    'so this command has to be run by you, in your own terminal, not by an agent.',
    '',
    `  cd ${shellQuote(cwd)}`,
    `  ${cmd}`,
    '',
    'A browser will open. Sign in — including OAuth and 2FA — then press Enter there.',
    'Nothing was launched here, so there is no stray browser window to close.',
  ].join('\n');
}

/** Resolve playwright from the host repo, not from the plugin. */
export function loadPlaywright(cwd) {
  const require = createRequire(resolve(cwd, 'package.json'));
  for (const pkg of ['playwright', '@playwright/test']) {
    try {
      const version = require(`${pkg}/package.json`).version;
      const parts = version.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        const d = (parts[i] ?? 0) - MIN[i];
        if (d < 0) {
          throw new Error(
            `${pkg} ${version} is too old — storageState({ indexedDB: true }) landed in Playwright 1.51.\n` +
            `Saved profiles would omit IndexedDB, and IndexedDB-persisted auth (Firebase) would not restore.\n` +
            `Upgrade the host repo: npm i -D @playwright/test@^1.51`
          );
        }
        if (d > 0) break;
      }
      return { mod: require(pkg), version, pkg };
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  throw new Error(
    'Playwright is not installed in this repo. Run this script from the host repo root, ' +
    'and install it there: npm i -D @playwright/test@^1.51'
  );
}

async function main() {
  const url = arg('--url');
  const out = arg('--out');
  const browserName = arg('--browser', 'chromium');
  if (!url || !out) {
    console.error('usage: node save-storage-state.mjs --url <login-url> --out <path> [--browser chromium]');
    process.exit(2);
  }

  const cwd = process.cwd();

  // Check this before launching anything: a browser opened here would be orphaned.
  const refusal = ttyRefusal({
    isTTY: Boolean(stdin.isTTY),
    scriptPath: fileURLToPath(import.meta.url),
    url, out, browser: browserName, cwd,
  });
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }

  const { mod: playwright, version, pkg } = loadPlaywright(cwd);
  const browserType = playwright[browserName];
  if (!browserType) throw new Error(`unknown browser: ${browserName} (chromium | firefox | webkit)`);

  console.error(`Using ${pkg} ${version} from ${cwd}`);
  const browser = await browserType.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.error('');
  console.error('  A browser window is open. Sign in there — including any OAuth or 2FA.');
  console.error('  Leave the browser on a signed-in page, then come back here.');
  console.error('');

  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('  Press Enter once you are signed in... ');
  rl.close();

  mkdirSync(dirname(resolve(out)), { recursive: true });
  await context.storageState({ path: out, indexedDB: true });
  await browser.close();

  // A profile that saved nothing useful is worse than no profile: it fails at run time,
  // in a spec, and reads as a test failure rather than a setup problem.
  const state = JSON.parse(readFileSync(out, 'utf8'));
  const cookies = state.cookies?.length ?? 0;
  const origins = state.origins?.length ?? 0;
  const idbOrigins = (state.origins ?? []).filter((o) => (o.indexedDB?.length ?? 0) > 0).length;

  console.error('');
  console.error(`  Saved ${out}: ${cookies} cookies, ${origins} origins, ${idbOrigins} with IndexedDB`);
  if (cookies === 0 && origins === 0) {
    console.error('  WARNING: nothing was captured. Was the browser actually signed in?');
    process.exit(1);
  }
  if (idbOrigins === 0) {
    console.error('  NOTE: no IndexedDB data captured. Fine if this app stores auth in cookies or');
    console.error('  localStorage — but if it uses Firebase Auth, the session will not restore.');
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
