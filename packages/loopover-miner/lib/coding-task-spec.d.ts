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
 * Compute the feasibility verdict for one target issue, from real signals: whether the issue is present in
 * the fetched context, its real claim status (the claim ledger), and its real duplicate-cluster risk
 * (buildCollisionReport over the fetched issues/pullRequests). issueStatus is left to its documented
 * "ready" default -- see this file's header for why that's honest, not fabricated.
 *
 * @param {string} repoFullName
 * @param {{ number: number }} issue
 * @param {{ issues: Array<{ number: number }>, pullRequests: unknown[] }} context
 * @param {{ listClaims: (filter: { repoFullName: string, status: string }) => Array<{ issueNumber: number }> }} claimLedger
 * @returns {import("@loopover/engine").FeasibilityGateResult}
 */
export declare function buildCodingTaskFeasibility(repoFullName: string, issue: CodingTaskIssue, context: CodingTaskContext, claimLedger: CodingTaskClaimLedger): FeasibilityGateResult;
/**
 * Compose the immutable AcceptanceCriteria document for one target issue + its feasibility verdict.
 *
 * @param {{ title: string, body?: string | null, labels?: string[] }} issue
 * @param {import("@loopover/engine").FeasibilityGateResult} feasibility
 * @returns {import("@loopover/engine").AcceptanceCriteria}
 */
export declare function buildCodingTaskAcceptanceCriteria(issue: CodingTaskIssue, feasibility: FeasibilityGateResult): AcceptanceCriteria;
export declare function writeAcceptanceCriteriaFile(workingDirectory: string, acceptanceCriteria: AcceptanceCriteria): {
    written: boolean;
    path: string | null;
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
 *
 * @param {{
 *   repoFullName: string, issue: { number: number, title: string, body?: string | null, labels?: string[] },
 *   context: { issues: Array<{ number: number }>, pullRequests: unknown[] },
 *   claimLedger: { listClaims: (filter: { repoFullName: string, status: string }) => Array<{ issueNumber: number }> },
 *   workingDirectory: string,
 *   detectRepoStack?: (repoPath: string) => import("./stack-detection.js").RepoStackResult,
 * }} input
 * @returns {import("./coding-task-spec.js").CodingTaskSpecResult}
 */
export declare function buildCodingTaskSpec(input: CodingTaskSpecInput): CodingTaskSpecResult;
