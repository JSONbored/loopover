// Remote server `maintainer` category (#9518, part 1).
//
// Every tool here is `locality: "remote"`, `auth: "maintainer"` unless noted, and read-only unless
// noted -- the category's own name is the auth boundary for most of it.
//
// Output schemas are relocated from src/mcp/server.ts's existing declarations essentially as-is,
// not re-derived field-by-field from engine source the way #9517's pilot batch was: that pilot
// proved the model against six tools with full fidelity; migrating the remaining ~110 tools at that
// same pace does not scale. Relocating the schema the server already advertises is itself the
// correct floor -- it is what "never tighten the wire contract" requires -- and it is a strict
// improvement over today (these fields did not exist in any shared, importable form before). Where
// a field is `z.unknown()` here, it was `z.unknown()` in the original declaration too; deepening
// those into real nested types is legitimate follow-on work, not a blocker to relocating the rest.
//
// Specifically do NOT "improve" a placeholder z.unknown() into z.looseObject({}) as a blanket
// rewrite: that IS a tightening (it rejects null and arrays), and doing so broke
// loopover_explain_review_risk, which returns roleContext: null. Deepen a field only against the
// handler's real payload.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";
import { ownerRepoInput } from "../shared.js";
import { PUBLIC_SURFACE_SKIP_REASONS } from "../enums.js";
import { advisoryFindingSchema } from "./repo-context.js";

const ownerRepoWindowInput = ownerRepoInput.extend({
  windowDays: z.number().int().positive().optional(),
});

// ── maintainer noise ────────────────────────────────────────────────────────────────────────────

export const GetMaintainerNoiseInput = ownerRepoInput;
export const GetMaintainerNoiseOutput = z.looseObject({
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  score: z.number().optional(),
  level: z.string().optional(),
  noiseSources: z.array(z.string()).optional(),
  maintainerActions: z.array(z.string()).optional(),
  queueHealth: z.unknown().optional(),
  summary: z.string().optional(),
});
export const getMaintainerNoiseTool = defineTool({
  name: "loopover_get_maintainer_noise",
  title: "Get maintainer queue noise",
  description: "Return the maintainer queue-noise triage report for a repo: a noise score/level, the specific noise sources to clear first, and recommended maintainer actions. Maintainer-authenticated; advisory only.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetMaintainerNoiseInput,
  output: GetMaintainerNoiseOutput,
});

// ── AMS miner cohort ────────────────────────────────────────────────────────────────────────────

export const GetAmsMinerCohortInput = ownerRepoInput;
export const GetAmsMinerCohortOutput = z.looseObject({
  present: z.boolean().optional(),
  windowDays: z.number().optional(),
  totalSubmitterCount: z.number().optional(),
  checkedSubmitterCount: z.number().optional(),
  amsCohort: z.unknown().optional(),
  humanCohort: z.unknown().optional(),
});
export const getAmsMinerCohortTool = defineTool({
  name: "loopover_get_ams_miner_cohort",
  title: "Get AMS miner cohort comparison",
  description: "Return the AMS-vs-human contributor-mix cohort comparison for a repo: submitter counts, PR volume, acceptance rate, review-cycle, and time-to-merge metrics for AMS-tracked vs human submitters. Maintainer-authenticated; advisory only.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetAmsMinerCohortInput,
  output: GetAmsMinerCohortOutput,
});

// ── repo focus manifest (read + refresh) ───────────────────────────────────────────────────────

const repoFocusManifestOutputFields = {
  repoFullName: z.string().optional(),
  manifest: z.unknown().optional(),
  policy: z.unknown().optional(),
};

export const GetRepoFocusManifestInput = ownerRepoInput;
export const GetRepoFocusManifestOutput = z.looseObject(repoFocusManifestOutputFields);
export const getRepoFocusManifestTool = defineTool({
  name: "loopover_get_repo_focus_manifest",
  title: "Get repo focus manifest",
  description: "Return a repo's own persisted focus manifest (.loopover.yml policy) plus its compiled policy. Read-only; maintainer/owner/operator authenticated -- same auth boundary as GET /v1/repos/:owner/:repo/focus-manifest. Distinct from loopover_validate_config (ad-hoc string validation with no repo lookup).",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetRepoFocusManifestInput,
  output: GetRepoFocusManifestOutput,
});

