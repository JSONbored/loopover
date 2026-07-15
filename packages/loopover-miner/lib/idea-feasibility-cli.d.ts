import type {
  FeasibilityClaimStatus,
  FeasibilityDuplicateClusterRisk,
} from "@loopover/engine";
import type { AssessIdeaFeasibilityOptions } from "./idea-feasibility.js";

export type ParsedIdeaFeasibilityArgs =
  | {
      claimStatus: FeasibilityClaimStatus;
      duplicateClusterRisk: FeasibilityDuplicateClusterRisk;
      targetResolvable: boolean;
      acceptanceHints: string[];
      json: boolean;
    }
  | { error: string };

export type RunIdeaFeasibilityCliOptions = AssessIdeaFeasibilityOptions;

export function parseIdeaFeasibilityArgs(args: string[]): ParsedIdeaFeasibilityArgs;

export function runIdeaFeasibilityCli(args: string[], options?: RunIdeaFeasibilityCliOptions): number;
