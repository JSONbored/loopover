export type RejectionSignaledReason = "ai_usage_policy_ban" | "own_submission_rejected";
export declare const REJECTION_REASON_AI_USAGE_POLICY_BAN = "ai_usage_policy_ban";
export declare const REJECTION_REASON_OWN_SUBMISSION_REJECTED = "own_submission_rejected";
export type RejectionSignalFetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
}) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    headers?: {
        get(name: string): string | null;
    };
    body?: {
        getReader(): {
            read(): Promise<{
                done: boolean;
                value?: Uint8Array;
            }>;
            cancel(): Promise<void>;
            releaseLock(): void;
        };
    } | null;
}>;
type OwnRejectionHistorySubmission = {
    pullRequestNumber?: number | null | undefined;
};
type ListOwnSubmissions = (filter: {
    repoFullName?: string;
}) => OwnRejectionHistorySubmission[];
export interface OwnRejectionHistoryOptions {
    listSubmissions?: ListOwnSubmissions;
    fetchImpl?: RejectionSignalFetch;
    githubToken?: string;
    githubApiBaseUrl?: string;
    maxRejectionHistoryChecks?: number;
}
export interface RejectionSignaledOptions extends OwnRejectionHistoryOptions {
    rawContentBaseUrl?: string;
}
/**
 * Resolve the SECOND `rejectionSignaled` trigger (#5655): has a prior submission from THIS miner on THIS exact
 * repo already been closed/rejected? Reads this miner's own recorded submissions on the repo
 * (`listRecentOwnSubmissions`, #5134), fetches each one's live PR state, and runs it through `resolveRejection`
 * (#4278) -- returning `true` if ANY was closed without merge. Bounded (only the most recent
 * `maxRejectionHistoryChecks` submissions with a real PR number are fetched) and fully fail-open: a wholesale
 * failure to read submissions resolves to `false` (never fabricated as a rejection), and any single PR
 * fetch/parse failure is skipped so it never blocks the others. Consumes both upstream modules without modifying
 * either. Every dependency is injectable for testing.
 */
export declare function resolveOwnRejectionHistory(repoFullName: string, options?: OwnRejectionHistoryOptions): Promise<boolean>;
/**
 * Resolve whether the target repo has signaled it does not want automated/AI-authored contributions --
 * either trigger documented above. Returns `false` (never throws) on any fetch/parse failure for the policy
 * docs, matching resolveAiPolicyVerdict's own fail-open default for an absent/unreadable policy doc. When a
 * trigger fires, returns a trigger-specific reason string so callers can label audit-trail events accurately.
 */
export declare function resolveRejectionSignaled(repoFullName: string, options?: RejectionSignaledOptions): Promise<false | RejectionSignaledReason | true>;
export {};