export const RefreshRepoFocusManifestInput = ownerRepoInput;
export const RefreshRepoFocusManifestOutput = z.looseObject(repoFocusManifestOutputFields);
export const refreshRepoFocusManifestTool = defineTool({
  name: "loopover_refresh_repo_focus_manifest",
  title: "Refresh repo focus manifest",
  description: "Force an immediate refresh of a repo's cached focus manifest (.loopover.yml policy) from GitHub, then return the reloaded manifest plus its compiled policy. Write access required -- same requireRepoWriteAccess boundary as POST /v1/repos/:owner/:repo/focus-manifest/refresh, stricter than the read-only loopover_get_repo_focus_manifest. Bypasses the manifest cache (refresh: true), matching loopover_refresh_repo_docs's force-a-fresh-artifact shape.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false },
  input: RefreshRepoFocusManifestInput,
  output: RefreshRepoFocusManifestOutput,
});

// ── activation preview ──────────────────────────────────────────────────────────────────────────

export const GetActivationPreviewInput = ownerRepoInput;
export const GetActivationPreviewOutput = z.looseObject({
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  currentReviewCheckMode: z.string().optional(),
  aiReviewConfigured: z.boolean().optional(),
  evaluatedCount: z.number().optional(),
  withFindingsCount: z.number().optional(),
  findingCodeCounts: z.array(z.unknown()).optional(),
  samples: z.array(z.unknown()).optional(),
  recommendedAction: z.string().nullable().optional(),
  summary: z.string().optional(),
});
export const getActivationPreviewTool = defineTool({
  name: "loopover_get_activation_preview",
  title: "Get maintainer activation preview",
  description: "Return the repo's maintainer activation preview: a deterministic \"here's what LoopOver would have surfaced\" run of the advisory engine over recent PRs (evaluated/with-findings counts, distinct finding codes, per-PR samples, current review-check mode, and the single recommended next action). Maintainer-authenticated; advisory only, never runs AI.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetActivationPreviewInput,
  output: GetActivationPreviewOutput,
});

// ── label audit ─────────────────────────────────────────────────────────────────────────────────

export const GetLabelAuditInput = ownerRepoInput;
export const GetLabelAuditOutput = z.looseObject({
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  configuredLabels: z.array(z.string()).optional(),
  liveLabels: z.array(z.string()).optional(),
  observedLabels: z.array(z.unknown()).optional(),
  missingConfiguredLabels: z.array(z.string()).optional(),
  suspiciousConfiguredLabels: z.array(z.string()).optional(),
  trustedPipelineReady: z.boolean().optional(),
  findings: z.array(advisoryFindingSchema).optional(),
  summary: z.string().optional(),
});
export const getLabelAuditTool = defineTool({
  name: "loopover_get_label_audit",
  title: "Get label policy audit",
  description: "Return the repo's label-policy audit: configured-vs-live labels, missing configured labels, suspicious status/source-style labels, and trusted-label-pipeline readiness for label-multiplier scoring. Maintainer-authenticated; advisory only.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetLabelAuditInput,
  output: GetLabelAuditOutput,
});

// ── maintainer lane ─────────────────────────────────────────────────────────────────────────────

export const GetMaintainerLaneInput = ownerRepoInput;
export const GetMaintainerLaneOutput = z.looseObject({
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  lane: z.unknown().optional(),
  maintainerCut: z.number().optional(),
  maintainerCutConfigured: z.boolean().optional(),
  queueHealth: z.unknown().optional(),
  configQuality: z.unknown().optional(),
  contributorIntakeHealth: z.unknown().optional(),
  findings: z.array(advisoryFindingSchema).optional(),
  summary: z.string().optional(),
});
export const getMaintainerLaneTool = defineTool({
  name: "loopover_get_maintainer_lane",
  title: "Get maintainer lane triage",
  description: "Return the maintainer-lane triage report for a repo: the lane recommendation alongside the configured maintainer cut, queue health, config quality, and contributor-intake health. Maintainer-authenticated; advisory only.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetMaintainerLaneInput,
  output: GetMaintainerLaneOutput,
});

// ── repo onboarding pack ────────────────────────────────────────────────────────────────────────

