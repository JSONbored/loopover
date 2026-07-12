import type { LiveIssueSnapshot } from "./submission-freshness-check.js";
import type { ObservedClaim } from "./claim-adjudication.js";
import type { LocalWriteActionSpec } from "@jsonbored/gittensory-engine";

export function assembleCompetingClaims(
  snapshot: LiveIssueSnapshot | null | undefined,
  selfPrNumber: number,
  minerLogin: string,
): ObservedClaim[];

export type ClaimConflictInput = {
  repoFullName: string;
  issueNumber: number;
  selfPrNumber: number;
  selfClaimedAt: string | null;
  minerLogin: string;
};

export type ClaimConflictDeps = {
  fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<LiveIssueSnapshot | null>;
  executeLocalWrite: (spec: LocalWriteActionSpec) => Promise<unknown>;
};

export type ClaimConflictResult =
  | { checked: false; reason: "live_state_unavailable" }
  | { checked: true; isWinner: true; winnerNumber: number | null; competingCount: number }
  | { checked: true; isWinner: false; winnerNumber: number | null; competingCount: number; closeResult: unknown };

export function resolveClaimConflict(input: ClaimConflictInput, deps: ClaimConflictDeps): Promise<ClaimConflictResult>;
