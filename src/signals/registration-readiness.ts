import type { RegistryRepoConfig, RepositoryRecord, RepositorySettings } from "../types";
import { shouldPublishReviewCheck } from "../review/check-names";
import { nowIso } from "../utils/json";
import type { ConfigQuality, ContributorIntakeHealth, LabelAudit, LaneAdvice, MaintainerCutReadiness, QueueHealth } from "./engine";
import { compileFocusManifestPolicy, type FocusManifest } from "./focus-manifest";
import { buildRepoOnboardingPackPreview, focusManifestPolicyToCompilerOutput, type RepoOnboardingPackPreview } from "./onboarding-pack";
import {
  buildRepoPolicyReadiness,
  policyReadinessWarningText,
  resolveIssuePolicy,
  type IssuePolicy,
  type RepoPolicyReadinessReport,
} from "./repo-policy-readiness";

export type RegistrationMode = "direct_pr" | "issue_discovery" | "split";
export type { IssuePolicy };

export type InstallationHealthSummary = {
  status: "healthy" | "needs_attention" | "broken";
  missingPermissions: string[];
  missingEvents: string[];
};

export type LaneReadiness = {
  ready: boolean;
  recommendation: "enabled" | "recommended" | "not_recommended";
  reasons: string[];
};

export type TestCoverageHealth = {
  status: "gate_ready" | "gate_unknown";
  trustedLabelPipelineReady: boolean;
  checkRunMode: RepositorySettings["checkRunMode"];
  requiredGate: string[];
  note: string;
  warnings: string[];
};

export type GithubAppBehavior = {
  installed: boolean;
  publicSurface: RepositorySettings["publicSurface"];
  commentMode: RepositorySettings["commentMode"];
  publicAudienceMode: RepositorySettings["publicAudienceMode"];
  checkRunMode: RepositorySettings["checkRunMode"];
  reviewCheckMode: RepositorySettings["reviewCheckMode"];
  quietByDefault: boolean;
  behavior: string;
  warnings: string[];
};

export type RegistrationReadinessReport = {
  repoFullName: string;
  generatedAt: string;
  ready: boolean;
  recommendedRegistrationMode: RegistrationMode;
  issuePolicy: IssuePolicy;
  directPrReadiness: { ready: boolean; reasons: string[] };
  issueDiscoveryReadiness: LaneReadiness;
  labelPolicy: {
    autoLabelEnabled: boolean;
    label: string;
    createMissingLabel: boolean;
    configuredRegistryLabels: string[];
    missingOrUnusedRegistryLabels: string[];
    trustedPipelineReady: boolean;
  };
  maintainerCutReadiness: MaintainerCutReadiness;
  testCoverageHealth: TestCoverageHealth;
  queueHealth: { level: QueueHealth["level"]; burdenScore: number; reviewablePullRequests: number; summary: string };
  contributorIntakeHealth: ContributorIntakeHealth;
  docsCompleteness: { status: string; requiredDocs: string[]; note: string };
  githubApp: GithubAppBehavior;
  policyReadiness: RepoPolicyReadinessReport | null;
  onboardingPackPreview: RepoOnboardingPackPreview | null;
  blockers: string[];
  warnings: string[];
};

export type RegistrationReadinessInput = {
  repoFullName: string;
  repo: RepositoryRecord | null;
  settings: RepositorySettings;
  lane: LaneAdvice;
  configQuality: ConfigQuality;
  labelAudit: LabelAudit;
  queueHealth: QueueHealth;
  maintainerCutReadiness: MaintainerCutReadiness;
  contributorIntakeHealth: ContributorIntakeHealth;
  installation: InstallationHealthSummary | null;
  upstreamRegistryDriftWarnings?: string[] | undefined;
  focusManifest?: FocusManifest | undefined;
};

const REQUIRED_DOCS = ["README", "CONTRIBUTING", "SECURITY", "SUPPORT"];
const COVERAGE_GATE = ["npm run test:ci", "patch (changed-lines) coverage >= 99%"];

function laneToMode(lane: LaneAdvice): RegistrationMode {
  return lane.lane === "issue_discovery" ? "issue_discovery" : lane.lane === "split" ? "split" : "direct_pr";
}

