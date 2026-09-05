#!/usr/bin/env node
// Read the commit SHA of the build actually running in a registered environment.
// The SHA is read FROM the environment, never assumed by the executor: a report whose
// SHA has no source cannot be published, and a SHA that changes mid-run means half the
// cases tested one build and half another, so the whole run is Blocked.
//
// Usage: node read-env-sha.mjs <profile> <env-name> <app-name> [--timeout-ms 10000]

import { loadProfile } from './lib/profile.mjs';
import { isMain } from './lib/is-main.mjs';

// Two kinds of build identity, because not every host can serve a commit.
//
// `commit` is the strong form: a git SHA, so a verdict names the exact source it was
// proved against. Prefer it. The strict pattern is what stops a mis-pathed config from
// stamping a version string or a build number and calling it provenance.
//
// `build-id` is the pragmatic form for a host with no version endpoint: any stable
// per-build fingerprint the app already serves, typically a bundler's content hash from
// index.html. It still detects a deploy landing mid-run, which is the safety property
// that matters most, but it does not name a commit, so tracing a report back to source
// means correlating through your release records.
const IDENTITY = {
  commit: {
    re: /^[0-9a-f]{7,40}$/i,
    expected: '7 to 40 hex characters',
    hint: 'a wrong path can silently yield a version string or a build number, which would stamp every report with a provenance that means nothing',
  },
  'build-id': {
    re: /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/,
    expected: '6 to 64 characters of letters, digits, dot, underscore or hyphen',
    hint: 'a wrong path can yield a fragment of markup or an empty string, which would look like a build identity without being one',
  },
};
const DEFAULT_TIMEOUT_MS = 10_000;

/** Walk a dot path (`build.commit`, `data.0.sha`) through parsed JSON. */
export function pluck(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[Array.isArray(acc) && /^\d+$/.test(key) ? Number(key) : key];
  }, obj);
}

/**
 * Extract a SHA from a raw response body per an environment's sha_source config.
 * @returns {string} the normalized (lowercase) SHA
 * @throws when the body cannot yield a plausible SHA
 */
export function extractSha(body, shaSource) {
  let raw;
  if (shaSource.json_path) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(
        `sha_source.url did not return JSON, but sha_source.json_path is set.\n` +
        `First 200 chars of the response: ${body.slice(0, 200)}`
      );
    }
    raw = pluck(parsed, shaSource.json_path);
    if (raw === undefined) {
      throw new Error(`sha_source.json_path "${shaSource.json_path}" is not present in the response`);
    }
  } else {
    const m = new RegExp(shaSource.regex).exec(body);
    if (!m || m[1] === undefined) {
      throw new Error(`sha_source.regex did not match the response body`);
    }
    raw = m[1];
  }

  const format = shaSource.format ?? 'commit';
  const spec = IDENTITY[format];
  if (!spec) throw new Error(`sha_source.format: "${format}" is not one of ${Object.keys(IDENTITY).join(' | ')}`);

  const sha = String(raw).trim();
  if (!spec.re.test(sha)) {
    throw new Error(
      `extracted value "${sha}" is not a valid ${format} (expected ${spec.expected}).\n` +
      `Check sha_source: ${spec.hint}.`
    );
  }
  // Commit SHAs are case-insensitive so normalise them; a build id may be
  // case-significant (base64-ish bundler hashes are), so leave it exactly as served.
  return format === 'commit' ? sha.toLowerCase() : sha;
}

/** Fetch and extract the deployed SHA for one app in one environment. */
export async function readEnvSha(profile, envName, appName, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const env = profile.environments?.[envName];
  if (!env) {
    const known = Object.keys(profile.environments ?? {}).join(', ') || '(none)';
    throw new Error(
      `environment "${envName}" is not in the registry (registered: ${known}).\n` +
      `Verdicts are only valid against registered deployed environments.`
    );
  }
  if (appName && !env.apps?.[appName]) {
    throw new Error(`app "${appName}" has no URL in environment "${envName}"`);
  }

  const src = env.sha_source;
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(src.url, { signal, headers: { accept: 'application/json, text/plain, */*' } });
  } catch (e) {
    throw new Error(
      `could not reach the deploy-SHA source for "${envName}": ${src.url}\n` +
      `${e.message}\nWithout a readable SHA this run cannot be published.`
    );
  }
  if (!res.ok) {
    throw new Error(`deploy-SHA source returned HTTP ${res.status} for ${src.url}`);
  }

  const sha = extractSha(await res.text(), src);
  return {
    sha,
    format: src.format ?? 'commit',
    source: src.url,
    app: appName ?? null,
    env: envName,
    fetched_at: new Date().toISOString(),
  };
}

if (isMain(import.meta.url)) {
  const [profilePath, envName, appName] = process.argv.slice(2);
  if (!profilePath || !envName) {
    console.error('usage: node read-env-sha.mjs <profile> <env-name> [app-name] [--timeout-ms 10000] [--sha-only]');
    process.exit(2);
  }
  const tIdx = process.argv.indexOf('--timeout-ms');
  const timeoutMs = tIdx === -1 ? DEFAULT_TIMEOUT_MS : Number(process.argv[tIdx + 1]);
  try {
    const { profile } = loadProfile(profilePath);
    const read = await readEnvSha(profile, envName, appName, { timeoutMs });
    // --sha-only keeps a CI step to one line. The full object stays the default, because
    // `format` matters and a bare string invites treating a build id as a commit.
    console.log(process.argv.includes('--sha-only') ? read.sha : JSON.stringify(read, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
