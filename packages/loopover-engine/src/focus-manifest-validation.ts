import {
  contentLaneConfigToJson,
  featuresConfigToJson,
  gateConfigToJson,
  parseFocusManifestContent,
  repoDocGenerationConfigToJson,
  reviewConfigToJson,
  reviewRecapConfigToJson,
  maintainerRecapConfigToJson,
  opsConfigToJson,
  publicStatsConfigToJson,
  draftFlowConfigToJson,
  upstreamDriftIssuesConfigToJson,
  sweepWatchdogConfigToJson,
  prReconciliationConfigToJson,
  activeReviewReconciliationConfigToJson,
  loopEscalationConfigToJson,
  federatedIntelligenceConfigToJson,
  settingsOverrideToJson,
  type FocusManifest,
  type FocusManifestSource,
} from "./focus-manifest.js";
import { unknownTopLevelWarnings } from "./config-lint.js";

export type FocusManifestValidationStatus = "ok" | "warn" | "error";

export type FocusManifestValidationResult = {
  present: boolean;
  warnings: string[];
  normalized: Record<string, unknown>;
  status: FocusManifestValidationStatus;
};

const PARSE_FAILURE_PATTERN = /not valid (JSON|YAML)|must be a mapping|exceeded \d+ bytes/i;

export function buildFocusManifestValidation(input: {
  content: string;
  source?: FocusManifestSource | undefined;
}): FocusManifestValidationResult {
  const manifest = parseFocusManifestContent(input.content, input.source ?? "repo_file");
  // Warn on unrecognized top-level fields (e.g. a typo'd `gates:` instead of `gate:`), matching the
  // selfhost config-lint validator — parseFocusManifestContent reads only known fields, so a mistyped
  // block is otherwise silently dropped with no warning (#5929).
  const warnings = [...manifest.warnings, ...unknownTopLevelWarnings(input.content)];
  const normalized = focusManifestToNormalizedJson(manifest);
  return {
    present: manifest.present,
    warnings,
    normalized,
    status: resolveValidationStatus(manifest, warnings),
  };
}

function resolveValidationStatus(manifest: FocusManifest, warnings: string[]): FocusManifestValidationStatus {
  if (warnings.some((warning) => PARSE_FAILURE_PATTERN.test(warning))) return "error";
  if (!manifest.present || warnings.length > 0) return "warn";
  return "ok";
}

function focusManifestToNormalizedJson(manifest: FocusManifest): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    present: manifest.present,
    source: manifest.source,
  };
  if (manifest.wantedPaths.length > 0) normalized.wantedPaths = manifest.wantedPaths;
  if (manifest.preferredLabels.length > 0) normalized.preferredLabels = manifest.preferredLabels;
  if (manifest.linkedIssuePolicy !== "optional") normalized.linkedIssuePolicy = manifest.linkedIssuePolicy;
  if (manifest.testExpectations.length > 0) normalized.testExpectations = manifest.testExpectations;
  if (manifest.issueDiscoveryPolicy !== "neutral") normalized.issueDiscoveryPolicy = manifest.issueDiscoveryPolicy;
  if (manifest.publicNotes.length > 0) normalized.publicNotes = manifest.publicNotes;

  const gate = gateConfigToJson(manifest.gate);
  if (gate !== null) normalized.gate = gate;
  const settings = settingsOverrideToJson(manifest.settings);
  if (settings !== null) normalized.settings = settings;
  const review = reviewConfigToJson(manifest.review);
  if (review !== null) normalized.review = review;
  const features = featuresConfigToJson(manifest.features);
  if (features !== null) normalized.features = features;
  const contentLane = contentLaneConfigToJson(manifest.contentLane);
  if (contentLane !== null) normalized.contentLane = contentLane;
  const repoDocGeneration = repoDocGenerationConfigToJson(manifest.repoDocGeneration);
  if (repoDocGeneration !== null) normalized.repoDocGeneration = repoDocGeneration;
  const reviewRecap = reviewRecapConfigToJson(manifest.reviewRecap);
  if (reviewRecap !== null) normalized.reviewRecap = reviewRecap;
  const maintainerRecap = maintainerRecapConfigToJson(manifest.maintainerRecap);
  if (maintainerRecap !== null) normalized.maintainerRecap = maintainerRecap;
  const ops = opsConfigToJson(manifest.ops);
  if (ops !== null) normalized.ops = ops;
  const publicStats = publicStatsConfigToJson(manifest.publicStats);
  if (publicStats !== null) normalized.publicStats = publicStats;
  const draftFlow = draftFlowConfigToJson(manifest.draftFlow);
  if (draftFlow !== null) normalized.draftFlow = draftFlow;
  const upstreamDriftIssues = upstreamDriftIssuesConfigToJson(manifest.upstreamDriftIssues);
  if (upstreamDriftIssues !== null) normalized.upstreamDriftIssues = upstreamDriftIssues;
  const sweepWatchdog = sweepWatchdogConfigToJson(manifest.sweepWatchdog);
  if (sweepWatchdog !== null) normalized.sweepWatchdog = sweepWatchdog;
  const prReconciliation = prReconciliationConfigToJson(manifest.prReconciliation);
  if (prReconciliation !== null) normalized.prReconciliation = prReconciliation;
  const activeReviewReconciliation = activeReviewReconciliationConfigToJson(manifest.activeReviewReconciliation);
  if (activeReviewReconciliation !== null) normalized.activeReviewReconciliation = activeReviewReconciliation;
  const loopEscalation = loopEscalationConfigToJson(manifest.loopEscalation);
  if (loopEscalation !== null) normalized.loopEscalation = loopEscalation;
  const federatedIntelligence = federatedIntelligenceConfigToJson(manifest.federatedIntelligence);
  if (federatedIntelligence !== null) normalized.federatedIntelligence = federatedIntelligence;

  return normalized;
}
