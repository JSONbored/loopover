import type {
  FeasibilityClaimStatus,
  FeasibilityDuplicateClusterRisk,
  FeasibilityGateInput,
  FeasibilityGateResult,
  FeasibilityIssueStatus,
} from "@jsonbored/gittensory-engine";

export type ParsedFeasibilityArgs =
  | {
      claimStatus: FeasibilityClaimStatus;
      duplicateClusterRisk: FeasibilityDuplicateClusterRisk;
      issueStatus: FeasibilityIssueStatus;
      found: boolean;
      json: boolean;
    }
  | { error: string };

export type RunFeasibilityCliOptions = {
  buildFeasibilityVerdict?: (input: FeasibilityGateInput) => FeasibilityGateResult;
};

export function parseFeasibilityArgs(args: string[]): ParsedFeasibilityArgs;

export function runFeasibilityCli(args: string[], options?: RunFeasibilityCliOptions): number;
