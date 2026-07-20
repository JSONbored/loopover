import { CONTRIBUTION_PROFILE_CACHE_TTL_MS, CONTRIBUTION_PROFILE_STORE_TABLE, } from "./contribution-profile.js";
import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath, } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
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
    return `${owner}/${repo}`;
}
/**
 * Open the 100%-local contribution-profile cache. The DB only lives on this machine (#6797).
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations / purge still use the underlying DatabaseSync until those helpers are
 * migrated. Public API stays synchronous so callers need no async cascade in this #7282 slice.
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
            const { rows } = driver.query(getSql, [normalizeRepoFullName(repoFullName)]);
            const row = rows[0];
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udHJpYnV0aW9uLXByb2ZpbGUtY2FjaGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjb250cmlidXRpb24tcHJvZmlsZS1jYWNoZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFNQSxPQUFPLEVBQ0wsaUNBQWlDLEVBQ2pDLGdDQUFnQyxHQUNqQyxNQUFNLDJCQUEyQixDQUFDO0FBQ25DLE9BQU8sRUFDTCx5QkFBeUIsRUFDekIscUJBQXFCLEVBQ3JCLHVCQUF1QixHQUN4QixNQUFNLGtCQUFrQixDQUFDO0FBQzFCLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQzVELE9BQU8sRUFDTCxxQ0FBcUMsRUFDckMsZ0JBQWdCLEdBQ2pCLE1BQU0sd0JBQXdCLENBQUM7QUFnQmhDLE1BQU0saUJBQWlCLEdBQUcsb0NBQW9DLENBQUM7QUFDL0QsSUFBSSwrQkFBK0IsR0FBb0MsSUFBSSxDQUFDO0FBRTVFLE1BQU0sVUFBVSxxQ0FBcUMsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUN6RyxPQUFPLHVCQUF1QixDQUM1QixpQkFBaUIsRUFDakIsOENBQThDLEVBQzlDLEdBQUcsQ0FDSixDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWlDO0lBQ3hELE9BQU8seUJBQXlCLENBQzlCLE1BQU0sRUFDTixxQ0FBcUMsRUFBRSxFQUN2Qyw0Q0FBNEMsQ0FDN0MsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLHFCQUFxQixDQUFDLFlBQXFCO0lBQ2xELElBQUksT0FBTyxZQUFZLEtBQUssUUFBUTtRQUNsQyxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDNUMsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsWUFBWSxDQUFDLElBQUksRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUM1RCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTO1FBQ3hDLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUM1QyxPQUFPLEdBQUcsS0FBSyxJQUFJLElBQUksRUFBRSxDQUFDO0FBQzVCLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFVBQVUsNEJBQTRCLENBQzFDLFNBQWlCLHFDQUFxQyxFQUFFO0lBRXhELE1BQU0sWUFBWSxHQUFHLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUM3QyxNQUFNLEVBQUUsRUFBRSxFQUFFLE1BQU0sRUFBRSxHQUFHLHFCQUFxQixDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQzNELEVBQUUsQ0FBQyxJQUFJLENBQUM7aUNBQ3VCLGdDQUFnQzs7Ozs7R0FLOUQsQ0FBQyxDQUFDO0lBQ0gsNEdBQTRHO0lBQzVHLHFCQUFxQixDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUU5QixNQUFNLE1BQU0sR0FBRyx3Q0FBd0MsZ0NBQWdDLDJCQUEyQixDQUFDO0lBQ25ILE1BQU0sTUFBTSxHQUFHO2tCQUNDLGdDQUFnQzs7Ozs7R0FLL0MsQ0FBQztJQUVGLE9BQU87UUFDTCxNQUFNLEVBQUUsWUFBWTtRQUNwQjs7OztXQUlHO1FBQ0gsR0FBRyxDQUFDLFlBQW9CLEVBQUUsUUFBZ0IsSUFBSSxDQUFDLEdBQUcsRUFBRTtZQUNsRCxNQUFNLEVBQUUsSUFBSSxFQUFFLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxxQkFBcUIsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDN0UsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FFTCxDQUFDO1lBQ2QsSUFBSSxDQUFDLEdBQUc7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFDdEIsSUFBSSxPQUFPLENBQUM7WUFDWixJQUFJLENBQUM7Z0JBQ0gsT0FBTyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxDQUFDO1lBQ3pDLENBQUM7WUFBQyxNQUFNLENBQUM7Z0JBQ1AsT0FBTyxJQUFJLENBQUM7WUFDZCxDQUFDO1lBQ0QsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDN0MsMEdBQTBHO1lBQzFHLE1BQU0sS0FBSyxHQUNULE1BQU0sQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDO2dCQUN2QixLQUFLLEdBQUcsU0FBUyxHQUFHLGlDQUFpQyxDQUFDO1lBQ3hELE9BQU8sRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLEdBQUcsQ0FBQyxVQUFVLEVBQUUsS0FBSyxFQUFFLENBQUM7UUFDdkQsQ0FBQztRQUNEOztXQUVHO1FBQ0gsR0FBRyxDQUFDLE9BQTRCLEVBQUUsUUFBZ0IsSUFBSSxDQUFDLEdBQUcsRUFBRTtZQUMxRCxNQUFNLFlBQVksR0FBRyxxQkFBcUIsQ0FBQyxPQUFPLEVBQUUsWUFBWSxDQUFDLENBQUM7WUFDbEUsTUFBTSxTQUFTLEdBQUcsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsV0FBVyxFQUFFLENBQUM7WUFDaEQsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxZQUFZLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsRUFBRSxTQUFTLENBQUMsQ0FBQyxDQUFDO1lBQ3pFLE9BQU8sRUFBRSxZQUFZLEVBQUUsU0FBUyxFQUFFLENBQUM7UUFDckMsQ0FBQztRQUNEOzs7O1dBSUc7UUFDSCxXQUFXLENBQUMsWUFBb0I7WUFDOUIsT0FBTyxnQkFBZ0IsQ0FBQyxFQUFFLEVBQUUscUNBQXFDLEVBQUUscUJBQXFCLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQztRQUMxRyxDQUFDO1FBQ0QsS0FBSztZQUNILEVBQUUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNiLENBQUM7S0FDRixDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsa0NBQWtDO0lBQ3pDLCtCQUErQixLQUFLLDRCQUE0QixFQUFFLENBQUM7SUFDbkUsT0FBTywrQkFBK0IsQ0FBQztBQUN6QyxDQUFDO0FBRUQsTUFBTSxVQUFVLDRCQUE0QixDQUFDLFlBQW9CLEVBQUUsS0FBYztJQUMvRSxPQUFPLGtDQUFrQyxFQUFFLENBQUMsR0FBRyxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsQ0FBQztBQUN2RSxDQUFDO0FBRUQsTUFBTSxVQUFVLDRCQUE0QixDQUMxQyxPQUE0QixFQUM1QixLQUFjO0lBRWQsT0FBTyxrQ0FBa0MsRUFBRSxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDbEUsQ0FBQztBQUVELE1BQU0sVUFBVSxvQ0FBb0M7SUFDbEQsSUFBSSxDQUFDLCtCQUErQjtRQUFFLE9BQU87SUFDN0MsK0JBQStCLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDeEMsK0JBQStCLEdBQUcsSUFBSSxDQUFDO0FBQ3pDLENBQUMifQ==