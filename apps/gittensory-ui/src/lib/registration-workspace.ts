import { isFocusManifestPublicSafe } from "../../../../src/signals/focus-manifest";
import { splitRepoFullName } from "./maintainer-settings-preview";

export type WorkspaceFreshness = "complete" | "degraded" | "stale" | "unknown";
export type WorkspaceLaneStatus = "ready" | "warn" | "blocked" | "info";

function normalizePublicWorkspaceText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export type RegistrationWorkspaceDataQuality = {
  status?: string | undefined;
  partial?: boolean | undefined;
  warnings?: string[] | undefined;
};

export type RegistrationReadinessPayload = {
  repoFullName: string;
  generatedAt: string;
  ready: boolean;
  recommendedRegistrationMode: string;
  issuePolicy: string;
  directPrReadiness: { ready: boolean; reasons: string[] };
  issueDiscoveryReadiness: { ready: boolean; recommendation: string; reasons: string[] };
  labelPolicy: Record<string, unknown>;
  maintainerCutReadiness: Record<string, unknown>;
  testCoverageHealth: {
    status: string;
    trustedLabelPipelineReady: boolean;
    checkRunMode: string;
    requiredGate: string[];
    note: string;
    warnings: string[];
  };
  queueHealth: {
    level: string;
    burdenScore: number;
    reviewablePullRequests: number;
    summary: string;
  };
  contributorIntakeHealth: Record<string, unknown>;
  githubApp: {
    installed: boolean;
    publicSurface: string;
    commentMode: string;
    checkRunMode: string;
    quietByDefault: boolean;
    behavior: string;
    warnings: string[];
  };
  policyReadiness: {
    summary: string;
    publicWarnings: Array<{ title: string; detail: string; action: string; severity: string }>;
  } | null;
  blockers: string[];
  warnings: string[];
  docsCompleteness?: { status: string; requiredDocs: string[]; note: string } | undefined;
  dataQuality?: RegistrationWorkspaceDataQuality | undefined;
};

export type OwnerWorkflowState = "accepted" | "needs_cleanup" | "not_ready";

export type OwnerWorkflowRemediationKind = "action" | "manual";

export type OwnerWorkflowBucketId =
  "policy" | "data_quality" | "queue_health" | "docs_onboarding" | "maintainer_capacity";

export type OwnerWorkflowItem = {
  id: string;
  title: string;
  state: OwnerWorkflowState;
  summary: string;
  remediation: string;
  remediationKind: OwnerWorkflowRemediationKind;
};

export type OwnerWorkflowBucket = {
  id: OwnerWorkflowBucketId;
  title: string;
  state: OwnerWorkflowState;
  summary: string;
  items: OwnerWorkflowItem[];
};

export type RegistrationOwnerWorkflow = {
  overallState: OwnerWorkflowState;
  overallHeadline: string;
  buckets: OwnerWorkflowBucket[];
  nextSteps: string[];
};

export type GittensorConfigRecommendationPayload = {
  repoFullName: string;
  generatedAt: string;
  privateOnly?: boolean | undefined;
  current: Record<string, unknown> | null;
  recommended: Record<string, unknown>;
  tradeoffs: string[];
  reasons: string[];
  warnings: string[];
  dataQuality?: RegistrationWorkspaceDataQuality | undefined;
};

export type RegistrationWorkspaceSection = {
  id: string;
  title: string;
  status: WorkspaceLaneStatus;
  summary: string;
  bullets: string[];
};

export type RegistrationWorkspaceView = {
  repoFullName: string;
  generatedAt: string;
  advisoryBanner: string;
  freshness: { status: WorkspaceFreshness; warnings: string[] };
  summary: {
    ready: boolean;
    headline: string;
    recommendedMode: string;
    issuePolicy: string;
    status: WorkspaceLaneStatus;
  };
  lanes: {
    directPr: RegistrationWorkspaceSection;
    issueDiscovery: RegistrationWorkspaceSection;
    maintainerEconomics: RegistrationWorkspaceSection;
    minerGuidance: RegistrationWorkspaceSection;
  };
  operations: RegistrationWorkspaceSection[];
  policyWarnings: Array<{ title: string; detail: string; action: string; severity: string }>;
  workflow: RegistrationOwnerWorkflow;
  config: {
    tradeoffs: string[];
    reasons: string[];
    warnings: string[];
    recommendedLines: string[];
    currentLines: string[];
  } | null;
};

