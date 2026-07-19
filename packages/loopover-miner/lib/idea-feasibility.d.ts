import type { FeasibilityClaimStatus, FeasibilityDuplicateClusterRisk, FeasibilityGateInput, FeasibilityGateResult, FeasibilityIssueStatus, FeasibilityVerdict } from "@loopover/engine";
/** A schema-validated idea submission (#4779). This structural gate only reads `acceptanceHints`, but accepts
 *  the full submission so callers can pass the idea through unchanged. */
export type IdeaFeasibilityInput = {
    title?: string | undefined;
    body?: string | undefined;
    targetRepo?: string | undefined;
    constraints?: readonly string[] | undefined;
    acceptanceHints?: readonly string[] | undefined;
    priority?: "normal" | "high" | undefined;
};
/** Objectively-resolved intake signals for the idea (resolved by the caller, never guessed from prose). */
export type ResolvedIdeaSignals = {
    targetResolvable: boolean;
    claimStatus: FeasibilityClaimStatus;
    duplicateClusterRisk: FeasibilityDuplicateClusterRisk;
};
export type AssessIdeaFeasibilityOptions = {
    buildFeasibilityVerdict?: (input: FeasibilityGateInput) => FeasibilityGateResult;
};
export type IdeaFeasibilityDisposition = "proceed" | "flag" | "reject";
export type IdeaFeasibilityResult = {
    disposition: IdeaFeasibilityDisposition;
    verdict: FeasibilityVerdict;
    issueStatus: FeasibilityIssueStatus;
    reasons: string[];
    summary: string;
};
/**
 * Derive the feasibility `issueStatus` for a freeform idea from objective, structural signals only — never from
 * a semantic read of the prose.
 */
export declare function deriveIdeaIssueStatus(idea: IdeaFeasibilityInput, resolved: Pick<ResolvedIdeaSignals, "targetResolvable">): FeasibilityIssueStatus;
/**
 * Assess a schema-validated idea's feasibility before compute is allocated.
 */
export declare function assessIdeaFeasibility(idea: IdeaFeasibilityInput, resolved: ResolvedIdeaSignals, options?: AssessIdeaFeasibilityOptions): IdeaFeasibilityResult;
