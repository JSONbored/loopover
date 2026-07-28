// The tool registry (#9517).
//
// Every MCP tool LoopOver serves, from any of its three servers, has exactly one entry here. A
// runtime registers the slice it can actually serve by filtering on locality/availability -- it
// does not keep its own list.
import { projectToolDefinitions, type McpToolDefinition, type ToolContract, type ToolFilter } from "../tool-definition.js";
import { getRepoContextTool } from "./repo-context.js";
import { getPrReviewabilityTool } from "./pr-reviewability.js";
import { predictGateTool } from "./predict-gate.js";
import { preflightPrTool } from "./preflight-pr.js";
import { localStatusStructuredTool } from "./local-status.js";
import { adminGetConfigTool } from "./admin-config.js";
import {
  minerPingTool,
  minerPortfolioDashboardTool,
  minerManageStatusTool,
  minerListClaimsTool,
  minerAuditFeedTool,
  minerGetRunStateTool,
  minerListPlansTool,
  minerGetPlanTool,
  minerGovernorDecisionsTool,
  minerStatusTool,
  minerCalibrationReportTool,
} from "./miner.js";

/**
 * Pilot batch (#9517) plus the full AMS miner server (#9536, all 11 tools -- the first server
 * migrated to completion). The remaining ~110 remote / ~91 stdio tools migrate in #9518/#9537's
 * category batches.
 */
export const TOOL_CONTRACTS: readonly ToolContract[] = [
  getRepoContextTool,
  getPrReviewabilityTool,
  predictGateTool,
  preflightPrTool,
  localStatusStructuredTool,
  adminGetConfigTool,
  minerPingTool,
  minerPortfolioDashboardTool,
  minerManageStatusTool,
  minerListClaimsTool,
  minerAuditFeedTool,
  minerGetRunStateTool,
  minerListPlansTool,
  minerGetPlanTool,
  minerGovernorDecisionsTool,
  minerStatusTool,
  minerCalibrationReportTool,
];

const CONTRACTS_BY_NAME: ReadonlyMap<string, ToolContract> = new Map(
  TOOL_CONTRACTS.map((contract) => [contract.name, contract]),
);

/** The single projection every consumer reads. Nothing downstream touches TOOL_CONTRACTS. */
export function listToolDefinitions(filter: ToolFilter = {}): McpToolDefinition[] {
  return projectToolDefinitions(TOOL_CONTRACTS, filter);
}

/** Lookup for a runtime that needs the zod objects themselves (`.shape` for the MCP SDK, or
 *  `.parse` to validate a response) rather than the JSON Schema projection. */
export function getToolContract(name: string): ToolContract | undefined {
  return CONTRACTS_BY_NAME.get(name);
}

// Re-export each family wholesale so consumers can reach the individual input/output schemas (and
// the shared sub-shapes like laneAdviceSchema) without importing deep paths.
export * from "./repo-context.js";
export * from "./pr-reviewability.js";
export * from "./predict-gate.js";
export * from "./preflight-pr.js";
export * from "./local-status.js";
export * from "./admin-config.js";
export * from "./miner.js";