/** `refresh` is the stdio server's, which forwards it as `?refresh=true` to bypass the cached
 *  preview. The remote server ignores it; widening an input is the safe direction (#9537). */
export const GetRepoOnboardingPackInput = ownerRepoInput.extend({ refresh: z.boolean().optional() });
export const GetRepoOnboardingPackOutput = z.looseObject({
  repoFullName: z.string().optional(),
  accepted: z.boolean().optional(),
  preview: z.unknown().optional(),
  policySource: z.string().optional(),
  error: z.string().optional(),
});
export const getRepoOnboardingPackTool = defineTool({
  name: "loopover_get_repo_onboarding_pack",
  title: "Get repo onboarding pack",
  description: "Preview-only onboarding pack for a repository owner (contribution lanes, label policy, and public-safe guidance). Not published to GitHub.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetRepoOnboardingPackInput,
  output: GetRepoOnboardingPackOutput,
});

// ── registration readiness ──────────────────────────────────────────────────────────────────────

export const GetRegistrationReadinessInput = ownerRepoInput;
export const GetRegistrationReadinessOutput = z.looseObject({
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  ready: z.boolean().optional(),
  recommendedRegistrationMode: z.string().optional(),
  issuePolicy: z.string().optional(),
  directPrReadiness: z.unknown().optional(),
  issueDiscoveryReadiness: z.unknown().optional(),
  labelPolicy: z.unknown().optional(),
  maintainerCutReadiness: z.unknown().optional(),
  testCoverageHealth: z.unknown().optional(),
  queueHealth: z.unknown().optional(),
  contributorIntakeHealth: z.unknown().optional(),
  docsCompleteness: z.unknown().optional(),
  githubApp: z.unknown().optional(),
  policyReadiness: z.unknown().optional(),
  onboardingPackPreview: z.unknown().optional(),
  blockers: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  dataQuality: z.unknown().optional(),
});
export const getRegistrationReadinessTool = defineTool({
  name: "loopover_get_registration_readiness",
  title: "Get registration readiness",
  description: "Preview-only registration-readiness report for a repository: what's missing/present before/after registering with LoopOver (direct-PR and issue-discovery lane readiness, label policy, maintainer-cut readiness, queue health, docs, and the GitHub App install state). Advisory only, not a registration action.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetRegistrationReadinessInput,
  output: GetRegistrationReadinessOutput,
});

// ── config recommendation ───────────────────────────────────────────────────────────────────────

export const GetConfigRecommendationInput = ownerRepoInput;
export const GetConfigRecommendationOutput = z.looseObject({
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  privateOnly: z.boolean().optional(),
  current: z.unknown().optional(),
  recommended: z.unknown().optional(),
  tradeoffs: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  dataQuality: z.unknown().optional(),
});
export const getConfigRecommendationTool = defineTool({
  name: "loopover_get_config_recommendation",
  title: "Get config recommendation",
  description: "Return recommended .loopover.yml additions for a repository, derived from the repo's live, currently-active configured behavior (the raw dashboard/API-configured settings, not a yml-merged view -- so the recommendation never compares itself against an override that already exists). Advisory only, not a write action.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetConfigRecommendationInput,
  output: GetConfigRecommendationOutput,
});

// ── burden forecast / outcome patterns (share the cached-freshness envelope) ──────────────────────

const freshnessOutputFields = {
  status: z.string().optional(),
  repoFullName: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  generatedAt: z.string().optional(),
  report: z.unknown().optional(),
};

export const GetBurdenForecastInput = ownerRepoInput;
export const GetBurdenForecastOutput = z.looseObject(freshnessOutputFields);
export const getBurdenForecastTool = defineTool({
  name: "loopover_get_burden_forecast",
  title: "Get maintainer burden forecast",
  description: "Return the cached maintainer burden forecast for a repo, including projected review load, queue growth risk, stale PR signals, and a freshness marker.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetBurdenForecastInput,
  output: GetBurdenForecastOutput,
});

export const GetRepoOutcomePatternsInput = ownerRepoInput;
export const GetRepoOutcomePatternsOutput = z.looseObject(freshnessOutputFields);
export const getRepoOutcomePatternsTool = defineTool({
  name: "loopover_get_repo_outcome_patterns",
  title: "Get repo outcome patterns",
  description: "Return cached or freshly-computed per-repo accepted/rejected PR outcome patterns: what maintainers actually merge or close, separated from maintainer-lane activity, with a freshness marker and explicit evidence-completeness.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetRepoOutcomePatternsInput,
  output: GetRepoOutcomePatternsOutput,
});