export function isRegistrationWorkspacePublicSafe(text: string): boolean {
  const normalized = normalizePublicWorkspaceText(text);
  return normalized.length > 0 && isFocusManifestPublicSafe(normalized);
}

export function sanitizeRegistrationWorkspaceText(text: string): string | null {
  const normalized = normalizePublicWorkspaceText(text);
  if (!normalized || !isFocusManifestPublicSafe(normalized)) return null;
  return normalized;
}

export function resolveRegistrationWorkspaceFreshness(
  readinessQuality?: RegistrationWorkspaceDataQuality,
  configQuality?: RegistrationWorkspaceDataQuality,
): { status: WorkspaceFreshness; warnings: string[] } {
  const warnings = [...(readinessQuality?.warnings ?? []), ...(configQuality?.warnings ?? [])]
    .map((entry) => sanitizeRegistrationWorkspaceText(entry))
    .filter((entry): entry is string => Boolean(entry));
  const statuses = [readinessQuality?.status, configQuality?.status].filter(
    (entry): entry is string => Boolean(entry),
  );
  if (statuses.includes("blocked")) return { status: "stale", warnings };
  if (readinessQuality?.partial || configQuality?.partial || statuses.includes("degraded")) {
    return { status: "degraded", warnings };
  }
  if (statuses.includes("complete")) return { status: "complete", warnings };
  return { status: warnings.length > 0 ? "degraded" : "unknown", warnings };
}

