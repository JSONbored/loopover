// Pure, fs-free migration-collision detection (#2550), shared by scripts/check-migrations.mjs (CI, reads the
// local filesystem) and the live premerge recheck (src/queue/processors.ts, reads a GitHub-API-fetched
// filename list) — a single source of truth so the two never drift apart.

/** Matches scripts/check-migrations.mjs's NAME regex exactly. */
export const MIGRATION_FILENAME_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export type MigrationCollision = {
  number: number;
  paddedNumber: string;
  files: string[];
};

/** Extract the 4-digit migration number from a conforming filename, or null if it doesn't match
 *  MIGRATION_FILENAME_PATTERN — a malformed filename is a separate concern (the CI script's own malformed-name
 *  check), not something this function flags. */
export function extractMigrationNumber(filename: string): number | null {
  const match = MIGRATION_FILENAME_PATTERN.exec(filename);
  return match ? Number(match[1]) : null;
}

/** The pairs already merged AND applied in production before the collision was noticed (see
 *  scripts/check-migrations.mjs's own header comment for why these can never be renumbered). Kept in lockstep
 *  with that script's KNOWN_DUPLICATES — both must list the exact same grandfathered sets. */
export const KNOWN_MIGRATION_DUPLICATES: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  [15, new Set(["0015_github_agent_command_feedback.sql", "0015_product_usage_events.sql"])],
  [17, new Set(["0017_agent_recommendation_outcomes.sql", "0017_product_usage_role_retention_rollups.sql"])],
  [74, new Set(["0074_ai_review_cache.sql", "0074_orb_self_enrollment_disabled.sql"])],
  [90, new Set(["0090_contributor_cap_label.sql", "0090_pull_request_detail_sync_head_sha.sql"])],
]);

/**
 * Group filenames by their migration number and return every number with more than one file, minus any
 * EXACT-set match against `knownDuplicates` (same grandfather semantics as scripts/check-migrations.mjs:
 * the group must be the identical size and every file in it must be in the allowed set — a third file at an
 * already-grandfathered number, or a substitution, is still flagged). Non-conforming filenames are ignored —
 * malformed-filename detection is a separate, CI-only concern. Pure, no I/O.
 */
export function detectMigrationCollisions(filenames: readonly string[], knownDuplicates: ReadonlyMap<number, ReadonlySet<string>> = new Map()): MigrationCollision[] {
  const byNumber = new Map<number, string[]>();
  for (const file of filenames) {
    const number = extractMigrationNumber(file);
    if (number === null) continue;
    const group = byNumber.get(number);
    if (group) group.push(file);
    else byNumber.set(number, [file]);
  }
  const collisions: MigrationCollision[] = [];
  for (const [number, files] of byNumber) {
    if (files.length === 1) continue;
    const allowed = knownDuplicates.get(number);
    const grandfathered = allowed !== undefined && files.length === allowed.size && files.every((f) => allowed.has(f));
    if (grandfathered) continue;
    collisions.push({ number, paddedNumber: String(number).padStart(4, "0"), files: [...files].sort() });
  }
  return collisions.sort((a, b) => a.number - b.number);
}
