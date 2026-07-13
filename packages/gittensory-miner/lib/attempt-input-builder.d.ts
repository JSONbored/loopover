import type {
  AmsPolicySpec,
  CodingAgentExecutionMode,
  IterateLoopInput,
  PortfolioConvergenceInput,
  SelfReviewContext,
} from "@loopover/engine";
import type { AttemptGovernorContext } from "./attempt-runner.js";
import type { CodingTaskSpecResult } from "./coding-task-spec.js";

export function buildAttemptGovernorContext(
  env: Record<string, string | undefined>,
  amsPolicySpec: AmsPolicySpec,
  repoPaused?: boolean,
  convergenceInput?: PortfolioConvergenceInput,
): AttemptGovernorContext;

export type BuildAttemptLoopInputInput = {
  codingTaskSpec: Extract<CodingTaskSpecResult, { ready: true }>;
  reviewContext: SelfReviewContext;
  worktreePath: string;
  attemptId: string;
  mode: CodingAgentExecutionMode;
  repoFullName: string;
  minerLogin: string;
  rejectionSignaled: boolean;
  amsPolicySpec: AmsPolicySpec;
  branchRef?: string;
};

export function buildAttemptLoopInput(input: BuildAttemptLoopInputInput): IterateLoopInput;
