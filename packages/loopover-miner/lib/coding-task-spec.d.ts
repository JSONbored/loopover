import type { AcceptanceCriteria, FeasibilityGateResult, FeasibilityVerdict, IssueRecord, PullRequestRecord } from "@loopover/engine";
import type { RepoStackResult } from "./stack-detection.js";
export type CodingTaskIssue = {
    number: number;
    title: string;
    body?: string | null | undefined;
    labels?: string[] | undefined;
};
export type CodingTaskClaimLedger = {
    listClaims(filter: {
        repoFullName: string;
        status: string;
    }): Array<{
        issueNumber: number;
    }>;
};
export type CodingTaskContext = {
    issues: IssueRecord[];
    pullRequests: PullRequestRecord[];
};
/**
 * Compute the feasibility verdict for one target issue, from real signals: whether the issue is present in
 * the fetched context, its real claim status (the claim ledger), and its real duplicate-cluster risk
 * (buildCollisionReport over the fetched issues/pullRequests). issueStatus is left to its documented
 * "ready" default -- see this file's header for why that's honest, not fabricated.
 */
export declare function buildCodingTaskFeasibility(repoFullName: string, issue: CodingTaskIssue, context: CodingTaskContext, claimLedger: CodingTaskClaimLedger): FeasibilityGateResult;
/**
 * Compose the immutable AcceptanceCriteria document for one target issue + its feasibility verdict.
 */
export declare function buildCodingTaskAcceptanceCriteria(issue: CodingTaskIssue, feasibility: FeasibilityGateResult): AcceptanceCriteria;
/**
 * Write the acceptance-criteria document into the prepared worktree -- only when its own verdict authorizes
 * it (shouldWriteAcceptanceCriteria: verdict === "go"). A raise/avoid verdict writes nothing; the caller is
 * expected to abandon the attempt rather than start it, per acceptance-criteria.ts's own documented design.
 */
export declare function writeAcceptanceCriteriaFile(workingDirectory: string, acceptanceCriteria: AcceptanceCriteria): {
    written: boolean;
    path: string | null;
};
export type CodingTaskSpecInput = {
    repoFullName: string;
    issue: CodingTaskIssue;
    context: CodingTaskContext;
    claimLedger: CodingTaskClaimLedger;
    workingDirectory: string;
    /** Injectable stack detector (#4786); omitted falls back to stack-detection.js's real `detectRepoStack`. */
    detectRepoStack?: (repoPath: string) => RepoStackResult;
};
export type CodingTaskSpecResult = {
    ready: false;
    verdict: FeasibilityVerdict;
    feasibility: FeasibilityGateResult;
} | {
    ready: true;
    verdict: FeasibilityVerdict;
    feasibility: FeasibilityGateResult;
    acceptanceCriteriaPath: string;
    instructions: string;
    title: string;
    body: string | undefined;
    labels: string[] | undefined;
    linkedIssues: number[];
};
/**
 * Full composition: feasibility -> acceptance criteria -> (if authorized) write the file -> detect the
 * target-repo stack (#4786) -> instructions. Returns `ready: false` (with the computed feasibility verdict,
 * for the caller to report) when the verdict is `raise`/`avoid` -- the caller should abandon the attempt
 * rather than proceed with no real acceptance-criteria file on disk.
 *
 * `detectRepoStack` is injectable so tests can assert both the detected and fail-closed undiscovered stack
 * branches without depending on real filesystem probes; omitted falls back to stack-detection.js's real
 * `detectRepoStack` (the production default).
 */
export declare function buildCodingTaskSpec(input: CodingTaskSpecInput): CodingTaskSpecResult;