export function buildRegistrationWorkspaceView(
  readiness: RegistrationReadinessPayload,
  config: GittensorConfigRecommendationPayload | null,
): RegistrationWorkspaceView {
  const freshness = resolveRegistrationWorkspaceFreshness(
    readiness.dataQuality,
    config?.dataQuality,
  );
  const directPrStatus: WorkspaceLaneStatus = readiness.directPrReadiness.ready
    ? "ready"
    : readiness.blockers.length > 0
      ? "blocked"
      : "warn";
  const issueDiscoveryStatus: WorkspaceLaneStatus =
    readiness.issueDiscoveryReadiness.recommendation === "not_recommended"
      ? "info"
      : readiness.issueDiscoveryReadiness.ready
        ? "ready"
        : "warn";

  const maintainerCut = readiness.maintainerCutReadiness;
  const maintainerReady = maintainerCut.ready === true;
  const maintainerEconomicsStatus: WorkspaceLaneStatus = maintainerReady
    ? "ready"
    : readiness.ready
      ? "warn"
      : "blocked";

  const labelPolicy = readiness.labelPolicy;
  const intake = readiness.contributorIntakeHealth;

  return {
    repoFullName: readiness.repoFullName,
    generatedAt: readiness.generatedAt,
    advisoryBanner:
      "Advisory workspace only. Recommendations explain tradeoffs for repo owners; they do not guarantee Gittensor incentive outcomes.",
    freshness,
    summary: {
      ready: readiness.ready,
      headline: readiness.ready
        ? "Repository looks ready for contributor intake with the recommended posture."
        : "Resolve blockers before inviting more outside contributor traffic.",
      recommendedMode: readiness.recommendedRegistrationMode,
      issuePolicy: readiness.issuePolicy,
      status: readiness.ready ? "ready" : readiness.blockers.length > 0 ? "blocked" : "warn",
    },
    lanes: {
      directPr: {
        id: "direct-pr",
        title: "Direct PR lane",
        status: directPrStatus,
        summary: readiness.directPrReadiness.ready
          ? "Direct-PR intake is healthy enough for the recommended registration mode."
          : "Direct-PR intake needs attention before broadening contributor traffic.",
        bullets: sanitizeBulletList(readiness.directPrReadiness.reasons),
      },
      issueDiscovery: {
        id: "issue-discovery",
        title: "Issue discovery lane",
        status: issueDiscoveryStatus,
        summary: `Recommendation: ${readiness.issueDiscoveryReadiness.recommendation.replace(/_/g, " ")}.`,
        bullets: sanitizeBulletList(readiness.issueDiscoveryReadiness.reasons),
      },
      maintainerEconomics: {
        id: "maintainer-economics",
        title: "Maintainer economics",
        status: maintainerEconomicsStatus,
        summary:
          stringField(maintainerCut, "summary") ??
          "Maintainer-cut posture is separate from public contributor incentive guidance.",
        bullets: sanitizeBulletList([
          ...(Array.isArray(maintainerCut.reasons) ? (maintainerCut.reasons as string[]) : []),
          ...(Array.isArray(maintainerCut.warnings) ? (maintainerCut.warnings as string[]) : []),
          typeof maintainerCut.recommendedAction === "string"
            ? `Suggested action: ${maintainerCut.recommendedAction.replace(/_/g, " ")}.`
            : "",
        ]),
      },
      minerGuidance: {
        id: "miner-guidance",
        title: "Miner scoreability (separate)",
        status: "info",
        summary:
          "Contributor/miner scoreability and queue pressure are evaluated separately from maintainer-cut economics.",
        bullets: sanitizeBulletList([
          `Contributor intake: ${stringField(intake, "level") ?? "unknown"}.`,
          `Queue burden: ${readiness.queueHealth.level} (${readiness.queueHealth.reviewablePullRequests} reviewable PRs).`,
          readiness.queueHealth.summary,
        ]),
      },
    },
    operations: [
      {
        id: "queue-health",
        title: "Queue health",
        status: queueStatus(readiness.queueHealth.level),
        summary: readiness.queueHealth.summary,
        bullets: sanitizeBulletList([
          `Burden score: ${readiness.queueHealth.burdenScore}.`,
          `Reviewable pull requests: ${readiness.queueHealth.reviewablePullRequests}.`,
        ]),
      },
      {
        id: "label-policy",
        title: "Label policy",
        status: labelPolicy.trustedPipelineReady === true ? "ready" : "warn",
        summary: "Registry labels and trusted pipeline readiness for incoming work.",
        bullets: sanitizeBulletList([
          labelPolicy.autoLabelEnabled === true
            ? `Auto-label enabled (${String(labelPolicy.label ?? "gittensor")}).`
            : "Auto-label is disabled.",
          labelPolicy.trustedPipelineReady === true
            ? "Trusted label pipeline is verified."
            : "Trusted label pipeline is not verified yet.",
          ...(Array.isArray(labelPolicy.missingOrUnusedRegistryLabels)
            ? (labelPolicy.missingOrUnusedRegistryLabels as string[]).map(
                (label) => `Missing or unused label: ${label}`,
              )
            : []),
        ]),
      },
      {
        id: "test-policy",
        title: "Test & validation policy",
        status: readiness.testCoverageHealth.status === "gate_ready" ? "ready" : "warn",
        summary: readiness.testCoverageHealth.note,
        bullets: sanitizeBulletList([
          `Coverage gate: ${readiness.testCoverageHealth.status}.`,
          `Check runs: ${readiness.testCoverageHealth.checkRunMode}.`,
          ...(readiness.testCoverageHealth.requiredGate ?? []).map(
            (gate) => `Required gate: ${gate}`,
          ),
          ...readiness.testCoverageHealth.warnings,
        ]),
      },
      {
        id: "github-app",
        title: "GitHub App behavior",
        status: readiness.githubApp.installed ? "ready" : "warn",
        summary: readiness.githubApp.behavior,
        bullets: sanitizeBulletList([
          `Public surface: ${readiness.githubApp.publicSurface}.`,
          `Comment mode: ${readiness.githubApp.commentMode}.`,
          ...(readiness.githubApp.quietByDefault ? ["Quiet-by-default posture is enabled."] : []),
          ...readiness.githubApp.warnings,
        ]),
      },
    ],
    policyWarnings: (readiness.policyReadiness?.publicWarnings ?? [])
      .map((warning) => ({
        title: sanitizeRegistrationWorkspaceText(warning.title) ?? "Policy warning",
        detail: sanitizeRegistrationWorkspaceText(warning.detail) ?? "",
        action: sanitizeRegistrationWorkspaceText(warning.action) ?? "",
        severity: warning.severity,
      }))
      .filter((warning) => warning.detail.length > 0),
    workflow: buildRegistrationOwnerWorkflow(readiness, config),
    config: config
      ? {
          tradeoffs: sanitizeBulletList(config.tradeoffs),
          reasons: sanitizeBulletList(config.reasons),
          warnings: sanitizeBulletList(config.warnings),
          recommendedLines: recordLines(config.recommended),
          currentLines: recordLines(config.current ?? {}),
        }
      : null,
  };
}

