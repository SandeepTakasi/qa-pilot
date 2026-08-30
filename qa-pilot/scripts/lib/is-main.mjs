import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * True when this module is the CLI entry point.
 *
 * The naive `import.meta.url === \`file://${process.argv[1]}\`` is false whenever the two
 * spellings differ, and they differ constantly:
 *   - a path component containing a space (or any char a URL percent-encodes)
 *   - a symlinked path: on macOS /tmp is /private/tmp and tmpdir() is under /var/folders,
 *     which is /private/var/folders
 * When it is wrongly false the script runs zero lines and exits 0: the publish gate
 * vacuously passes and the PreToolUse hook fails open. Silent and fail-open, so compare
 * real paths.
 */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false; // entry point vanished or is unreadable
  }
}
