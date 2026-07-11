import type {
  WriteRateLimitBackoffStore,
  WriteRateLimitBucketStore,
  WriteRateLimitPolicies,
  WriteRateLimitVerdict,
} from "@jsonbored/gittensory-engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";

export type EvaluateWriteRateLimitGateInput = {
  actionClass: string;
  repoFullName: string;
  buckets: WriteRateLimitBucketStore;
  backoffAttempts: WriteRateLimitBackoffStore;
  nowMs: number;
  policies?: WriteRateLimitPolicies;
  randomFn?: () => number;
};

export type EvaluateWriteRateLimitGateResult = {
  verdict: WriteRateLimitVerdict;
  recorded: GovernorLedgerEntry;
  buckets: WriteRateLimitBucketStore;
  backoffAttempts: WriteRateLimitBackoffStore;
  retryAtMs: number | null;
};

export function evaluateWriteRateLimitGate(
  input: EvaluateWriteRateLimitGateInput,
  options?: { append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry },
): EvaluateWriteRateLimitGateResult;
