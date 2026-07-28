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
export * from "./maintainer.js";
export * from "./review.js";
export * from "./branch.js";
export * from "./discovery-utility.js";
export * from "./agent.js";
export * from "./local-branch.js";
export * from "./miner.js";
