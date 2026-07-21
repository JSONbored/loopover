import { CONTRIBUTION_PROFILE_CACHE_TTL_MS, CONTRIBUTION_PROFILE_STORE_TABLE, } from "./contribution-profile.js";
import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath, } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC, purgeStoreByRepo, } from "./store-maintenance.js";
const defaultDbFileName = "contribution-profile-cache.sqlite3";
let defaultContributionProfileCache = null;
export function resolveContributionProfileCacheDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_CONTRIBUTION_PROFILE_CACHE_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveContributionProfileCacheDbPath(), "invalid_contribution_profile_cache_db_path");
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    // #7795: extend #5831/#7525's path-safety guard here too — reject a `.`/`..`/control-char segment before it
    // can be persisted into SQLite (or echoed back through the CLI), matching claim-ledger.ts's sibling parser.
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
/**
 * Open the 100%-local contribution-profile cache. The DB only lives on this machine (#6797).
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations and the repo-scoped purge still use the underlying DatabaseSync until those
 * helpers are migrated. Public API stays synchronous so callers need no async cascade in this part-1 slice.
 */
export function initContributionProfileCache(dbPath = resolveContributionProfileCacheDbPath()) {
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
        get(repoFullName, nowMs = Date.now()) {
            const row = driver.query(getSql, [normalizeRepoFullName(repoFullName)]).rows[0];
            if (!row)
                return null;
            let profile;
            try {
                profile = JSON.parse(row.profile_json);
            }
            catch {
                return null;
            }
            const fetchedMs = Date.parse(row.fetched_at);
            // An unparseable timestamp fails closed to stale, so a corrupted row is re-extracted rather than trusted.
            const stale = Number.isNaN(fetchedMs) ||
                nowMs - fetchedMs > CONTRIBUTION_PROFILE_CACHE_TTL_MS;
            return { profile, fetchedAt: row.fetched_at, stale };
        },
        /**
         * Cache a profile, stamping it with the current time. The profile's own repoFullName is the key.
         */
        put(profile, nowMs = Date.now()) {
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
        purgeByRepo(repoFullName) {
            return purgeStoreByRepo(db, CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC, normalizeRepoFullName(repoFullName));
        },
        close() {
            db.close();
        },
    };
}
function getDefaultContributionProfileCache() {
    defaultContributionProfileCache ??= initContributionProfileCache();
    return defaultContributionProfileCache;
}
export function getCachedContributionProfile(repoFullName, nowMs) {
    return getDefaultContributionProfileCache().get(repoFullName, nowMs);
}
export function putCachedContributionProfile(profile, nowMs) {
    return getDefaultContributionProfileCache().put(profile, nowMs);
}
export function closeDefaultContributionProfileCache() {
    if (!defaultContributionProfileCache)
        return;
    defaultContributionProfileCache.close();
    defaultContributionProfileCache = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udHJpYnV0aW9uLXByb2ZpbGUtY2FjaGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjb250cmlidXRpb24tcHJvZmlsZS1jYWNoZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFNQSxPQUFPLEVBQ0wsaUNBQWlDLEVBQ2pDLGdDQUFnQyxHQUNqQyxNQUFNLDJCQUEyQixDQUFDO0FBQ25DLE9BQU8sRUFDTCx5QkFBeUIsRUFDekIscUJBQXFCLEVBQ3JCLHVCQUF1QixHQUN4QixNQUFNLGtCQUFrQixDQUFDO0FBQzFCLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQzVELE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ3JELE9BQU8sRUFDTCxxQ0FBcUMsRUFDckMsZ0JBQWdCLEdBQ2pCLE1BQU0sd0JBQXdCLENBQUM7QUFnQmhDLE1BQU0saUJBQWlCLEdBQUcsb0NBQW9DLENBQUM7QUFDL0QsSUFBSSwrQkFBK0IsR0FBb0MsSUFBSSxDQUFDO0FBRTVFLE1BQU0sVUFBVSxxQ0FBcUMsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUN6RyxPQUFPLHVCQUF1QixDQUM1QixpQkFBaUIsRUFDakIsOENBQThDLEVBQzlDLEdBQUcsQ0FDSixDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWlDO0lBQ3hELE9BQU8seUJBQXlCLENBQzlCLE1BQU0sRUFDTixxQ0FBcUMsRUFBRSxFQUN2Qyw0Q0FBNEMsQ0FDN0MsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLHFCQUFxQixDQUFDLFlBQXFCO0lBQ2xELElBQUksT0FBTyxZQUFZLEtBQUssUUFBUTtRQUNsQyxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDNUMsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsWUFBWSxDQUFDLElBQUksRUFBRSxDQUFDLEtBQUssQ0FB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