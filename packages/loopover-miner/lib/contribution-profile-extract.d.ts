import { type ContributionProfile } from "./contribution-profile.js";
/**
 * Extract a best-effort ContributionProfile for a repo from what it actually publishes.
 */
export declare function extractContributionProfile(repoFullName: string, options?: {
    fetchImpl?: typeof fetch;
    githubToken?: string;
    apiBaseUrl?: string;
    /** ISO timestamp for the profile's generatedAt; defaults to now. Injected so tests stay deterministic. */
    generatedAt?: string;
    /** Sleep seam for the transient-5xx/rate-limit retry (via fetchWithRetry). Injected so tests use no real timers. */
    sleepFn?: (ms: number) => Promise<unknown>;
}): Promise<ContributionProfile>;