export function buildRegistrationOwnerWorkflow(
  readiness: RegistrationReadinessPayload,
  config: GittensorConfigRecommendationPayload | null,
): RegistrationOwnerWorkflow {
  const freshness = resolveRegistrationWorkspaceFreshness(
    readiness.dataQuality,
    config?.dataQuality,
  );
  const intakeLevel = stringField(readiness.contributorIntakeHealth, "level") ?? "unknown";
  const labelPolicy = readiness.labelPolicy;
  const docs = readiness.docsCompleteness ?? { status: "unknown", requiredDocs: [], note: "" };

  const policyItems: OwnerWorkflowItem[] = [];
  for (const warning of readiness.policyReadiness?.publicWarnings ?? []) {
    const title = sanitizeRegistrationWorkspaceText(warning.title);
    const detail = sanitizeRegistrationWorkspaceText(warning.detail);
    const action = sanitizeRegistrationWorkspaceText(warning.action);
    if (!title || !detail) continue;
    policyItems.push({
      id: `policy-warning-${policyItems.length}`,
      title,
      state: warning.severity === "critical" ? "not_ready" : "needs_cleanup",
      summary: detail,
      remediation: action ?? "Review focus manifest and repository settings for consistency.",
      remediationKind: action ? "action" : "manual",
    });
  }
  if (!readiness.directPrReadiness.ready) {
    policyItems.push({
      id: "direct-pr-lane",
      title: "Direct PR lane",
      state: readiness.blockers.length > 0 ? "not_ready" : "needs_cleanup",
      summary: "Direct-PR intake is not ready for the recommended registration mode.",
      remediation:
        "Stabilize config quality and contributor intake before promoting direct-PR traffic.",
      remediationKind: "action",
    });
  }
  if (labelPolicy.trustedPipelineReady !== true) {
    policyItems.push({
      id: "label-trust",
      title: "Label policy",
      state: "needs_cleanup",
      summary: "Trusted label pipeline is not verified for registry labels.",
      remediation:
        "Create or verify configured registry labels and enable the trusted label pipeline in repo settings.",
      remediationKind: "action",
    });
  }

  const dataQualityItems: OwnerWorkflowItem[] = [];
  if (freshness.status === "stale" || freshness.status === "degraded") {
    for (const warning of freshness.warnings) {
      dataQualityItems.push({
        id: `data-warning-${dataQualityItems.length}`,
        title: "Signal freshness",
        state: freshness.status === "stale" ? "not_ready" : "needs_cleanup",
        summary: warning,
        remediation:
          "Wait for repository intelligence to refresh or run a maintainer backfill before acting on readiness.",
        remediationKind: "manual",
      });
    }
  }
  if (readiness.testCoverageHealth.status !== "gate_ready") {
    dataQualityItems.push({
      id: "test-gate",
      title: "Validation gate",
      state: "needs_cleanup",
      summary: readiness.testCoverageHealth.note,
      remediation:
        "Document expected CI commands in the repo and verify check-run settings before widening intake.",
      remediationKind: "action",
    });
  }
  for (const warning of readiness.testCoverageHealth.warnings) {
    const safe = sanitizeRegistrationWorkspaceText(warning);
    if (!safe) continue;
    dataQualityItems.push({
      id: `test-warning-${dataQualityItems.length}`,
      title: "Test policy warning",
      state: "needs_cleanup",
      summary: safe,
      remediation: "Address validation warnings before inviting more contributor traffic.",
      remediationKind: "action",
    });
  }

  const queueItems: OwnerWorkflowItem[] = [];
  const queueLevel = readiness.queueHealth.level;
  if (queueLevel === "high" || queueLevel === "critical") {
    queueItems.push({
      id: "queue-pressure",
      title: "PR queue pressure",
      state: "not_ready",
      summary: readiness.queueHealth.summary,
      remediation:
        "Reduce open PR queue pressure or narrow accepted lanes before inviting more contributors.",
      remediationKind: "action",
    });
  } else if (queueLevel === "medium") {
    queueItems.push({
      id: "queue-pressure",
      title: "PR queue pressure",
      state: "needs_cleanup",
      summary: readiness.queueHealth.summary,
      remediation: "Review open PRs and triage burden before expanding contributor intake.",
      remediationKind: "action",
    });
  }

  const docsItems: OwnerWorkflowItem[] = [];
  if (docs.status === "repo_docs_not_crawled") {
    docsItems.push({
      id: "docs-crawl",
      title: "Onboarding docs",
      state: "needs_cleanup",
      summary: docs.note,
      remediation:
        "Manually verify CONTRIBUTING.md, README onboarding steps, and issue templates in GitHub; remote doc crawling is not enabled in this signal yet.",
      remediationKind: "manual",
    });
  } else if (docs.requiredDocs.length > 0) {
    docsItems.push({
      id: "docs-required",
      title: "Required docs",
      state: "accepted",
      summary: `Expected docs: ${docs.requiredDocs.join(", ")}.`,
      remediation: "Keep onboarding docs aligned with the recommended registration mode.",
      remediationKind: "action",
    });
  }

  const capacityItems: OwnerWorkflowItem[] = [];
  if (intakeLevel === "blocked" || intakeLevel === "strained") {
    capacityItems.push({
      id: "intake-health",
      title: "Contributor intake",
      state: intakeLevel === "blocked" ? "not_ready" : "needs_cleanup",
      summary:
        stringField(readiness.contributorIntakeHealth, "summary") ??
        `Contributor intake is ${intakeLevel}.`,
      remediation:
        "Stabilize triage capacity and duplicate-risk intake before inviting more issue reports or direct PRs.",
      remediationKind: "action",
    });
  }
  const maintainerCut = readiness.maintainerCutReadiness;
  if (maintainerCut.ready !== true) {
    capacityItems.push({
      id: "maintainer-cut",
      title: "Maintainer cut readiness",
      state: readiness.ready ? "needs_cleanup" : "not_ready",
      summary: stringField(maintainerCut, "summary") ?? "Maintainer-cut posture needs review.",
      remediation:
        typeof maintainerCut.recommendedAction === "string"
          ? `Follow maintainer-cut guidance: ${maintainerCut.recommendedAction.replace(/_/g, " ")}.`
          : "Resolve queue and config blockers before changing maintainer_cut.",
      remediationKind: "action",
    });
  }
  for (const blocker of readiness.blockers) {
    const safe = sanitizeRegistrationWorkspaceText(blocker);
    if (!safe) continue;
    const bucket = classifyBlockerBucket(safe);
    const target =
      bucket === "policy"
        ? policyItems
        : bucket === "data_quality"
          ? dataQualityItems
          : bucket === "queue_health"
            ? queueItems
            : bucket === "docs_onboarding"
              ? docsItems
              : capacityItems;
    target.push({
      id: `blocker-${target.length}`,
      title: "Registration blocker",
      state: "not_ready",
      summary: safe,
      remediation: remediationForBlocker(safe),
      remediationKind: remediationKindForBlocker(safe),
    });
  }

  const buckets: OwnerWorkflowBucket[] = [
    buildWorkflowBucket(
      "policy",
      "Policy & lanes",
      policyItems,
      "Focus manifest, lane posture, and label policy.",
    ),
    buildWorkflowBucket(
      "data_quality",
      "Data quality",
      dataQualityItems,
      "Signal freshness and validation gates.",
    ),
    buildWorkflowBucket(
      "queue_health",
      "Queue health",
      queueItems,
      "Open PR pressure and reviewable queue burden.",
    ),
    buildWorkflowBucket(
      "docs_onboarding",
      "Docs & onboarding",
      docsItems,
      "Contributor-facing documentation readiness.",
    ),
    buildWorkflowBucket(
      "maintainer_capacity",
      "Maintainer capacity",
      capacityItems,
      "Intake health, maintainer-cut posture, and GitHub App assistance.",
    ),
  ];

  const overallState = aggregateWorkflowState(buckets.map((bucket) => bucket.state));
  const nextSteps = buckets
    .flatMap((bucket) => bucket.items)
    .filter((item) => item.state !== "accepted")
    .sort((left, right) => workflowRank(left.state) - workflowRank(right.state))
    .map((item) => item.remediation)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, 5);

  return {
    overallState,
    overallHeadline: workflowHeadline(overallState, readiness.ready),
    buckets,
    nextSteps,
  };
}

