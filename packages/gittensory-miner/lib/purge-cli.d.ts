import type { ClaimLedger } from "./claim-ledger.js";
import type { EventLedger } from "./event-ledger.js";
import type { GovernorLedger } from "./governor-ledger.js";
import type { PredictionLedger } from "./prediction-ledger.js";

export const ATTEMPT_LOG_NOT_PURGEABLE_NOTE: string;

export type ParsedPurgeArgs = { json: boolean; dryRun: boolean; repoFullName: string } | { error: string };

export function parsePurgeArgs(args: string[]): ParsedPurgeArgs;

export type PurgeStoreResult = { store: string; purged: number | null; error?: string; note?: string };
export type PurgeDryRunStoreResult = { store: string; wouldPurge: number | null; error?: string };

export type PurgeDryRunResult = {
  outcome: "dry_run";
  repoFullName: string;
  stores: PurgeDryRunStoreResult[];
  attemptLogNote: string;
  attemptLogTotalRows: number;
};

export type PurgeSummary = {
  outcome: "purged" | "partial";
  repoFullName: string;
  totalPurged: number;
  stores: PurgeStoreResult[];
  purgedAt: string;
};

export type PurgeCliOptions = {
  openClaimLedger?: () => ClaimLedger;
  initEventLedger?: () => EventLedger;
  initGovernorLedger?: () => GovernorLedger;
  initPredictionLedger?: () => PredictionLedger;
  resolveDbPaths?: Record<string, () => string>;
};

export function runPurgeDryRun(
  parsed: { repoFullName: string; json: boolean },
  options?: PurgeCliOptions,
): number;

export function runPurge(args: string[], options?: PurgeCliOptions): number;
