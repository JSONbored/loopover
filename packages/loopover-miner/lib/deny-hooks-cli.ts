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
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

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

type ParsedDenyHooksArgs =
  | { subcommand: string | undefined; repoFullName: string | undefined; proposalId: string | undefined; historyPath: string | undefined; json: boolean }
  | { error: string };

/** Index-based parse (mirroring `parseRepoIdentifierArgs` in `portfolio-queue-cli.ts`): consume `--history <value>`
 *  as a flag+value pair so the value never leaks into the positional list (the `args.filter` bug this replaces —
 *  same class as closed #5833's `hooks check --tool/--input`). A missing or flag-like `--history` value, and any
 *  unrecognized `-`-prefixed token, are parse errors here rather than downstream nonsense-repo operations. */
export function parseDenyHooksArgs(args: string[]): ParsedDenyHooksArgs {
  let json = false;
  let historyPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--history") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: "refresh requires --history <file.json>\n" + USAGE };
      }
      historyPath = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }
  const [subcommand, repoFullName, proposalId] = positional;
  return { subcommand, repoFullName, proposalId, historyPath, json };
}

export function runDenyHooks(args: string[]): number {
  const parsed = parseDenyHooksArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }
  const { subcommand, repoFullName, proposalId, historyPath, json } = parsed;
  if (!subcommand || !repoFullName) {
    return reportCliFailure(json, USAGE);
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
        if (!historyPath) {
          return reportCliFailure(json, "refresh requires --history <file.json>\n" + USAGE);
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
          return reportCliFailure(json, USAGE);
        }
        store.setProposalStatus(repoFullName, proposalId, subcommand === "approve" ? "approved" : "rejected");
        console.log(`${subcommand === "approve" ? "Approved" : "Rejected"} ${proposalId} for ${repoFullName}${subcommand === "approve" ? " — it enforces on the next attempt." : "."}`);
        return 0;
      }
      default:
        return reportCliFailure(json, USAGE);
    }
  } catch (error) {
    return reportCliFailure(json, describeCliError(error));
  } finally {
    store.close();
  }
}
