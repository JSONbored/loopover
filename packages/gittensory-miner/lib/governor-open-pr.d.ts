import type {
  OwnSubmissionRecord,
  SelfPlagiarismCandidate,
  SelfPlagiarismVerdict,
} from "@jsonbored/gittensory-engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";

export type EvaluateOpenPrSelfPlagiarismInput = {
  candidate: SelfPlagiarismCandidate;
  recentOwnSubmissions?: readonly OwnSubmissionRecord[];
  selfPlagiarismConfig?: unknown;
};

export type EvaluateOpenPrSelfPlagiarismOptions = {
  append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
};

export function evaluateOpenPrSelfPlagiarism(
  input: EvaluateOpenPrSelfPlagiarismInput,
  options?: EvaluateOpenPrSelfPlagiarismOptions,
): { verdict: SelfPlagiarismVerdict; recorded: GovernorLedgerEntry };