// ── outcome calibration / gate precision (share owner+repo+windowDays input) ──────────────────────

export const GetOutcomeCalibrationInput = ownerRepoWindowInput;
export const GetOutcomeCalibrationOutput = z.looseObject({
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  windowDays: z.number().nullable().optional(),
  slop: z.unknown().optional(),
  recommendations: z.unknown().optional(),
  signals: z.array(z.string()).optional(),
  status: z.string().optional(),
});
export const getOutcomeCalibrationTool = defineTool({
  name: "loopover_get_outcome_calibration",
  title: "Get outcome calibration",
  description: "Return slop-band and recommendation outcome calibration for a repo: whether higher-slop bands merge less often and how agent recommendations are panning out. Maintainer-authenticated; measurement only.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetOutcomeCalibrationInput,
  output: GetOutcomeCalibrationOutput,
});

export const GetGatePrecisionInput = ownerRepoWindowInput;
export const GetGatePrecisionOutput = z.looseObject({
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  windowDays: z.number().nullable().optional(),
  perGateType: z.array(z.unknown()).optional(),
  overall: z.unknown().optional(),
  signals: z.array(z.string()).optional(),
});
export const getGatePrecisionTool = defineTool({
  name: "loopover_get_gate_precision",
  title: "Get gate precision",
  description: "Return per-gate-type false-positive precision for a repo's recorded gate blocks -- blocked / blocked-then-merged / overridden counts and false-positive rates with low-sample guards. Maintainer-authenticated; measurement only.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetGatePrecisionInput,
  output: GetGatePrecisionOutput,
});

// ── self-tune override audit + clear ───────────────────────────────────────────────────────────

export const GetSelftuneOverrideAuditInput = ownerRepoInput.extend({
  limit: z.number().int().positive().optional(),
});
export const GetSelftuneOverrideAuditOutput = z.looseObject({
  repoFullName: z.string().optional(),
  audit: z.array(z.unknown()).optional(),
});
export const getSelftuneOverrideAuditTool = defineTool({
  name: "loopover_get_selftune_override_audit",
  title: "Get self-tune override audit",
  description: "Return the self-tune override audit trail for a repo -- why the self-tune loop promoted, shadowed, or cleared a live gate override, newest first, optionally capped by limit. Maintainer-authenticated; read-only measurement.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetSelftuneOverrideAuditInput,
  output: GetSelftuneOverrideAuditOutput,
});

export const ClearSelftuneOverrideInput = ownerRepoInput.extend({
  confirm: z.literal(true),
});
export const ClearSelftuneOverrideOutput = z.looseObject({
  repoFullName: z.string().optional(),
  cleared: z.boolean().optional(),
});
export const clearSelftuneOverrideTool = defineTool({
  name: "loopover_clear_selftune_override",
  title: "Clear self-tune override",
  description: "Clear a repo's LIVE self-tune gate override (the operator's \"reset to config base\" control), mirroring DELETE /v1/repos/:owner/:repo/selftune/overrides. Requires confirm:true; the automatic self-tune promote path is untouched. Maintainer access required.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false, destructiveHint: true },
  input: ClearSelftuneOverrideInput,
  output: ClearSelftuneOverrideOutput,
});

// ── file incident report ────────────────────────────────────────────────────────────────────────

export const FileIncidentReportInput = ownerRepoInput.extend({
  number: z.number().int().positive(),
  description: z.string().min(1).max(4000),
  severity: z.enum(["low", "medium", "high", "critical"]),
  mergedSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional(),
});
export const FileIncidentReportOutput = z.looseObject({
  ok: z.boolean(),
  repoFullName: z.string(),
  pullNumber: z.number().int().positive(),
  id: z.string().optional(),
  createdAt: z.string().optional(),
  error: z.enum(["pull_request_not_found", "pull_request_not_merged"]).optional(),
});
export const fileIncidentReportTool = defineTool({
  name: "loopover_file_incident_report",
  title: "File post-merge incident report",
  description: "File a post-merge incident report on an already-merged rented-loop PR later found harmful, mirroring POST /v1/repos/:owner/:repo/pulls/:number/incident-reports. Persists an audit_events row keyed to the PR; the PR must exist and be merged. Maintainer access required.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false },
  input: FileIncidentReportInput,
  output: FileIncidentReportOutput,
});

