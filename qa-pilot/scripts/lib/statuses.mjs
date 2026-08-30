// The case lifecycle, split into what the pipeline reasons about and what a host calls it.
//
// The KEYS below are the pipeline's model and never change. The NAMES are per-host, because
// every organisation already has its own QA vocabulary: one team's "Under Review" is
// another's "ready for review". Hosts declare their names in qa-pilot.config.yaml under
// clickup.statuses, and everything downstream matches on keys.

/** Lifecycle states the pipeline understands. Stable; not user-facing. */
export const STATUS_KEYS = [
  'case_review',
  'approved_for_execution',
  'under_review',
  'approved',
  'rejected',
  'retest',
  'quarantined',
];

/** Names used when a host does not declare its own. */
export const DEFAULT_STATUSES = {
  case_review: 'Case Review',
  approved_for_execution: 'Approved for Execution',
  under_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Rejected',
  retest: 'Retest',
  quarantined: 'Quarantined',
};

// Design approval PERSISTS across runs. A case QA approved stays executable so the next
// build regresses it. Without that the pipeline runs exactly once per feature and then
// deadlocks with nothing eligible.
export const EXECUTABLE_KEYS = new Set([
  'approved_for_execution', // approved, never run
  'approved',               // approved, last verdict accepted; re-run on a new build
  'retest',                 // QA or CI explicitly asked for another run
  'under_review',           // last result not yet reviewed; a newer build supersedes it
]);

/** Why a state is held back, phrased for the person reading the output. */
export const HELD_REASONS = {
  case_review: 'awaiting QA design review; nothing executes before approval',
  rejected: 'QA rejected the case itself. Fix it via /qa-pilot:generate-tests, which returns it to design review for re-approval',
};

/** Only an accepted verdict counts toward confidence, never design approval. */
export const VERDICT_APPROVED_KEYS = new Set(['approved']);

/**
 * Map the host's status names back to lifecycle keys.
 * Matching is case-insensitive and trimmed: ClickUp statuses are often lowercase
 * ("ready for review") while a profile author naturally capitalises them.
 * @param {Record<string,string>} statuses name per lifecycle key
 * @returns {Map<string,string>} normalised name -> lifecycle key
 */
export function statusLookup(statuses = DEFAULT_STATUSES) {
  const lookup = new Map();
  for (const key of STATUS_KEYS) {
    const name = statuses?.[key];
    if (typeof name === 'string' && name.trim()) lookup.set(name.trim().toLowerCase(), key);
  }
  return lookup;
}

/** The host's name for a lifecycle key, for messages a human reads. */
export function displayName(statuses, key) {
  return statuses?.[key] ?? DEFAULT_STATUSES[key] ?? key;
}
