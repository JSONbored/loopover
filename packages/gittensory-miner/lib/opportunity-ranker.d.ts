import type { MinerGoalSpec } from "@jsonbored/gittensory-engine";
import type { RawCandidateIssue } from "./opportunity-fanout.js";

export type RankedCandidateIssue = RawCandidateIssue & {
  potential: number;
  feasibility: number;
  laneFit: number;
  freshness: number;
  dupRisk: number;
  rankScore: number;
};

export type RankCandidateIssuesOptions = {
  nowMs?: number;
  highRiskDuplicateClusters?: number;
  openPullRequests?: number;
  goalSpecsByRepo?: Record<string, MinerGoalSpec>;
  goalSpecContentByRepo?: Record<string, string>;
};

export type RankedCandidateSummary = {
  issues: RankedCandidateIssue[];
  skippedInvalid: number;
  usedDefaultGoalSpec: boolean;
  defaultGoalSpec: MinerGoalSpec;
};

export function rankCandidateIssues(
  candidates: RawCandidateIssue[],
  options?: RankCandidateIssuesOptions,
): RankedCandidateIssue[];

export function rankCandidateIssuesWithSummary(
  candidates: RawCandidateIssue[],
  options?: RankCandidateIssuesOptions,
): RankedCandidateSummary;
