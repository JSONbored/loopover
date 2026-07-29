// The tool registry (#9517).
//
// Every MCP tool LoopOver serves, from any of its three servers, has exactly one entry here. A
// runtime registers the slice it can actually serve by filtering on locality/availability -- it
// does not keep its own list.
import { projectToolDefinition, projectToolDefinitions, type McpToolDefinition, type ToolContract, type ToolFilter } from "../tool-definition.js";
import { getRepoContextTool } from "./repo-context.js";
import { getPrReviewabilityTool } from "./pr-reviewability.js";
import { predictGateTool } from "./predict-gate.js";
import { preflightPrTool } from "./preflight-pr.js";
import { localStatusStructuredTool } from "./local-status.js";
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
import { adminGetConfigTool, adminWriteConfigTool, adminListConfigBackupsTool, adminTriggerRedeployTool } from "./admin-config.js";
import {
  getMaintainerNoiseTool,
  getAmsMinerCohortTool,
  getRepoFocusManifestTool,
  refreshRepoFocusManifestTool,
  getActivationPreviewTool,
  getLabelAuditTool,
  getMaintainerLaneTool,
  getRepoOnboardingPackTool,
  getRegistrationReadinessTool,
  getConfigRecommendationTool,
  getBurdenForecastTool,
  getRepoOutcomePatternsTool,
  getOutcomeCalibrationTool,
  getGatePrecisionTool,
  getSelftuneOverrideAuditTool,
  clearSelftuneOverrideTool,
  fileIncidentReportTool,
  getSkippedPrAuditTool,
  getFleetAnalyticsTool,
  getRecommendationQualityTool,
  getIssueQualityTool,
  getLiveGateThresholdsTool,
  getGateConfigEffectiveTool,
  getRepoSettingsTool,
  refreshRepoDocsTool,
  generateContributorIssueDraftsTool,
  planRepoIssuesTool,
} from "./maintainer.js";
import {
  explainGateDispositionTool,
  checkSlopRiskTool,
  checkImprovementPotentialTool,
  checkTestEvidenceTool,
  checkIssueSlopTool,
  suggestBoundaryTestsTool,
  prOutcomeTool,
  getPrAiReviewFindingsTool,
  getPrMaintainerPacketTool,
  lintPrTextTool,
  explainScoreBreakdownTool,
  explainReviewRiskTool,
} from "./review.js";
import { preflightLocalDiffTool, runLocalScorerTool } from "./branch.js";
import {
  getContributorProfileTool,
  getDecisionPackTool,
  monitorOpenPrsTool,
  explainRepoDecisionTool,
  getBountyAdvisoryTool,
  listBountiesTool,
  getBountyLifecycleTool,
  validateLinkedIssueTool,
  checkBeforeStartTool,
  listNotificationsTool,
  getRegistryChangesTool,
  getRegistrySnapshotTool,
  getUpstreamDriftTool,
  getUpstreamRulesetTool,
  validateConfigTool,
  localStatusTool,
} from "./discovery-utility.js";
import {
  intakeIdeaTool,
  planIdeaClaimsTool,
  buildResultsPayloadTool,
  buildProgressSnapshotTool,
  evaluateEscalationTool,
  openPrTool,
  fileIssueTool,
  applyLabelsTool,
  postEligibilityCommentTool,
  postSoftClaimTool,
  createBranchTool,
  deleteBranchTool,
  generateTestsTool,
  fileFollowUpIssueTool,
  closePrTool,
  buildPlanTool,
  planStatusTool,
  recordStepResultTool,
  getAutomationStateTool,
  setAgentPausedTool,
  setActionAutonomyTool,
  proposeActionTool,
  listPendingActionsTool,
  decidePendingActionTool,
  getAgentAuditFeedTool,
  agentPlanNextWorkTool,
  agentExplainNextActionTool,
  agentStartRunTool,
  agentGetRunTool,
} from "./agent.js";
import {
  preflightCurrentBranchTool,
  previewCurrentBranchScoreTool,
  rankLocalNextActionsTool,
  explainLocalBlockersTool,
  remediationPlanTool,
  preparePrPacketTool,
  agentPreparePrPacketTool,
  reviewPrBeforePushTool,
  draftPrBodyTool,
  compareLocalVariantsTool,
  previewLocalPrScoreTool,
  getEligibilityPlanTool,
  comparePrVariantsTool,
  feasibilityGateTool,
  markNotificationsReadTool,
  watchIssuesTool,
  findOpportunitiesTool,
  retrieveIssueContextTool,
  simulateOpenPrPressureTool,
} from "./local-branch.js";

/**
 * #9517's pilot batch, the full AMS miner server (#9536, all 11 tools), and the remote server's
 * every remote-server category (#9518) -- the second server migrated to completion. The stdio
 * server is the last one left, and has its own issue (#9537).
 */
import { OPS_TOOLS } from "./ops.js";
import { FLEET_TOOLS } from "./fleet.js";
import { TENANT_TOOLS } from "./tenant.js";
import { INSTANCE_OPS_TOOLS } from "./instance-ops.js";
import { MINER_OPS_TOOLS } from "./miner-ops.js";
import { AMS_TENANT_TOOLS } from "./ams-tenant.js";
import { adminRotateSecretTool } from "./admin-config.js";

