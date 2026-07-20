import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { POLICY_VERDICT_CACHE_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";
const defaultDbFileName = "policy-verdict-cache.sqlite3";
const DECISIVE_DOCS = new Set(["AI-USAGE.md", "CONTRIBUTING.md"]);
export function resolvePolicyVerdictCacheDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolvePolicyVerdictCacheDbPath(), "invalid_policy_verdict_cache_db_path");
}
function normalizeRepoScope(repoScope) {
    if (typeof repoScope !== "string")
        throw new Error("invalid_policy_verdict_repo_scope");
    const trimmed = repoScope.trim();
    if (!trimmed)
        throw new Error("invalid_policy_verdict_repo_scope");
    return trimmed;
}
function normalizeDecisiveDoc(decisiveDoc) {
    if (!DECISIVE_DOCS.has(decisiveDoc))
        throw new Error("invalid_policy_verdict_decisive_doc");
    return decisiveDoc;
}
function normalizeEtag(etag) {
    if (typeof etag !== "string" || !etag.trim())
        throw new Error("invalid_policy_verdict_etag");
    return etag;
}
function serializeVerdict(verdict) {
    if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
        throw new Error("invalid_policy_verdict");
    }
    return JSON.stringify(verdict);
}
/**
 * Opens the 100% local/client-side miner policy-verdict cache. The database only lives on this machine; this
 * module never uploads, syncs, or phones home with its contents. (#4843)
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations / purge still use the underlying DatabaseSync until those helpers are
 * migrated. Public API stays synchronous so callers need no async cascade in this #7282 slice.
 */
export function initPolicyVerdictCacheStore(dbPath = resolvePolicyVerdictCacheDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const { db, driver } = openLocalStoreAdapter(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS policy_verdict_cache (
      repo_scope TEXT PRIMARY KEY,
      decisive_doc TEXT NOT NULL,
      etag TEXT NOT NULL,
      verdict TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
    // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations (none yet).
    applySchemaMigrations(db, []);
    const getSql = "SELECT decisive_doc, etag, verdict FROM policy_verdict_cache WHERE repo_scope = ?";
    const putSql = `
    INSERT INTO policy_verdict_cache (repo_scope, decisive_doc, etag, verdict, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo_scope) DO UPDATE SET
      decisive_doc = excluded.decisive_doc,
      etag = excluded.etag,
      verdict = excluded.verdict,
      updated_at = excluded.updated_at
  `;
    return {
        dbPath: resolvedPath,
        /** The last-known `{ decisiveDoc, etag, verdict }` for a repo scope, or null when it has never been cached. */
        get(repoScope) {
            const { rows } = driver.query(getSql, [normalizeRepoScope(repoScope)]);
            const row = rows[0];
            if (!row)
                return null;
            return {
                decisiveDoc: row.decisive_doc,
                etag: row.etag,
                verdict: JSON.parse(row.verdict),
            };
        },
        /** Record the resolved verdict against the ETag of the doc that decided it, so the next run can reuse it. */
        put(repoScope, decisiveDoc, etag, verdict) {
            const normalizedRepoScope = normalizeRepoScope(repoScope);
            const normalizedDecisiveDoc = normalizeDecisiveDoc(decisiveDoc);
            const normalizedEtag = normalizeEtag(etag);
            const serializedVerdict = serializeVerdict(verdict);
            const updatedAt = new Date().toISOString();
            driver.query(putSql, [normalizedRepoScope, normalizedDecisiveDoc, normalizedEtag, serializedVerdict, updatedAt]);
            return { repoScope: normalizedRepoScope, decisiveDoc: normalizedDecisiveDoc, etag: normalizedEtag, verdict, updatedAt };
        },
        /**
         * Delete every cached verdict row for one repo scope (#6987) -- the right-to-be-forgotten path
         * `loopover-miner purge` invokes. Returns the number of rows removed. Reuses store-maintenance.js's
         * identifier-guarded purgeStoreByRepo, exactly like the other repo-scoped stores.
         */
        purgeByRepo(repoScope) {
            return purgeStoreByRepo(db, POLICY_VERDICT_CACHE_PURGE_SPEC, normalizeRepoScope(repoScope));
        },
        close() {
            db.close();
        },
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9saWN5LXZlcmRpY3QtY2FjaGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwb2xpY3ktdmVyZGljdC1jYWNoZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEVBQUUseUJBQXlCLEVBQUUscUJBQXFCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUM3RyxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUM1RCxPQUFPLEVBQUUsK0JBQStCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQXFEM0YsTUFBTSxpQkFBaUIsR0FBRyw4QkFBOEIsQ0FBQztBQUN6RCxNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBUyxDQUFDLGFBQWEsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDLENBQUM7QUFFMUUsTUFBTSxVQUFVLCtCQUErQixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQ25HLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUsd0NBQXdDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDbkcsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWlDO0lBQ3hELE9BQU8seUJBQXlCLENBQUMsTUFBTSxFQUFFLCtCQUErQixFQUFFLEVBQUUsc0NBQXNDLENBQUMsQ0FBQztBQUN0SCxDQUFDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxTQUFrQjtJQUM1QyxJQUFJLE9BQU8sU0FBUyxLQUFLLFFBQVE7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLG1DQUFtQyxDQUFDLENBQUM7SUFDeEYsTUFBTSxPQUFPLEdBQUcsU0FBUyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQ2pDLElBQUksQ0FBQyxPQUFPO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQ0FBbUMsQ0FBQyxDQUFDO0lBQ25FLE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxTQUFTLG9CQUFvQixDQUFDLFdBQW9CO0lB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