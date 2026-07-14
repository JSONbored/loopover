// Governor open_pr self-plagiarism gate (#2345). Consults the engine's pure selfPlagiarismCheck before an open_pr
// write is allowed and records throttled/denied outcomes to the append-only governor ledger.

import {
  buildSelfPlagiarismGovernorLedgerEvent,
  resolveSelfPlagiarismConfig,
  selfPlagiarismCheck,
} from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";

/**
 * Run the self-plagiarism throttle for a prospective open_pr and persist the governor decision.
 *
 * @param {object} input
 * @param {import("@loopover/engine").SelfPlagiarismCandidate} input.candidate
 * @param {readonly import("@loopover/engine").OwnSubmissionRecord[]} input.recentOwnSubmissions
 * @param {unknown} [input.selfPlagiarismConfig] parsed `.loopover-miner.yml` selfPlagiarism block
 * @param {{ append?: typeof appendGovernorEvent }} [options]
 */
export function evaluateOpenPrSelfPlagiarism(input, options = {}) {
  const append = options.append ?? appendGovernorEvent;
  const config = resolveSelfPlagiarismConfig(input.selfPlagiarismConfig);
  const verdict = selfPlagiarismCheck(input.candidate, input.recentOwnSubmissions ?? [], config);
  const ledgerEvent = buildSelfPlagiarismGovernorLedgerEvent(input.candidate.repoFullName, verdict);
  const recorded = append(ledgerEvent);
  return { verdict, recorded };
}
