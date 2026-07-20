import type { CachedContributionProfile, ContributionProfile } from "./contribution-profile.js";
export type ContributionProfileCache = {
    dbPath: string;
    /** Read a cached profile, or null when absent or unparseable. `stale` is true past the TTL. */
    get(repoFullName: string, nowMs?: number): CachedContributionProfile | null;
    /** Cache a profile keyed by its own repoFullName, stamped with `nowMs` (defaults to now). */
    put(profile: ContributionProfile, nowMs?: number): {
        repoFullName: string;
        fetchedAt: string;
    };
    /** Delete the cached profile for one repo (#7091); returns rows removed (0 or 1). */
    purgeByRepo(repoFullName: string): number;
    close(): void;
};
export declare function resolveContributionProfileCacheDbPath(env?: Record<string, string | undefined>): string;
/**
 * Open the 100%-local contribution-profile cache. The DB only lives on this machine (#6797).
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations / purge still use the underlying DatabaseSync until those helpers are
 * migrated. Public API stays synchronous so callers need no async cascade in this #7282 slice.
 */
export declare function initContributionProfileCache(dbPath?: string): ContributionProfileCache;
export declare function getCachedContributionProfile(repoFullName: string, nowMs?: number): CachedContributionProfile | null;
export declare function putCachedContributionProfile(profile: ContributionProfile, nowMs?: number): {
    repoFullName: string;
    fetchedAt: string;
};
export declare function closeDefaultContributionProfileCache(): void;