export function collectRegistrationOwnerWorkflowPublicText(
  workflow: RegistrationOwnerWorkflow,
): string[] {
  return [
    workflow.overallHeadline,
    ...workflow.nextSteps,
    ...workflow.buckets.flatMap((bucket) => [
      bucket.title,
      bucket.summary,
      ...bucket.items.flatMap((item) => [item.title, item.summary, item.remediation]),
    ]),
  ];
}

export function collectRegistrationWorkspacePublicText(view: RegistrationWorkspaceView): string[] {
  const chunks = [
    view.advisoryBanner,
    view.summary.headline,
    ...collectRegistrationOwnerWorkflowPublicText(view.workflow),
    ...view.freshness.warnings,
    ...view.lanes.directPr.bullets,
    ...view.lanes.issueDiscovery.bullets,
    ...view.lanes.maintainerEconomics.bullets,
    ...view.lanes.minerGuidance.bullets,
    ...view.operations.flatMap((section) => [section.summary, ...section.bullets]),
    ...(view.config?.tradeoffs ?? []),
    ...(view.config?.reasons ?? []),
    ...view.policyWarnings.flatMap((warning) => [warning.title, warning.detail, warning.action]),
  ];
  return chunks.filter((entry) => entry.length > 0);
}

export { splitRepoFullName };