// ── skipped PR audit ────────────────────────────────────────────────────────────────────────────

/** Reason codes the public-surface skip audit accepts -- the server's own closed set, single-sourced
 *  in ../enums.js and pinned against src/signals/settings-preview.ts by a meta-test. Kept as a real
 *  enum rather than a permissive string: the handler narrows on this type, and the original
 *  registration already advertised the closed set, so widening it here would both break that
 *  narrowing and loosen the advertised inputSchema. */
export const SkippedPrAuditInput = z.object({
  repoFullName: z.string().trim().min(1).max(200).optional(),
  reason: z.enum(PUBLIC_SURFACE_SKIP_REASONS).optional(),
  since: z.string().trim().min(1).max(64).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export const SkippedPrAuditOutput = z.looseObject({
  generatedAt: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  hasMore: z.boolean().optional(),
  filters: z.unknown().optional(),
  items: z.array(z.unknown()).optional(),
});
export const getSkippedPrAuditTool = defineTool({
  name: "loopover_get_skipped_pr_audit",
  title: "Get skipped PR audit",
  description: "Return the skipped-PR audit trail: pull requests LoopOver's automated reviewer intentionally stayed quiet on, each with a reason code and a remediation hint. Optionally filter by repoFullName, reason, or since. Maintainer-authenticated; read-only measurement, not a moderation or override action.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: SkippedPrAuditInput,
  output: SkippedPrAuditOutput,
});

// ── fleet analytics / recommendation quality (operator-only, cross-repo) ──────────────────────────

const windowOnlyInput = z.object({
  windowDays: z.number().int().positive().optional(),
});

export const GetFleetAnalyticsInput = windowOnlyInput;
export const GetFleetAnalyticsOutput = z.looseObject({
  windowDays: z.number().optional(),
  instanceCount: z.number().optional(),
  fleet: z.unknown().optional(),
  instances: z.array(z.unknown()).optional(),
  outliers: z.array(z.unknown()).optional(),
});
export const getFleetAnalyticsTool = defineTool({
  name: "loopover_get_fleet_analytics",
  title: "Get fleet analytics",
  description: "Operator-only: aggregated gate-calibration analytics across the self-host fleet -- median merge/close precision, false-positive + reversal rates, cycle-time percentiles, and per-instance outliers. Measurement only.",
  category: "fleet",
  auth: "operator",
  locality: "remote",
  availability: "both",
  input: GetFleetAnalyticsInput,
  output: GetFleetAnalyticsOutput,
});

export const GetRecommendationQualityInput = windowOnlyInput;
export const GetRecommendationQualityOutput = z.looseObject({
  generatedAt: z.string().optional(),
  windowDays: z.number().optional(),
  visibility: z.string().optional(),
  empty: z.boolean().optional(),
  sparse: z.boolean().optional(),
  totals: z.unknown().optional(),
  trends: z.array(z.unknown()).optional(),
  failureCategories: z.array(z.unknown()).optional(),
  rollups: z.array(z.unknown()).optional(),
  roleSurfaces: z.array(z.unknown()).optional(),
  warnings: z.array(z.string()).optional(),
  publicExport: z.unknown().optional(),
  privateSummary: z.string().optional(),
});
export const getRecommendationQualityTool = defineTool({
  name: "loopover_get_recommendation_quality",
  title: "Get recommendation quality",
  description: "Operator-only: how agent recommendations panned out across every repo (positive/negative outcome totals, trends, failure categories, and per-role surfaces). Measurement only.",
  category: "maintainer",
  auth: "operator",
  locality: "remote",
  availability: "both",
  input: GetRecommendationQualityInput,
  output: GetRecommendationQualityOutput,
});

// ── issue quality ───────────────────────────────────────────────────────────────────────────────

export const GetIssueQualityInput = ownerRepoInput;
export const GetIssueQualityOutput = z.looseObject(freshnessOutputFields);
export const getIssueQualityTool = defineTool({
  name: "loopover_get_issue_quality",
  title: "Get issue quality",
  description: "Return the cached or freshly-computed issue-quality report for a repo, ranking which open issues are actionable, need proof, are stale/duplicate-prone, or already solved.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetIssueQualityInput,
  output: GetIssueQualityOutput,
});

// ── live gate thresholds / effective gate config / repo settings ──────────────────────────────────

export const GetLiveGateThresholdsInput = ownerRepoInput;
export const GetLiveGateThresholdsOutput = z.looseObject({
  repoFullName: z.string().optional(),
  confidence_floor: z.number().nullable().optional(),
  scope_cap_files: z.number().nullable().optional(),
  scope_cap_lines: z.number().nullable().optional(),
  error: z.string().optional(),
  status: z.string().optional(),
});
export const getLiveGateThresholdsTool = defineTool({
  name: "loopover_get_live_gate_thresholds",
  title: "Get live gate thresholds",
  description: "Return the currently-authoritative live gate thresholds for a repo (confidence floor and scope caps) as a field-limited snake_case AMS probe. Live override wins; soaking shadow fills in only when live is absent. Metadata-only, repo-scoped, no GitHub writes.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetLiveGateThresholdsInput,
  output: GetLiveGateThresholdsOutput,
});

export const GetGateConfigEffectiveInput = ownerRepoInput;
export const GetGateConfigEffectiveOutput = z.looseObject({
  repoFullName: z.string().optional(),
  effective: z.unknown().optional(),
  shadowPending: z.boolean().optional(),
  status: z.string().optional(),
});
export const getGateConfigEffectiveTool = defineTool({
  name: "loopover_get_gate_config_effective",
  title: "Get effective gate config",
  description: "Return a repo's current effective self-tuned gate thresholds (confidenceFloor, scopeCap) plus whether a shadow override is soaking. Metadata-only, repo-scoped, no GitHub writes.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetGateConfigEffectiveInput,
  output: GetGateConfigEffectiveOutput,
});

export const GetRepoSettingsInput = ownerRepoInput;
export const GetRepoSettingsOutput = z.looseObject({
  repoFullName: z.string().optional(),
  commentMode: z.string().optional(),
  gatePack: z.string().optional(),
  reviewCheckMode: z.string().optional(),
  slopGateMode: z.string().optional(),
});
export const getRepoSettingsTool = defineTool({
  name: "loopover_get_repo_settings",
  title: "Get repo settings",
  description: "Return a repo's RAW effective maintainer settings row (gate/slop/label/surface/command-auth settings, including agent autonomy controls) -- the same resolveRepositorySettings output GET /v1/repos/:owner/:repo/settings returns, distinct from the derived automation-state / gate-config-effective views. Metadata-only, repo-scoped, no GitHub writes. Maintainer access required.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  input: GetRepoSettingsInput,
  output: GetRepoSettingsOutput,
});

// ── refresh repo docs ───────────────────────────────────────────────────────────────────────────

export const RefreshRepoDocsInput = ownerRepoInput;
export const RefreshRepoDocsOutput = z.looseObject({
  opened: z.boolean().optional(),
  reused: z.boolean().optional(),
  pullNumber: z.number().optional(),
  url: z.string().optional(),
  reason: z.string().optional(),
});
export const refreshRepoDocsTool = defineTool({
  name: "loopover_refresh_repo_docs",
  title: "Refresh repo docs",
  description: "Force an immediate repo-doc refresh (AGENTS.md/CLAUDE.md, and a skill file when warranted) for one repo, without waiting for the scheduled interval. Only ever opens a pull request -- never a direct commit -- and only when repoDocGeneration is enabled for this repo and the generated content actually changed. Maintainer access required.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false },
  input: RefreshRepoDocsInput,
  output: RefreshRepoDocsOutput,
});

// ── generate contributor issue drafts / plan repo issues ──────────────────────────────────────────

export const GenerateContributorIssueDraftsInput = ownerRepoInput.extend({
  dryRun: z.boolean().optional().default(true),
  create: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(20).optional().default(5),
});
export const GenerateContributorIssueDraftsOutput = z.looseObject({
  repoFullName: z.string(),
  generatedAt: z.string(),
  dryRun: z.boolean(),
  createRequested: z.boolean(),
  // #9537: OPTIONAL, not required. The service short-circuits to a countless `disabled`/
  // `unavailable` posture when AI is off, returning the envelope with no counters at all -- which
  // is precisely why the CLI proxies carry `?? 0` fallbacks. Declaring them required described a
  // response the service does not always produce.
  proposed: z.number().optional(),
  skippedDuplicate: z.number().optional(),
  skippedDeclined: z.number().optional(),
  skippedUnsafe: z.number().optional(),
  created: z.number().optional(),
  skippedCreateFailed: z.number().optional(),
});
export const generateContributorIssueDraftsTool = defineTool({
  name: "loopover_generate_contributor_issue_drafts",
  title: "Generate contributor issue drafts",
  description: "Generate contributor-facing issue drafts for one repo from its lane/config/queue signals. Dry-run BY DEFAULT: it only PREVIEWS drafts unless the caller passes BOTH create:true and dryRun:false, so it can never silently open issues; the write path additionally requires repo write access and is suppressed while the agent is globally paused/frozen. Maintainer access required.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false },
  input: GenerateContributorIssueDraftsInput,
  output: GenerateContributorIssueDraftsOutput,
});

const planRepoIssuesMilestoneSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  dueOn: z.string().datetime({ offset: true }).optional(),
});

