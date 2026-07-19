import type { LiveIssueSnapshot } from "./submission-freshness-check.js";
export type LiveIssueSnapshotFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}>;
/**
 * Real fetchLiveIssueSnapshot implementation: the live-state answer AttemptDeps/SubmissionFreshnessDeps
 * need, built from a single GraphQL round-trip. Returns null on any malformed input, transport failure, or
 * unrecognized GitHub response -- callers already treat a null snapshot as "state unavailable", so this
 * never throws.
 */
export declare function fetchLiveIssueSnapshot(repoFullName: string, issueNumber: number, options?: {
    githubToken?: string;
    graphqlUrl?: string;
    fetchImpl?: LiveIssueSnapshotFetch;
    requestTimeoutMs?: number;
}): Promise<LiveIssueSnapshot | null>;
