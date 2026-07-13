/** `feasibility` CLI command (#4270): a thin parse -> execute -> render wrapper around the engine's pure
 * `buildFeasibilityVerdict` composer. Purely local — no network, no filesystem — so it never needs the
 * npm-registry update check other subcommands opt into. */
import { buildFeasibilityVerdict } from "@jsonbored/gittensory-engine";
import { argsWantJson, reportCliFailure } from "./cli-error.js";

const CLAIM_STATUSES = ["unclaimed", "claimed", "solved", "unknown"];
const DUPLICATE_CLUSTER_RISKS = ["none", "low", "medium", "high"];
const ISSUE_STATUSES = ["ready", "needs_proof", "hold", "do_not_use", "duplicate", "invalid", "missing"];

const FEASIBILITY_USAGE =
  "Usage: gittensory-miner feasibility <claimStatus> <duplicateClusterRisk> <issueStatus> [--not-found] [--json]\n" +
  `  claimStatus: ${CLAIM_STATUSES.join("|")}\n` +
  `  duplicateClusterRisk: ${DUPLICATE_CLUSTER_RISKS.join("|")}\n` +
  `  issueStatus: ${ISSUE_STATUSES.join("|")}`;

export function parseFeasibilityArgs(args) {
  const options = { json: false, found: true };
  const positional = [];

  for (const token of args) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--not-found") {
      options.found = false;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length !== 3) {
    return { error: FEASIBILITY_USAGE };
  }

  const [claimStatus, duplicateClusterRisk, issueStatus] = positional;
  if (!CLAIM_STATUSES.includes(claimStatus)) {
    return { error: `claimStatus must be one of: ${CLAIM_STATUSES.join(", ")}.` };
  }
  if (!DUPLICATE_CLUSTER_RISKS.includes(duplicateClusterRisk)) {
    return { error: `duplicateClusterRisk must be one of: ${DUPLICATE_CLUSTER_RISKS.join(", ")}.` };
  }
  if (!ISSUE_STATUSES.includes(issueStatus)) {
    return { error: `issueStatus must be one of: ${ISSUE_STATUSES.join(", ")}.` };
  }

  return {
    claimStatus,
    duplicateClusterRisk,
    issueStatus,
    found: options.found,
    json: options.json,
  };
}

export function runFeasibilityCli(args, options = {}) {
  const parsed = parseFeasibilityArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  const buildVerdict = options.buildFeasibilityVerdict ?? buildFeasibilityVerdict;
  const verdict = buildVerdict({
    found: parsed.found,
    claimStatus: parsed.claimStatus,
    duplicateClusterRisk: parsed.duplicateClusterRisk,
    issueStatus: parsed.issueStatus,
  });

  if (parsed.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(`${verdict.verdict}: ${verdict.summary}`);
  }
  return 0;
}
