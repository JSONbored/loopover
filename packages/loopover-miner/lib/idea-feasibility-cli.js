/** `idea-feasibility` CLI command: the freeform-idea counterpart to the metadata `feasibility` CLI
 * (feasibility-cli.js, #4270). It runs a freeform Rent-a-Loop idea submission (#4779) through the
 * pre-compute feasibility gate (idea-feasibility.js, #5671) so a renter can no longer burn compute on an
 * idea that was never going to succeed — the same parse -> execute -> render wrapper the metadata gate uses,
 * only the idea's `issueStatus` is DERIVED from its own structure rather than supplied. Purely local — no
 * network, no filesystem — so it never needs the npm-registry update check other subcommands opt into. */
import { assessIdeaFeasibility } from "./idea-feasibility.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";

const CLAIM_STATUSES = ["unclaimed", "claimed", "solved", "unknown"];
const DUPLICATE_CLUSTER_RISKS = ["none", "low", "medium", "high"];

const IDEA_FEASIBILITY_USAGE =
  "Usage: loopover-miner idea-feasibility <claimStatus> <duplicateClusterRisk> [--not-resolvable] [--hint <text>]... [--json]\n" +
  `  claimStatus: ${CLAIM_STATUSES.join("|")}\n` +
  `  duplicateClusterRisk: ${DUPLICATE_CLUSTER_RISKS.join("|")}\n` +
  "  --not-resolvable: the idea's target repo does not resolve to a repo the loop can act on (issueStatus=missing)\n" +
  "  --hint <text>: an objective acceptance signal (repeatable); an idea declaring none is invalid (issueStatus=invalid)";

export function parseIdeaFeasibilityArgs(args) {
  const options = { json: false, targetResolvable: true, acceptanceHints: [] };
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--not-resolvable") {
      options.targetResolvable = false;
      continue;
    }
    if (token === "--hint") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "--hint requires a value." };
      }
      options.acceptanceHints.push(value);
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length !== 2) {
    return { error: IDEA_FEASIBILITY_USAGE };
  }

  const [claimStatus, duplicateClusterRisk] = positional;
  if (!CLAIM_STATUSES.includes(claimStatus)) {
    return { error: `claimStatus must be one of: ${CLAIM_STATUSES.join(", ")}.` };
  }
  if (!DUPLICATE_CLUSTER_RISKS.includes(duplicateClusterRisk)) {
    return { error: `duplicateClusterRisk must be one of: ${DUPLICATE_CLUSTER_RISKS.join(", ")}.` };
  }

  return {
    claimStatus,
    duplicateClusterRisk,
    targetResolvable: options.targetResolvable,
    acceptanceHints: options.acceptanceHints,
    json: options.json,
  };
}

export function runIdeaFeasibilityCli(args, options = {}) {
  const parsed = parseIdeaFeasibilityArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  const assessment = assessIdeaFeasibility(
    { acceptanceHints: parsed.acceptanceHints },
    {
      targetResolvable: parsed.targetResolvable,
      claimStatus: parsed.claimStatus,
      duplicateClusterRisk: parsed.duplicateClusterRisk,
    },
    options,
  );

  if (parsed.json) {
    console.log(JSON.stringify(assessment, null, 2));
  } else {
    console.log(`${assessment.disposition}: ${assessment.summary}`);
  }
  return 0;
}
