import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
// Local ETag cache for discovery's small policy-doc fetches (#4842). `discover` refetches each target repo's
// AI-USAGE.md/CONTRIBUTING.md on every run even though they rarely change, spending rate-limit budget on static
// content; this store lets opportunity-fanout.js revalidate with a conditional GET (If-None-Match) instead, and
// GitHub answers an unchanged doc with a 304 that costs no primary rate-limit budget. A 304 is a GitHub-confirmed
// unchanged body -- the cached content is only ever served AFTER a same-run revalidation, never blindly -- so this
// can never surface a stale policy that would wrongly permit autonomous work on an opted-out repo. Same 100%
// local/client-side discipline (mirrors run-state.js and the other stores this package owns via local-store.js):
// the file lives only on this machine and is never uploaded, synced, or phoned home with.
const defaultDbFileName = "policy-doc-cache.sqlite3";
export function resolvePolicyDocCacheDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_POLICY_DOC_CACHE_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolvePolicyDocCacheDbPath(), "invalid_policy_doc_cache_db_path");
}
function normalizeUrl(url) {
    if (typeof url !== "string")
        throw new Error("invalid_policy_doc_url");
    const trimmed = url.trim();
    if (!trimmed)
        throw new Error("invalid_policy_doc_url");
    return trimmed;
}
/**
 * Opens the 100% local/client-side miner policy-doc ETag cache. The database only lives on this machine; this
 * module never uploads, syncs, or phones home with its contents. (#4842)
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations still use the underlying DatabaseSync until those helpers are migrated.
 * Public API stays synchronous so callers need no async cascade in this part-1 slice.
 */
export function initPolicyDocCacheStore(dbPath = resolvePolicyDocCacheDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const { db, driver } = openLocalStoreAdapter(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS policy_doc_cache (
      url TEXT PRIMARY KEY,
      etag TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
    // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations (none yet).
    applySchemaMigrations(db, []);
    const getSql = "SELECT etag, content FROM policy_doc_cache WHERE url = ?";
    const putSql = `
    INSERT INTO policy_doc_cache (url, etag, content, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      etag = excluded.etag,
      content = excluded.content,
      updated_at = excluded.updated_at
  `;
    return {
        dbPath: resolvedPath,
        /** The last-known `{ etag, content }` for a policy-doc URL, or null when it has never been cached. Both columns
         *  are `TEXT NOT NULL`, so a present row always carries string values. */
        get(url) {
            const { rows } = driver.query(getSql, [normalizeUrl(url)]);
            const row = rows[0];
            return row ? { etag: row.etag, content: row.content } : null;
        },
        /** Record the fresh ETag + body so the next run can revalidate it with a conditional GET. */
        put(url, etag, content) {
            const normalizedUrl = normalizeUrl(url);
            if (typeof etag !== "string" || !etag.trim())
                throw new Error("invalid_policy_doc_etag");
            if (typeof content !== "string")
                throw new Error("invalid_policy_doc_content");
            const updatedAt = new Date().toISOString();
            driver.query(putSql, [normalizedUrl, etag, content, updatedAt]);
            return { url: normalizedUrl, etag, content, updatedAt };
        },
        close() {
            db.close();
        },
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9saWN5LWRvYy1jYWNoZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBvbGljeS1kb2MtY2FjaGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLHlCQUF5QixFQUFFLHFCQUFxQixFQUFFLHVCQUF1QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDN0csT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFFNUQsNkdBQTZHO0FBQzdHLGdIQUFnSDtBQUNoSCxnSEFBZ0g7QUFDaEgsa0hBQWtIO0FBQ2xILG1IQUFtSDtBQUNuSCw2R0FBNkc7QUFDN0csaUhBQWlIO0FBQ2pILDBGQUEwRjtBQUUxRixNQUFNLGlCQUFpQixHQUFHLDBCQUEwQixDQUFDO0FBd0JyRCxNQUFNLFVBQVUsMkJBQTJCLENBQUMsTUFBMEMsT0FBTyxDQUFDLEdBQUc7SUFDL0YsT0FBTyx1QkFBdUIsQ0FBQyxpQkFBaUIsRUFBRSxvQ0FBb0MsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUMvRixDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsTUFBYztJQUNyQyxPQUFPLHlCQUF5QixDQUFDLE1BQU0sRUFBRSwyQkFBMkIsRUFBRSxFQUFFLGtDQUFrQyxDQUFDLENBQUM7QUFDOUcsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEdBQVk7SUFDaEMsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQ3ZFLE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUMzQixJQUFJLENBQUMsT0FBTztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUN4RCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILE1BQU0sVUFBVSx1QkFBdUIsQ0FBQyxTQUFpQiwyQkFBMkIsRUFBRTtJQUNwRixNQUFNLFlBQVksR0FBRyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDN0MsTUFBTSxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsR0FBRyxxQkFBcUIsQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUMzRCxFQUFFLENBQUMsSUFBSSxDQUFDOzs7Ozs7O0dBT1AsQ0FBQyxDQUFDO0lBQ0gseUdBQXlHO0lBQ3pHLHFCQUFxQixDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUU5QixNQUFNLE1BQU0sR0FBRywwREFBMEQsQ0FBQztJQUMxRSxNQUFNLE1BQU0sR0FBRzs7Ozs7OztHQU9kLENBQUM7SUFFRixPQUFPO1FBQ0wsTUFBTSxFQUFFLFlBQVk7UUFDcEI7a0ZBQzBFO1FBQzFFLEdBQUcsQ0FBQyxHQUFHO1lBQ0wsTUFBTSxFQUFFLElBQUksRUFBRSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUMzRCxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFrRCxDQUFDO1lBQ3JFLE9BQU8sR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxHQUFHLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxHQUFHLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztRQUMvRCxDQUFDO1FBQ0QsNkZBQTZGO1FBQzdGLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLE9BQU87WUFDcEIsTUFBTSxhQUFhLEdBQUcsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ3hDLElBQUksT0FBTyxJQUFJLEtBQUssUUFBUSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRTtnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHlCQUF5QixDQUFDLENBQUM7WUFDekYsSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRO2dCQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsNEJBQTRCLENBQUMsQ0FBQztZQUMvRSxNQUFNLFNBQVMsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQzNDLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsYUFBYSxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztZQUNoRSxPQUFPLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxDQUFDO1FBQzFELENBQUM7UUFDRCxLQUFLO1lBQ0gsRUFBRSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2IsQ0FBQztLQUNGLENBQUM7QUFDSixDQUFDIn0=