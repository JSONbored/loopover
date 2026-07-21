/** One merged-PR outcome as the endpoint reports it (mirrors ContributorPrOutcome in contributor-pr-outcomes.ts). */
export type ContributorPrOutcome = {
    repoFullName: string;
    pullNumber: number | null;
    outcome: "merged";
    attribution: string;
    deeplink: string;
    recordedAt: string;
};
/** The endpoint's full payload (mirrors ContributorPrOutcomes). */
export type ContributorPrOutcomes = {
    login: string;
    count: number;
    summary: string;
    outcomes: ContributorPrOutcome[];
};
export type FetchContributorPrOutcomesOptions = {
    /** Read for the loopover-mcp session + API URL -- defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Injected fetch, so tests drive the client without a real backend; defaults to the real global fetch. */
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    /** Cap merged-PR rows the endpoint returns (1..100); omitted lets the endpoint apply its own default. */
    limit?: number;
    requestTimeoutMs?: number;
};
/**
 * Fetch `login`'s post-merge PR-outcome history from the hosted backend. Requires an authenticated loopover-mcp
 * session (throws `no_loopover_session` otherwise, matching the endpoint's self-scoped access). `limit`, when given,
 * must be an integer in 1..100 -- the same bound the endpoint enforces -- else this throws before any network call.
 */
export declare function fetchContributorPrOutcomes(login: string, options?: FetchContributorPrOutcomesOptions): Promise<ContributorPrOutcomes>;