function sanitizeBulletList(entries: string[]): string[] {
  return entries
    .map((entry) => sanitizeRegistrationWorkspaceText(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? sanitizeRegistrationWorkspaceText(value) : null;
}

function queueStatus(level: string): WorkspaceLaneStatus {
  if (level === "low") return "ready";
  if (level === "medium") return "warn";
  if (level === "high" || level === "critical") return "blocked";
  return "info";
}

function recordLines(record: Record<string, unknown>): string[] {
  const entries = Object.entries(record);
  if (entries.length === 0) return ["{}"];
  return entries.slice(0, 10).map(([key, value]) => `${key}: ${formatValue(value)}`);
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildWorkflowBucket(
  id: OwnerWorkflowBucketId,
  title: string,
  items: OwnerWorkflowItem[],
  summary: string,
): OwnerWorkflowBucket {
  const state =
    items.length === 0 ? "accepted" : aggregateWorkflowState(items.map((item) => item.state));
  return { id, title, state, summary, items };
}

function aggregateWorkflowState(states: OwnerWorkflowState[]): OwnerWorkflowState {
  if (states.includes("not_ready")) return "not_ready";
  if (states.includes("needs_cleanup")) return "needs_cleanup";
  return "accepted";
}

function workflowRank(state: OwnerWorkflowState): number {
  if (state === "not_ready") return 0;
  if (state === "needs_cleanup") return 1;
  return 2;
}

function workflowHeadline(state: OwnerWorkflowState, ready: boolean): string {
  if (state === "accepted" && ready) {
    return "Accepted — contributor intake posture matches the recommended registration mode.";
  }
  if (state === "not_ready") {
    return "Not ready — resolve blockers in the workflow buckets before inviting more contributors.";
  }
  return "Needs cleanup — some areas are acceptable but require maintainer follow-up before scaling intake.";
}

function classifyBlockerBucket(blocker: string): OwnerWorkflowBucketId {
  const lower = blocker.toLowerCase();
  if (lower.includes("config quality") || lower.includes("focus") || lower.includes("label"))
    return "policy";
  if (lower.includes("doc") || lower.includes("contributing")) return "docs_onboarding";
  if (lower.includes("queue") || lower.includes("pull request") || lower.includes("pr "))
    return "queue_health";
  if (lower.includes("install") || lower.includes("github app") || lower.includes("intake"))
    return "maintainer_capacity";
  if (lower.includes("drift") || lower.includes("forecast") || lower.includes("coverage"))
    return "data_quality";
  return "maintainer_capacity";
}

function remediationForBlocker(blocker: string): string {
  const bucket = classifyBlockerBucket(blocker);
  switch (bucket) {
    case "policy":
      return "Fix registry config, focus manifest, or label policy issues referenced in the blocker.";
    case "data_quality":
      return "Refresh repository intelligence or update validation fixtures before re-checking readiness.";
    case "queue_health":
      return "Reduce queue pressure and close or triage stale pull requests before expanding intake.";
    case "docs_onboarding":
      return "Update onboarding docs and templates in the repository (manual GitHub edit required).";
    case "maintainer_capacity":
      return "Address installation health, intake strain, or maintainer-cut blockers before promoting the repo.";
  }
}

function remediationKindForBlocker(blocker: string): OwnerWorkflowRemediationKind {
  const lower = blocker.toLowerCase();
  if (lower.includes("not crawled") || lower.includes("manual") || lower.includes("install"))
    return "manual";
  return "action";
}