export const TOOL_CONTRACTS: readonly ToolContract[] = [
  getRepoContextTool,
  getPrReviewabilityTool,
  predictGateTool,
  preflightPrTool,
  localStatusStructuredTool,
  adminGetConfigTool,
  adminWriteConfigTool,
  adminListConfigBackupsTool,
  adminTriggerRedeployTool,
  getMaintainerNoiseTool,
  getAmsMinerCohortTool,
  getRepoFocusManifestTool,
  refreshRepoFocusManifestTool,
  getActivationPreviewTool,
  getLabelAuditTool,
  getMaintainerLaneTool,
  getRepoOnboardingPackTool,
  getRegistrationReadinessTool,
  getConfigRecommendationTool,
  getBurdenForecastTool,
  getRepoOutcomePatternsTool,
  getOutcomeCalibrationTool,
  getGatePrecisionTool,
  getSelftuneOverrideAuditTool,
  clearSelftuneOverrideTool,
  fileIncidentReportTool,
  getSkippedPrAuditTool,
  getFleetAnalyticsTool,
  getRecommendationQualityTool,
  getIssueQualityTool,
  getLiveGateThresholdsTool,
  getGateConfigEffectiveTool,
  getRepoSettingsTool,
  refreshRepoDocsTool,
  generateContributorIssueDraftsTool,
  planRepoIssuesTool,
  explainGateDispositionTool,
  checkSlopRiskTool,
  checkImprovementPotentialTool,
  checkTestEvidenceTool,
  checkIssueSlopTool,
  suggestBoundaryTestsTool,
  prOutcomeTool,
  getPrAiReviewFindingsTool,
  getPrMaintainerPacketTool,
  lintPrTextTool,
  explainScoreBreakdownTool,
  explainReviewRiskTool,
  preflightLocalDiffTool,
  runLocalScorerTool,
  getContributorProfileTool,
  getDecisionPackTool,
  monitorOpenPrsTool,
  explainRepoDecisionTool,
  getBountyAdvisoryTool,
  listBountiesTool,
  getBountyLifecycleTool,
  validateLinkedIssueTool,
  checkBeforeStartTool,
  listNotificationsTool,
  getRegistryChangesTool,
  getRegistrySnapshotTool,
  getUpstreamDriftTool,
  getUpstreamRulesetTool,
  validateConfigTool,
  localStatusTool,
  intakeIdeaTool,
  planIdeaClaimsTool,
  buildResultsPayloadTool,
  buildProgressSnapshotTool,
  evaluateEscalationTool,
  openPrTool,
  fileIssueTool,
  applyLabelsTool,
  postEligibilityCommentTool,
  postSoftClaimTool,
  createBranchTool,
  deleteBranchTool,
  generateTestsTool,
  fileFollowUpIssueTool,
  closePrTool,
  buildPlanTool,
  planStatusTool,
  recordStepResultTool,
  getAutomationStateTool,
  setAgentPausedTool,
  setActionAutonomyTool,
  proposeActionTool,
  listPendingActionsTool,
  decidePendingActionTool,
  getAgentAuditFeedTool,
  agentPlanNextWorkTool,
  agentExplainNextActionTool,
  agentStartRunTool,
  agentGetRunTool,
  preflightCurrentBranchTool,
  previewCurrentBranchScoreTool,
  rankLocalNextActionsTool,
  explainLocalBlockersTool,
  remediationPlanTool,
  preparePrPacketTool,
  agentPreparePrPacketTool,
  reviewPrBeforePushTool,
  draftPrBodyTool,
  compareLocalVariantsTool,
  previewLocalPrScoreTool,
  getEligibilityPlanTool,
  comparePrVariantsTool,
  feasibilityGateTool,
  markNotificationsReadTool,
  watchIssuesTool,
  findOpportunitiesTool,
  retrieveIssueContextTool,
  simulateOpenPrPressureTool,
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
  // #9522's management families. Spread rather than listed one-by-one so adding a tool to a family file is
  // the only edit -- the registry cannot fall behind a family the way the old hand-listed map did.
  adminRotateSecretTool,
  ...INSTANCE_OPS_TOOLS,
  ...OPS_TOOLS,
  ...FLEET_TOOLS,
  ...TENANT_TOOLS,
  ...MINER_OPS_TOOLS,
  ...AMS_TENANT_TOOLS,
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

/**
 * One tool's PROJECTED definition -- what a server must advertise for it (#9655).
 *
 * The raw contract is not what goes on the wire: `annotations` there is a `Partial` stating only what
 * differs from the default posture, so a server reading it directly advertises `{ readOnlyHint: false }`
 * with no `destructiveHint` for a tool that declares one field, and nothing at all for a tool that
 * declares none. Three servers each doing that produced three different advertised tools from one entry.
 * This is `listToolDefinitions()` for a single name, so the defaults are applied in exactly one place.
 */
export function getToolDefinition(name: string): McpToolDefinition | undefined {
  const contract = CONTRACTS_BY_NAME.get(name);
  return contract ? projectToolDefinition(contract) : undefined;
}

// The projection helpers, re-exported so a server registering from this entry point does not have to
// import the root one as well just to apply the annotation defaults.
export { projectToolDefinition, projectToolDefinitions, type McpToolDefinition, type ToolContract } from "../tool-definition.js";

// Re-export each family wholesale so consumers can reach the individual input/output schemas (and
// the shared sub-shapes like laneAdviceSchema) without importing deep paths.
export * from "./repo-context.js";
export * from "./pr-reviewability.js";
export * from "./predict-gate.js";
export * from "./preflight-pr.js";
export * from "./local-status.js";
export * from "./admin-config.js";
export * from "./maintainer.js";
export * from "./review.js";
export * from "./branch.js";
export * from "./discovery-utility.js";
export * from "./agent.js";
export * from "./local-branch.js";
export * from "./miner.js";
export * from "./ops.js";
export * from "./fleet.js";
export * from "./tenant.js";
export * from "./instance-ops.js";
export * from "./miner-ops.js";
export * from "./ams-tenant.js";
