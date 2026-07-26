// `loopover-miner deny-hooks` (#8806): the operator surface the deny-hook synthesis store (#5667) never
// had — which is WHY its guardrails never enforced: refreshProposals had no caller anywhere (no CLI, no
// wiring), so nothing ever populated or consumed the store outside tests. This module closes the operate
// half (list / approve / reject / refresh); buildAttemptDeps (#8806's other half) closes the enforce half
// by resolving the repo's effective rules into every coding-agent driver's PreToolUse hooks.
//
// `refresh` takes its blocker/path history from an explicit `--history <file.json>` (an array of
// `{ blockerCodes: string[], changedPaths: string[] }` records) — deliberately NOT auto-sourced: no local
// ledger carries both fields today (prediction-ledger has blockerCodes but no changedPaths), and inventing
// an implicit source here would hide that gap instead of documenting it. Auto-sourcing from the miner's own
// PR-outcome history is the tracked follow-up once a ledger records changed paths alongside blockers.
// Strictly local + offline (like `purge`/`queue`): only the local synthesis SQLite is touched.
import { readFileSync } from "node:fs";
import { initDenyHookSynthesisStore } from "./deny-hook-synthesis.js";

const USAGE = [
  "Usage:",
  "  loopover-miner deny-hooks list <owner/repo> [--json]",
  "  loopover-miner deny-hooks refresh <owner/repo> --history <file.json> [--json]",
  "  loopover-miner deny-hooks approve <owner/repo> <proposal-id>",
  "  loopover-miner deny-hooks reject <owner/repo> <proposal-id>",
].join("\n");

type HistoryRecord = { blockerCodes: string[]; changedPaths: string[] };

function parseHistoryFile(path: string): HistoryRecord[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("history file must be a JSON array of { blockerCodes, changedPaths } records");
  return parsed as HistoryRecord[];
}

export function runDenyHooks(args: string[]): number {
  const json = args.includes("--json");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [subcommand, repoFullName, proposalId] = positional;
  if (!subcommand || !repoFullName) {
    console.error(USAGE);
    return 2;
  }
  const store = initDenyHookSynthesisStore();
  try {
    switch (subcommand) {
      case "list": {
        const proposals = store.listProposals(repoFullName);
        const effective = store.resolveEffectiveRules(repoFullName);
        if (json) {
          console.log(JSON.stringify({ repoFullName, proposals, effectiveRuleCount: effective.length }, null, 2));
        } else if (proposals.length === 0) {
          console.log(`No synthesized proposals for ${repoFullName} (${effective.length} effective rule(s), all defaults).`);
        } else {
          for (const proposal of proposals) {
            console.log(`${proposal.id}  [${proposal.status}]  ${JSON.stringify(proposal.rule)}`);
          }
          console.log(`${effective.length} effective rule(s) including defaults — approved proposals enforce on the next attempt.`);
        }
        return 0;
      }
      case "refresh": {
        const historyFlag = args.indexOf("--history");
        const historyPath = historyFlag !== -1 ? args[historyFlag + 1] : undefined;
        if (!historyPath) {
          console.error("refresh requires --history <file.json>\n" + USAGE);
          return 2;
        }
        const proposals = store.refreshProposals(repoFullName, parseHistoryFile(historyPath));
        if (json) {
          console.log(JSON.stringify({ repoFullName, proposals }, null, 2));
        } else {
          console.log(`${proposals.length} proposal(s) for ${repoFullName} — approve with: loopover-miner deny-hooks approve ${repoFullName} <id>`);
        }
        return 0;
      }
      case "approve":
      case "reject": {
        if (!proposalId) {
          console.error(USAGE);
          return 2;
        }
        store.setProposalStatus(repoFullName, proposalId, subcommand === "approve" ? "approved" : "rejected");
        console.log(`${subcommand === "approve" ? "Approved" : "Rejected"} ${proposalId} for ${repoFullName}${subcommand === "approve" ? " — it enforces on the next attempt." : "."}`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    // String(error) renders an Error as "Error: <message>" — every throw site here (store methods,
    // readFileSync, JSON.parse, parseHistoryFile) throws real Errors, so a two-arm instanceof ternary
    // would carry a permanently-unreachable branch.
    console.error(String(error));
    return 1;
  } finally {
    store.close();
  }
}