function buildTestCoverageHealth(labelAudit: LabelAudit, settings: RepositorySettings): TestCoverageHealth {
  const trustedLabelPipelineReady = labelAudit.trustedPipelineReady;
  const status: TestCoverageHealth["status"] = trustedLabelPipelineReady ? "gate_ready" : "gate_unknown";
  const warnings = trustedLabelPipelineReady ? [] : ["No trusted label pipeline is verified; trusted-label scoring should stay off until labels are validated."];
  return {
    status,
    trustedLabelPipelineReady,
    checkRunMode: settings.checkRunMode,
    requiredGate: COVERAGE_GATE,
    note: "LoopOver enforces its own coverage gate in CI; remote contributor repos must preserve an equivalent test gate before trusted-label or maintainer-cut promotion. Check runs intentionally default off; their state is informational here and is not a readiness warning.",
    warnings,
  };
}

function buildGithubAppBehavior(repo: RepositoryRecord | null, settings: RepositorySettings, installation: InstallationHealthSummary | null): GithubAppBehavior {
  const installed = Boolean(repo?.isInstalled);
  const quietByDefault = settings.publicSurface === "off" || settings.commentMode !== "all_prs";
  const warnings = [
    ...(installed ? [] : ["GitHub App is not installed on this repo; maintainers will not get any automated assistance."]),
    ...(settings.publicSurface === "off" ? ["GitHub App public surface is disabled; maintainers will not get comment/label assistance."] : []),
    ...(installation && settings.publicSurface !== "off" && installation.missingPermissions.length > 0
      ? [`GitHub App is missing permission(s) for the enabled public surface: ${installation.missingPermissions.join(", ")}.`]
      : []),
    ...(installation?.missingEvents.length ? [`GitHub App is not subscribed to webhook event(s): ${installation.missingEvents.join(", ")}.`] : []),
  ];
  return {
    installed,
    publicSurface: settings.publicSurface,
    commentMode: settings.commentMode,
    publicAudienceMode: settings.publicAudienceMode,
    checkRunMode: settings.checkRunMode,
    reviewCheckMode: settings.reviewCheckMode,
    quietByDefault,
    behavior: !installed
      ? "LoopOver would stay silent because the GitHub App is not installed."
      : settings.publicSurface === "off"
        ? `LoopOver stays quiet: no public comments or labels${shouldPublishReviewCheck(settings.reviewCheckMode) ? ", with the opt-in gate check still enabled" : ""}.`
        : `LoopOver posts ${settings.publicSurface.replace(/_/g, " ")} in ${settings.publicAudienceMode.replace(/_/g, " ")} mode, ${quietByDefault ? "quiet by default" : "for all PRs"}.`,
    warnings,
  };
}

/**
 * Pure registration-readiness report for a repo owner.
 * Advisory and private/API-first: no public GitHub output, no wallet/score exposure.
 */
