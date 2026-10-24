// Read a committed JSON ledger (approved.json, bugs.json) without ever mistaking a broken
// file for an empty one. A missing file is a new ledger. A file that does not parse, such as
// one left with git merge-conflict markers, is refused: treating it as empty and writing the
// result back would silently erase every entry in it.

import { readFileSync } from 'node:fs';

/**
 * @param {string} path
 * @param {string} what how the caller names the file in messages
 * @returns {{ value: Record<string, unknown>, missing: boolean }}
 */
export function readJsonObject(path, what) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { value: {}, missing: true };
    throw e;
  }
  let value;
  try { value = JSON.parse(raw); } catch {
    const conflict = /^(<{7}|={7}|>{7})/m.test(raw) ? ' It holds git merge-conflict markers; resolve the merge first.' : '';
    throw new Error(`${what}: ${path} is not valid JSON.${conflict} Fix it before going on: reading it as empty would erase every entry.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what}: ${path} must hold a JSON object`);
  }
  return { value, missing: false };
}
