import type { FocusManifest, SelfReviewContext } from "@loopover/engine";
export type SelfReviewContextResult = Omit<SelfReviewContext, "bounties">;
export type SelfReviewContextFetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}>;
export type LiveGateThresholdFields = {
    confidence_floor: number | null;
    scope_cap_files: number | null;
    scope_cap_lines: number | null;
};
export type LoopoverBackendSessionAuth = {
    apiUrl?: string;
    sessionToken: string;
};
export type FetchSelfReviewContextOptions = {
    githubToken?: string;
    contributorLogin?: string;
    linkedIssues?: number[];
    apiBaseUrl?: string;
    rawContentBaseUrl?: string;
    gittensorApiBase?: string;
    fetchImpl?: SelfReviewContextFetch;
    perPage?: number;
    maxPages?: number;
    requestTimeoutMs?: number;
    /** Short ORB live-gate-thresholds probe budget (#6487). Default 400ms. */
    liveGateProbeTimeoutMs?: number;
    /** Explicit session auth for the ORB probe; `null` forces standalone (skip probe). */
    loopoverAuth?: LoopoverBackendSessionAuth | null;
    /** Env used to resolve loopover-mcp session when `loopoverAuth` is omitted. */
    env?: NodeJS.ProcessEnv;
};
/** Validate the field-limited #6486/#6487 payload; null when nothing usable is present. */
export declare function parseLiveGateThresholdFields(payload: unknown): LiveGateThresholdFields | null;
/**
 * Overlay live ORB thresholds onto a statically-reconstructed FocusManifest (#6487).
 * - confidence_floor → raise-only readinessMinScore (mirrors applySelfTuneOverrideToSettings).
 * - scope_cap_files / scope_cap_lines → prefer live sizeMaxFiles / sizeMaxLines when present.
 * Other gate fields are left untouched.
 */
export declare function applyLiveGateThresholdsToManifest(manifest: FocusManifest, fields: LiveGateThresholdFields | null): FocusManifest;
export declare function extractLinkedIssueNumbers(body: any, repoFullName: any): number[];
/**
 * Build a real SelfReviewContext from live GitHub data, at the same fidelity the live gate's own DB-backed
 * construction produces. See this file's header for the one field (bounties) deliberately left undefined
 * and why; issueQuality is populated from the live GitHub snapshot. Optionally overlays ORB live gate
 * thresholds onto the static `.loopover.yml` reconstruction (#6487).
 *
 * @param {string} repoFullName
 * @param {{
 *   githubToken?: string, contributorLogin?: string, linkedIssues?: number[],
 *   apiBaseUrl?: string, rawContentBaseUrl?: string, gittensorApiBase?: string,
 *   fetchImpl?: typeof fetch, perPage?: number, maxPages?: number, requestTimeoutMs?: number,
 *   liveGateProbeTimeoutMs?: number,
 *   loopoverAuth?: { apiUrl?: string, sessionToken: string } | null,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {Promise<import("./self-review-context.js").SelfReviewContextResult>}
 */
export declare function fetchSelfReviewContext(repoFullName: string, options?: FetchSelfReviewContextOptions): Promise<SelfReviewContextResult>;