export function buildRegistrationReadiness(input: RegistrationReadinessInput): RegistrationReadinessReport {
  const { repoFullName, repo, settings, lane, configQuality, labelAudit, queueHealth, maintainerCutReadiness, contributorIntakeHealth, installation, upstreamRegistryDriftWarnings = [] } = input;
  const isRegistered = Boolean(repo?.isRegistered);
  const configFragile = configQuality.level === "fragile";
  const configNeedsAttention = configQuality.level === "needs_attention";
  const intakeBlocked = contributorIntakeHealth.level === "blocked";

  const testCoverageHealth = buildTestCoverageHealth(labelAudit, settings);
  const githubApp = buildGithubAppBehavior(repo, settings, installation);
  const policyReadiness =
    input.focusManifest === undefined
      ? null
      : buildRepoPolicyReadiness({
          repoFullName,
          focusManifest: input.focusManifest,
          settings,
          lane,
          configQuality,
          labelAudit,
          queueHealth,
          contributorIntakeHealth,
        });

  const onboardingPackPreview =
    input.focusManifest === undefined
      ? null
      : buildRepoOnboardingPackPreview(
          focusManifestPolicyToCompilerOutput(compileFocusManifestPolicy(repoFullName, input.focusManifest)),
        );

  const blockers = [
    ...(!isRegistered ? ["Repository is not registered in the latest LoopOver registry snapshot."] : []),
    ...(configFragile ? ["Repository config quality is fragile."] : []),
    ...(configNeedsAttention ? ["Repository config quality needs attention before registration promotion."] : []),
    ...(intakeBlocked ? ["Contributor intake health is blocked."] : []),
  ];

  const directPrReady = isRegistered && !configFragile && !configNeedsAttention && !intakeBlocked;
  const directPrReadiness = {
    ready: directPrReady,
    reasons: [
      isRegistered ? "Repository is registered in the local LoopOver snapshot." : "Repository is not registered yet; direct-PR mining cannot be evaluated.",
      directPrReady ? "Config quality and contributor intake are healthy enough for direct-PR-first intake." : `Direct-PR intake is gated by config quality (${configQuality.level}) and intake health (${contributorIntakeHealth.level}).`,
    ],
  };

  const issueDiscoveryHealthy = contributorIntakeHealth.level === "healthy" && configQuality.level === "excellent";
  const issueDiscoveryReadiness: LaneReadiness = {
    ready: issueDiscoveryHealthy,
    recommendation: lane.lane === "issue_discovery" || lane.lane === "split" ? "enabled" : issueDiscoveryHealthy ? "recommended" : "not_recommended",
    reasons: [
      lane.lane === "issue_discovery" || lane.lane === "split" ? "Issue-discovery intake is already part of the current registry lane." : "Issue-discovery intake is not part of the current registry lane.",
      issueDiscoveryHealthy ? "Config quality is excellent and intake is healthy, so a small issue-discovery slice is defensible." : "Issue discovery should stay off until config quality is excellent and intake health is healthy.",
    ],
  };

  const warnings = [
    // configNeedsAttention is a blocker (not a warning), mirroring how configFragile is treated — the two
    // needs-attention tiers of the same configQuality.level stay consistent, and blockers fully explains
    // ready === false without double-flagging the same fact as a warning (#5946).
    ...(contributorIntakeHealth.level === "strained" ? ["Contributor intake is strained; expect more maintainer triage."] : []),
    ...(settings.publicSurface === "off" ? ["GitHub App public surface is disabled; maintainers will not get comment/label assistance."] : []),
    ...testCoverageHealth.warnings,
    ...labelAudit.missingConfiguredLabels.map((label) => `Configured registry label "${label}" is missing from live GitHub labels.`),
    ...(policyReadiness?.publicWarnings.map(policyReadinessWarningText) ?? []),
    ...upstreamRegistryDriftWarnings,
  ];

  // configFragile and configNeedsAttention are now both blockers, so blockers.length === 0 alone fully
  // determines readiness — blockers is the single source of truth for every ready === false reason (#5946).
  const ready = blockers.length === 0;

  return {
    repoFullName,
    generatedAt: nowIso(),
    ready,
    recommendedRegistrationMode: laneToMode(lane),
    issuePolicy: resolveIssuePolicy(lane, settings),
    directPrReadiness,
    issueDiscoveryReadiness,
    labelPolicy: {
      autoLabelEnabled: settings.autoLabelEnabled,
      label: settings.gittensorLabel,
      createMissingLabel: settings.createMissingLabel,
      configuredRegistryLabels: configQuality.configuredLabels,
      missingOrUnusedRegistryLabels: configQuality.notObservedConfiguredLabels,
      trustedPipelineReady: labelAudit.trustedPipelineReady,
    },
    maintainerCutReadiness,
    testCoverageHealth,
    queueHealth: {
      level: queueHealth.level,
      burdenScore: queueHealth.burdenScore,
      reviewablePullRequests: queueHealth.signals.likelyReviewablePullRequests,
      summary: queueHealth.summary,
    },
    contributorIntakeHealth,
    docsCompleteness: {
      status: "repo_docs_not_crawled",
      requiredDocs: REQUIRED_DOCS,
      note: "LoopOver validates public repo docs from the local project during CI; remote repo-doc crawling is not enabled in this signal yet.",
    },
    githubApp,
    policyReadiness,
    onboardingPackPreview,
    blockers,
    warnings,
  };
}

export type GittensorConfigRecommendation = {
  repoFullName: string;
  generatedAt: string;
  privateOnly: true;
  current: RegistryRepoConfig | null;
  recommended: {
    participationMode: "direct_pr" | "split";
    issueDiscoveryShare: number;
    directPrShare: number;
    maintainerCut: number;
    requireLinkedIssue: boolean;
    labelMultipliers: "keep_current_and_prune_unused" | "start_without_trusted_label_multipliers";
    publicSurface: RepositorySettings["publicSurface"];
    confirmedMinerLabel: string;
  };
  tradeoffs: string[];
  reasons: string[];
  warnings: string[];
};

