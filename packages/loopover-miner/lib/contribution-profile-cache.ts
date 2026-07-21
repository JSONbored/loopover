// ContributionProfile local cache store (#6797). Persists the extraction output (#6796) keyed by repo, so a
// repeated `discover` run within the freshness window doesn't re-fetch/re-parse the same labels + docs. 100%
// local/client-side, like every other miner store: never uploads, syncs, or phones home. Follows the shared
// local-store.js pattern (openLocalStoreDb + resolveLocalStoreDbPath + the schema-version stamp) so it is
// picked up by `doctor`'s store-integrity sweep and `migrate` the same way its siblings are.
import type { CachedContributionProfile, ContributionProfile } from "./contribution-profile.js";
import {
  CONTRIBUTION_PROFILE_CACHE_TTL_MS,
  CONTRIBUTION_PROFILE_STORE_TABLE,
} from "./contribution-profile.js";
import {
  normalizeLocalStoreDbPath,
  openLocalStoreAdapter,
  resolveLocalStoreDbPath,
} from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { isValidRepoSegment } from "./repo-clone.js";
import {
  CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC,
  purgeStoreByRepo,
} from "./store-maintenance.js";

export type ContributionProfileCache = {
  dbPath: string;
  /** Read a cached profile, or null when absent or unparseable. `stale` is true past the TTL. */
  get(repoFullName: string, nowMs?: number): CachedContributionProfile | null;
  /** Cache a profile keyed by its own repoFullName, stamped with `nowMs` (defaults to now). */
  put(
    profile: ContributionProfile,
    nowMs?: number,
  ): { repoFullName: string; fetchedAt: string };
  /** Delete the cached profile for one repo (#7091); returns rows removed (0 or 1). */
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

const defaultDbFileName = "contribution-profile-cache.sqlite3";
let defaultContributionProfileCache: ContributionProfileCache | null = null;

export function resolveContributionProfileCacheDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(
    defaultDbFileName,
    "LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB",
    env,
  );
}

function normalizeDbPath(dbPath: string | null | undefined): string {
  return normalizeLocalStoreDbPath(
    dbPath,
    resolveContributionProfileCacheDbPath(),
    "invalid_contribution_profile_cache_db_path",
  );
}

function normalizeRepoFullName(repoFullName: unknown): string {
  if (typeof repoFullName !== "string")
    throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined)
    throw new Error("invalid_repo_full_name");
  // #7795: reject `.`/`..`/control-char segments (via repo-clone.js's shared guard) before this value backs a
  // SQLite key or is echoed through a CLI -- the same path-safety check #5831/#7525 rolled out to every sibling.
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

/**
 * Open the 100%-local contribution-profile cache. The DB only lives on this machine (#6797).
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations and the repo-scoped purge still use the underlying DatabaseSync until those
 * helpers are migrated. Public API stays synchronous so callers need no async cascade in this part-1 slice.
 */
export function initContributionProfileCache(
  dbPath: string = resolveContributionProfileCacheDbPath(),
): ContributionProfileCache {
  const resolvedPath = normalizeDbPath(dbPath);
  const { db, driver } = openLocalStoreAdapter(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTRIBUTION_PROFILE_STORE_TABLE} (
      repo_full_name TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `);
  // Schema-version convention (#4832): stamp the baseline. No post-baseline migrations for this v1 store yet.
  applySchemaMigrations(db, []);

  const getSql = `SELECT profile_json, fetched_at FROM ${CONTRIBUTION_PROFILE_STORE_TABLE} WHERE repo_full_name = ?`;
  const putSql = `
    INSERT INTO ${CONTRIBUTION_PROFILE_STORE_TABLE} (repo_full_name, profile_json, fetched_at)
    VALUES (?, ?, ?)
    ON CONFLICT(repo_full_name) DO UPDATE SET
      profile_json = excluded.profile_json,
      fetched_at = excluded.fetched_at
  `;

  return {
    dbPath: resolvedPath,
    /**
     * Read a cached profile. Returns { profile, fetchedAt, stale } or null when absent. `stale` is true once
     * the row is older than the TTL, so a caller re-extracts. A row whose JSON is unparseable is treated as a
     * miss (fail closed) rather than throwing — a corrupted/hand-edited file must not break discover.
     */
    get(repoFullName: string, nowMs: number = Date.now()): CachedContributionProfile | null {
      const row = driver.query(getSql, [normalizeRepoFullName(repoFullName)]).rows[0] as
        | { profile_json: string; fetched_at: string }
        | undefined;
      if (!row) return null;
      let profile;
      try {
        profile = JSON.parse(row.profile_json);
      } catch {
        return null;
      }
      const fetchedMs = Date.parse(row.fetched_at);
      // An unparseable timestamp fails closed to stale, so a corrupted row is re-extracted rather than trusted.
      const stale =
        Number.isNaN(fetchedMs) ||
        nowMs - fetchedMs > CONTRIBUTION_PROFILE_CACHE_TTL_MS;
      return { profile, fetchedAt: row.fetched_at, stale };
    },
    /**
     * Cache a profile, stamping it with the current time. The profile's own repoFullName is the key.
     */
    put(profile: ContributionProfile, nowMs: number = Date.now()): { repoFullName: string; fetchedAt: string } {
      const repoFullName = normalizeRepoFullName(profile?.repoFullName);
      const fetchedAt = new Date(nowMs).toISOString();
      driver.query(putSql, [repoFullName, JSON.stringify(profile), fetchedAt]);
      return { repoFullName, fetchedAt };
    },
    /**
     * Delete the cached profile for one repo (#7091) — the right-to-be-forgotten path `loopover-miner purge`
     * invokes. Returns the number of rows removed (0 or 1, since repo_full_name is the primary key). Reuses
     * store-maintenance.js's identifier-guarded purgeStoreByRepo, exactly like the other repo-scoped stores.
     */
    purgeByRepo(repoFullName: string): number {
      return purgeStoreByRepo(db, CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC, normalizeRepoFullName(repoFullName));
    },
    close() {
      db.close();
    },
  };
}

function getDefaultContributionProfileCache(): ContributionProfileCache {
  defaultContributionProfileCache ??= initContributionProfileCache();
  return defaultContributionProfileCache;
}

export function getCachedContributionProfile(repoFullName: string, nowMs?: number): CachedContributionProfile | null {
  return getDefaultContributionProfileCache().get(repoFullName, nowMs);
}

export function putCachedContributionProfile(
  profile: ContributionProfile,
  nowMs?: number,
): { repoFullName: string; fetchedAt: string } {
  return getDefaultContributionProfileCache().put(profile, nowMs);
}

export function closeDefaultContributionProfileCache() {
  if (!defaultContributionProfileCache) return;
  defaultContributionProfileCache.close();
  defaultContributionProfileCache = null;
}
