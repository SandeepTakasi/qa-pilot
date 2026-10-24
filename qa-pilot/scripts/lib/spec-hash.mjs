// The hash QA's approval is bound to. One function, so the run, the publish and CI can never
// disagree about what "the same test" means.
//
// It covers the spec, every local file the spec imports (recursively), and the case's own
// steps and expected outcomes from cases.yaml. Editing a shared helper or the case's expected
// result is a change QA has not reviewed, exactly like editing the spec. Line endings are
// normalised, so a Windows checkout and CI hash the same bytes. The write guard templates are
// left out: they are QA-Pilot's, checked by the publish gate on every run, and an upgrade must
// not reset every approval.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, normalize, relative, sep } from 'node:path';
import { isMain } from './is-main.mjs';
import { parse } from './yaml.mjs';

// Static and re-exported imports, side-effect imports, dynamic import() and require().
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json'];
const SKIP = /^write-guard\./;
// Only what defines the test. A new title or priority does not change what QA approved.
const CASE_FIELDS = ['preconditions', 'steps', 'expected', 'fixture'];

const normalise = (s) => s.replace(/\r\n?/g, '\n');

function defaultRead(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function resolveImport(fromFile, spec, read) {
  // join, not resolve: relative stays relative, so a caller's paths are used as given.
  const base = join(dirname(fromFile), spec);
  const tries = [base];
  // TypeScript ESM convention: './helper.js' in source names './helper.ts' on disk.
  if (/\.[cm]?js$/.test(base)) tries.push(base.replace(/\.([cm]?)js$/, '.$1ts'));
  for (const ext of EXTENSIONS) tries.push(base + ext);
  for (const ext of EXTENSIONS) tries.push(join(base, `index${ext}`));
  for (const t of tries) {
    const src = read(t);
    if (src !== null) return { path: t, source: src };
  }
  return { path: base, source: null };
}

/** Canonical JSON with sorted keys, so YAML key order never changes the hash. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * @param {string} specPath path to the spec file
 * @param {object|null|undefined} caseEntry the case's entry from cases.yaml; null when it is
 *   absent, which hashes differently from any real entry
 * @param {{read?: (p: string) => string|null}} [opts] injected for tests
 * @returns {string|null} 16 hex characters, or null when the spec itself cannot be read
 */
export function specHash(specPath, caseEntry, { read = defaultRead } = {}) {
  const root = normalize(specPath);
  const rootSource = read(root);
  if (rootSource === null) return null;
  const files = new Map([[root, rootSource]]);
  const queue = [root];
  while (queue.length) {
    const file = queue.shift();
    const src = files.get(file);
    if (src === null) continue;
    for (const m of normalise(src).matchAll(IMPORT_RE)) {
      const { path, source } = resolveImport(file, m[1], read);
      if (SKIP.test(basename(path)) || files.has(path)) continue;
      files.set(path, source);
      queue.push(path);
    }
  }
  const h = createHash('sha256');
  // Paths relative to the spec, so the hash does not depend on where it is computed from,
  // and the spec itself under a fixed key, so renaming the file is not a change to the test.
  const keyOf = (p) => (p === root ? '<spec>' : relative(dirname(root), p).split(sep).join('/'));
  for (const p of [...files.keys()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))) {
    const src = files.get(p);
    h.update(`${keyOf(p)}\0${src === null ? '\u0000missing' : normalise(src)}\0`);
  }
  const entry = caseEntry ? Object.fromEntries(CASE_FIELDS.map((k) => [k, caseEntry[k] ?? null])) : null;
  h.update(`case\0${canonical(entry)}`);
  return h.digest('hex').slice(0, 16);
}

/**
 * Hash every case in a specs.json map. `cases` is the parsed cases.yaml list.
 * @returns {{hashes: Record<string,string>, missing: string[]}}
 */
export function hashAll(specPaths, cases, opts) {
  const byId = new Map((Array.isArray(cases) ? cases : []).filter((c) => typeof c?.id === 'string').map((c) => [c.id, c]));
  const hashes = {};
  const missing = [];
  for (const [id, file] of Object.entries(specPaths ?? {})) {
    const h = typeof file === 'string' ? specHash(file, byId.get(id) ?? null, opts) : null;
    if (h) hashes[id] = h;
    else missing.push(id);
  }
  return { hashes, missing };
}

// Usage: node spec-hash.mjs --specs <specs.json> --cases <cases.yaml>
// Prints { "<CASE-ID>": "<hash>" }. /qa-pilot:run-tests writes it to the run directory as
// spec-shas.json just before Playwright starts, so a spec edited after the run cannot
// borrow its verdict.
if (isMain(import.meta.url)) {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? null : process.argv[i + 1]; };
  const specsPath = arg('--specs');
  const casesPath = arg('--cases');
  if (!specsPath || !casesPath) {
    console.error('usage: node spec-hash.mjs --specs <specs.json> --cases <cases.yaml>');
    process.exit(2);
  }
  try {
    const cases = parse(readFileSync(casesPath, 'utf8'))?.cases;
    if (!Array.isArray(cases)) throw new Error(`no cases[] in ${casesPath}`);
    const { hashes, missing } = hashAll(JSON.parse(readFileSync(specsPath, 'utf8')), cases);
    for (const id of missing) console.error(`warning: cannot read the spec for ${id}, so its verdict cannot carry an approval`);
    console.log(JSON.stringify(hashes, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