export type GittensorConfigRecommendationInput = {
  repoFullName: string;
  repo: RepositoryRecord | null;
  settings: RepositorySettings;
  lane: LaneAdvice;
  configQuality: ConfigQuality;
  contributorIntakeHealth: ContributorIntakeHealth;
  maintainerCutReadiness: MaintainerCutReadiness;
};

/**
 * Pure initial Gittensor config recommendation for a repo owner.
 * Separates maintainer economics from miner rewards and always favors a safe direct-PR default.
 */
export function buildGittensorConfigRecommendation(input: GittensorConfigRecommendationInput): GittensorConfigRecommendation {
  const { repoFullName, repo, settings, lane, configQuality, contributorIntakeHealth, maintainerCutReadiness } = input;
  const current = repo?.registryConfig ?? null;
  const shouldEnableIssueDiscovery = contributorIntakeHealth.level === "healthy" && configQuality.level === "excellent";
  // Direct-PR-first posture: only allocate an issue-discovery slice when intake is healthy and config is excellent.
  const recommendedIssueDiscoveryShare = shouldEnableIssueDiscovery ? 0.1 : 0;
  // issueDiscoveryShare and directPrShare are repo-config semantics for the in-repo split between issue-discovery and direct-PR flow.
  // emissionShare is assigned externally and is intentionally not subtracted from here.
  const directPrShare = 1 - recommendedIssueDiscoveryShare;
  // Target a 30% maintainer cut when readiness is met; otherwise leave the configured value untouched.
  const recommendedMaintainerCut = maintainerCutReadiness.ready ? Math.max(current?.maintainerCut ?? 0, 0.3) : current?.maintainerCut ?? 0;

  return {
    repoFullName,
    generatedAt: nowIso(),
    privateOnly: true,
    current,
    recommended: {
      participationMode: recommendedIssueDiscoveryShare > 0 ? "split" : "direct_pr",
      issueDiscoveryShare: recommendedIssueDiscoveryShare,
      directPrShare,
      maintainerCut: recommendedMaintainerCut,
      requireLinkedIssue: settings.requireLinkedIssue,
      labelMultipliers: configQuality.configuredLabels.length > 0 ? "keep_current_and_prune_unused" : "start_without_trusted_label_multipliers",
      publicSurface: settings.publicSurface,
      confirmedMinerLabel: settings.gittensorLabel,
    },
    tradeoffs: [
      recommendedIssueDiscoveryShare > 0
        ? "A small issue-discovery slice can surface more outside contributor work but adds triage load and duplicate-report risk."
        : "Staying direct-PR-only keeps maintainer triage low but forgoes issue-discovery contributor flow.",
      recommendedMaintainerCut > (current?.maintainerCut ?? 0)
        ? "Introducing a maintainer cut rewards upkeep but reduces the share available to contributor miners."
        : "Leaving maintainer cut unchanged keeps the full emission share with contributor miners.",
      settings.requireLinkedIssue
        ? "Requiring a linked issue improves traceability but can deter quick, well-scoped direct PRs."
        : "Not requiring a linked issue lowers contributor friction but weakens issue/PR traceability.",
    ],
    reasons: [
      lane.lane === "issue_discovery" ? "The current registry lane already routes meaningful work through issue discovery." : "Direct-PR mode is the safest default until issue-discovery intake is intentionally staffed.",
      shouldEnableIssueDiscovery ? "Config and intake signals are strong enough to consider a small issue-discovery slice." : "Issue discovery should stay disabled until config quality and intake health are excellent.",
      maintainerCutReadiness.ready ? "Maintainer cut can be considered because config and queue signals are clean." : "Maintainer cut should stay unchanged until readiness blockers are cleared.",
    ],
    warnings: [
      ...(configQuality.notObservedConfiguredLabels.length > 0 ? [`${configQuality.notObservedConfiguredLabels.length} configured label(s) have not been observed in cached repo activity.`] : []),
      ...(contributorIntakeHealth.level === "strained" || contributorIntakeHealth.level === "blocked" ? [`Contributor intake is ${contributorIntakeHealth.level}; avoid increasing noisy lanes yet.`] : []),
    ],
  };
}