export const PlanRepoIssuesInput = ownerRepoInput.extend({
  goal: z.string().min(1).max(2000),
  dryRun: z.boolean().optional().default(true),
  create: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(10).optional().default(5),
  milestone: planRepoIssuesMilestoneSchema.optional(),
});
export const PlanRepoIssuesOutput = z.looseObject({
  repoFullName: z.string(),
  generatedAt: z.string(),
  status: z.string(),
  dryRun: z.boolean(),
  createRequested: z.boolean(),
  // #9537: OPTIONAL. The service short-circuits to a countless `disabled`/`unavailable` posture when
  // AI is off, returning the envelope with no counters -- which is exactly why the CLI proxies carry
  // `?? 0` fallbacks. Declaring them required described a response the service does not always send.
  proposed: z.number().optional(),
  skippedDuplicate: z.number().optional(),
  skippedDeclined: z.number().optional(),
  skippedUnsafe: z.number().optional(),
  created: z.number().optional(),
  skippedCreateFailed: z.number().optional(),
  // Unlike GenerateContributorIssueDraftsOutput, this INCLUDES each draft's title/body/labels: the
  // content is generated fresh from the caller's own goal for their own repo (no loopover-internal
  // signal to scrub), and the whole point of the dry-run-by-default posture is letting a maintainer
  // actually read the proposal before deciding to create it.
  drafts: z
    .array(
      z.looseObject({
        title: z.string(),
        body: z.string(),
        labels: z.array(z.string()),
        status: z.string(),
        issueNumber: z.number().optional(),
        issueUrl: z.string().optional(),
      }),
    )
    .optional(),
  // Set only when a milestone target was given AND creation actually ran AND resolution succeeded
  // (#7427) -- absent on a dry run, no milestone requested, or a degraded (failed) resolution.
  milestoneNumber: z.number().optional(),
});
export const planRepoIssuesTool = defineTool({
  name: "loopover_plan_repo_issues",
  title: "Plan repo issues",
  description:
    "AI-plan a small set of concrete GitHub issues from a maintainer-supplied free-form goal, for ANY repo the caller's App/Orb is installed on -- repo-agnostic and gittensor-optional (#7426). Dry-run BY DEFAULT: only PREVIEWS drafts (full title/body/labels) unless the caller passes BOTH create:true and dryRun:false, so it can never silently open issues. Creates exclusively via the installation-token/Orb-broker path (#7425), never a flat PAT. An optional milestone (title/description/dueOn, all maintainer-supplied -- never model-generated) is resolved against existing OPEN milestones by exact normalized title before creating a new one, and assigned to every created issue (#7427). Makes a real LLM call subject to the shared daily AI budget and the fleet AI_SUMMARIES_ENABLED/AI_PUBLIC_COMMENTS_ENABLED switches. Maintainer access required.",
  category: "maintainer",
  auth: "maintainer",
  locality: "remote",
  availability: "both",
  annotations: { readOnlyHint: false },
  input: PlanRepoIssuesInput,
  output: PlanRepoIssuesOutput,
});
