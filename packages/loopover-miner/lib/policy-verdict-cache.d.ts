import type { AiPolicyVerdict } from "@loopover/engine";
export type PolicyVerdictDecisiveDoc = "AI-USAGE.md" | "CONTRIBUTING.md";
export type PolicyVerdictCacheEntry = {
    decisiveDoc: PolicyVerdictDecisiveDoc;
    etag: string;
    verdict: AiPolicyVerdict;
};
export type PolicyVerdictCacheWrite = PolicyVerdictCacheEntry & {
    repoScope: string;
    updatedAt: string;
};
export type PolicyVerdictCacheStore = {
    dbPath: string;
    /** `repoScope` must uniquely identify a tenant forge host + repo (see `policyVerdictCacheKey` in
     *  opportunity-fanout.js) -- a bare `owner/repo` is not safe across multiple forge hosts. */
    get(repoScope: string): PolicyVerdictCacheEntry | null;
    put(repoScope: string, decisiveDoc: PolicyVerdictDecisiveDoc, etag: string, verdict: AiPolicyVerdict): PolicyVerdictCacheWrite;
    /** Delete every cached verdict row for one repo scope (#6987); returns the number of rows removed. */
    purgeByRepo(repoScope: string): number;
    close(): void;
};
/** The read/write surface opportunity-fanout.js needs to inject a cache without depending on the SQLite store. */
export type PolicyVerdictCache = Pick<PolicyVerdictCacheStore, "get" | "put">;
export declare function resolvePolicyVerdictCacheDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the 100% local/client-side miner policy-verdict cache. The database only lives on this machine; this
 * module never uploads, syncs, or phones home with its contents. (#4843)
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations / purge still use the underlying DatabaseSync until those helpers are
 * migrated. Public API stays synchronous so callers need no async cascade in this #7282 slice.
 */
export declare function initPolicyVerdictCacheStore(dbPath?: string): PolicyVerdictCacheStore;
