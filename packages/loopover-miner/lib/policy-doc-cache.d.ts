export type PolicyDocCacheEntry = {
    etag: string;
    content: string;
};
export type PolicyDocCacheWrite = {
    url: string;
    etag: string;
    content: string;
    updatedAt: string;
};
export type PolicyDocCacheStore = {
    dbPath: string;
    get(url: string): PolicyDocCacheEntry | null;
    put(url: string, etag: string, content: string): PolicyDocCacheWrite;
    close(): void;
};
/** The read/write surface opportunity-fanout.js needs to inject a cache without depending on the SQLite store. */
export type PolicyDocCache = Pick<PolicyDocCacheStore, "get" | "put">;
export declare function resolvePolicyDocCacheDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the 100% local/client-side miner policy-doc ETag cache. The database only lives on this machine; this
 * module never uploads, syncs, or phones home with its contents. (#4842)
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations still use the underlying DatabaseSync until those helpers are migrated.
 * Public API stays synchronous so callers need no async cascade in this part-1 slice.
 */
export declare function initPolicyDocCacheStore(dbPath?: string): PolicyDocCacheStore;
