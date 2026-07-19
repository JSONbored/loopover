import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9saWN5LWRvYy1jYWNoZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBvbGljeS1kb2MtY2FjaGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLHlCQUF5QixFQUFFLHFCQUFxQixFQUFFLHVCQUF1QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDN0csT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFpQzVELE1BQU0saUJBQWlCLEdBQUcsMEJBQTBCLENBQUM7QUFFckQsTUFBTSxVQUFVLDJCQUEyQixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQy9GLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUsb0NBQW9DLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDL0YsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWM7SUFDckMsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsMkJBQTJCLEVBQUUsRUFBRSxrQ0FBa0MsQ0FBQyxDQUFDO0FBQzlHLENBQUM7QUFFRCxTQUFTLFlBQVksQ0FBQyxHQUFXO0lBQy9CLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUTtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUN2RSxNQUFNLE9BQU8sR0FBRyxHQUFHLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDM0IsSUFBSSxDQUFDLE9BQU87UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDeEQsT0FBTyxPQUFPLENBQUM7QUFDakIsQ0FBQztBQUVEOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLFVBQVUsdUJBQXVCLENBQUMsU0FBaUIsMkJBQTJCLEVBQUU7SUFDcEYsTUFBTSxZQUFZLEdBQUcsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzdDLE1BQU0sRUFBRSxFQUFFLEVBQUUsTUFBTSxFQUFFLEdBQUcscUJBQXFCLENBQUMsWUFBWSxDQUFDLENBQUM7SUFDM0QsRUFBRSxDQUFDLElBQUksQ0FBQzs7Ozs7OztHQU9QLENBQUMsQ0FBQztJQUNILHlHQUF5RztJQUN6RyxxQkFBcUIsQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFFOUIsTUFBTSxNQUFNLEdBQUcsMERBQTBELENBQUM7SUFDMUUsTUFBTSxNQUFNLEdBQUc7Ozs7Ozs7R0FPZCxDQUFDO0lBRUYsT0FBTztRQUNMLE1BQU0sRUFBRSxZQUFZO1FBQ3BCO2tGQUMwRTtRQUMxRSxHQUFHLENBQUMsR0FBVztZQUNiLE1BQU0sRUFBRSxJQUFJLEVBQUUsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDM0QsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3BCLE9BQU8sR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxHQUFHLENBQUMsSUFBYyxFQUFFLE9BQU8sRUFBRSxHQUFHLENBQUMsT0FBaUIsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDbkYsQ0FBQztRQUNELDZGQUE2RjtRQUM3RixHQUFHLENBQUMsR0FBVyxFQUFFLElBQVksRUFBRSxPQUFlO1lBQzVDLE1BQU0sYUFBYSxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUN4QyxJQUFJLE9BQU8sSUFBSSxLQUFLLFFBQVEsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUU7Z0JBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO1lBQ3pGLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUTtnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLDRCQUE0QixDQUFDLENBQUM7WUFDL0UsTUFBTSxTQUFTLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUMzQyxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLGFBQWEsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7WUFDaEUsT0FBTyxFQUFFLEdBQUcsRUFBRSxhQUFhLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsQ0FBQztRQUMxRCxDQUFDO1FBQ0QsS0FBSztZQUNILEVBQUUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNiLENBQUM7S0FDRixDQUFDO0FBQ0osQ0FBQyJ9