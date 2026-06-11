import type {
  Advisory,
  AdvisoryConclusion,
  AdvisoryFinding,
  AdvisorySeverity,
  GateRuleMode,
  IssueRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  RepositoryRecord,
} from "../types";
import type { CollisionCluster, CollisionReport } from "../signals/engine";
import { nowIso } from "../utils/json";

export type GateCheckConclusion = "success" | "failure" | "action_required" | "neutral" | "skipped";

export type GateCheckPolicy = {
  linkedIssueGateMode?: GateRuleMode | undefined;
  duplicatePrGateMode?: GateRuleMode | undefined;
  qualityGateMode?: GateRuleMode | undefined;
  qualityGateMinScore?: number | null | undefined;
  readinessScore?: number | null | undefined;
};

export type GateCheckEvaluation = {
  enabled: boolean;
  conclusion: GateCheckConclusion;
  title: string;
  summary: string;
  blockers: AdvisoryFinding[];
  warnings: AdvisoryFinding[];
};

export function buildRepositoryAdvisory(repo: RepositoryRecord | null, fullName: string): Advisory {
  const findings: AdvisoryFinding[] = [];
  if (!repo) {
    findings.push({
      code: "repo_not_seen",
      severity: "warning",
      title: "Repository is not in the local index",
      detail: "Gittensory has not seen this repository through registry sync or GitHub App installation yet.",
      action: "Install the GitHub App or refresh the Gittensor registry snapshot.",
    });
  } else {
    addRepoFindings(repo, findings);
  }
  return advisory("repository", fullName, fullName, findings, "Repository advisory generated.");
}

export function buildPullRequestAdvisory(
  repo: RepositoryRecord | null,
  pr: PullRequestRecord | null,
  context: { otherOpenPullRequests?: PullRequestRecord[]; requireLinkedIssue?: boolean } = {},
): Advisory {
  const repoFullName = pr?.repoFullName ?? repo?.fullName ?? "unknown/unknown";
  const targetKey = pr ? `${repoFullName}#${pr.number}` : `${repoFullName}#unknown`;
  const findings: AdvisoryFinding[] = [];
  if (!repo) {
    findings.push({
      code: "repo_not_registered",
      severity: "warning",
      title: "Repository registration is unknown",
      detail: "Gittensory cannot evaluate repo-specific rules until registry data is available.",
      action: "Refresh the Gittensor registry snapshot.",
    });
  } else {
    addRepoFindings(repo, findings);
  }
  if (!pr) {
    findings.push({
      code: "pr_not_cached",
      severity: "warning",
      title: "Pull request is not cached",
      detail: "The GitHub webhook or manual fetch has not recorded this pull request yet.",
      action: "Re-deliver the webhook or wait for the next sync.",
    });
  } else {
    addPullRequestFindings(repo, pr, findings, context.otherOpenPullRequests ?? [], Boolean(context.requireLinkedIssue));
  }
  return advisory("pull_request", targetKey, repoFullName, findings, "Pull request advisory generated.", pr?.number, undefined, pr?.headSha ?? undefined);
}

export function buildIssueAdvisory(repo: RepositoryRecord | null, issue: IssueRecord | null): Advisory {
  const repoFullName = issue?.repoFullName ?? repo?.fullName ?? "unknown/unknown";
  const targetKey = issue ? `${repoFullName}#${issue.number}` : `${repoFullName}#unknown`;
  const findings: AdvisoryFinding[] = [];
  if (!repo) {
    findings.push({
      code: "repo_not_registered",
      severity: "warning",
      title: "Repository registration is unknown",
      detail: "Gittensory cannot evaluate repo-specific issue rules until registry data is available.",
    });
  } else {
    addRepoFindings(repo, findings);
  }
  if (!issue) {
    findings.push({
      code: "issue_not_cached",
      severity: "warning",
      title: "Issue is not cached",
      detail: "The GitHub webhook or manual fetch has not recorded this issue yet.",
    });
  } else {
    addIssueFindings(repo, issue, findings);
  }
  return advisory("issue", targetKey, repoFullName, findings, "Issue advisory generated.", undefined, issue?.number);
}

const CHECK_RUN_FORBIDDEN_TERMS =
  /\b(?:rewards?|payouts?|farming|estimated\s+scores?|raw\s+trust\s+scores?|trust\s+scores?|score\s+estimates?|reward\s+estimates?|wallets?|hotkeys?|coldkeys?|reviewability|scoreability|private\s+signals?)\b/gi;

function sanitizeForCheckRun(text: string): string {
  return text.replace(CHECK_RUN_FORBIDDEN_TERMS, "[context]").replace(/\s+/g, " ").trim();
}

export const CHECK_RUN_ANNOTATION_LIMIT = 50;

export type CheckRunAnnotation = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title: string;
};

export type CheckRunOutput = {
  title: string;
  summary: string;
  text: string;
  annotations?: CheckRunAnnotation[];
};

export type CheckRunAnnotationContext = {
  files: PullRequestFileRecord[];
  collisions: CollisionReport;
  pullNumber: number;
};

export type CheckRunAnnotationBuildResult = {
  annotations: CheckRunAnnotation[];
  omittedCount: number;
};

function severityToAnnotationLevel(severity: AdvisorySeverity): CheckRunAnnotation["annotation_level"] {
  if (severity === "critical") return "failure";
  if (severity === "warning") return "warning";
  return "notice";
}

function isCodePath(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|cs|cpp|c|h|swift|kt|m|sql|yaml|yml|json|toml|md)$/i.test(path);
}

function isTestPath(path: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(path) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)$/i.test(path) ||
    /(^|\/)[^/]+_test\.go$/i.test(path)
  );
}

function collisionClustersForPull(collisions: CollisionReport, pullNumber: number): CollisionCluster[] {
  return collisions.clusters.filter((cluster) =>
    cluster.items.some((item) => item.type === "pull_request" && item.number === pullNumber),
  );
}

function annotationLineForFile(file: PullRequestFileRecord): number {
  return Math.max(1, file.additions > 0 ? 1 : 1);
}

export function buildCheckRunAnnotations(
  advisoryResult: Advisory,
  annotationContext: CheckRunAnnotationContext | undefined,
  detailLevel: "minimal" | "standard" | "deep" = "minimal",
): CheckRunAnnotationBuildResult {
  if (detailLevel === "minimal" || !annotationContext) {
    return { annotations: [], omittedCount: 0 };
  }

  const candidates: CheckRunAnnotation[] = [];
  const seen = new Set<string>();
  const addCandidate = (
    path: string,
    line: number,
    level: CheckRunAnnotation["annotation_level"],
    title: string,
    message: string,
  ) => {
    const safeTitle = sanitizeForCheckRun(title).slice(0, 255);
    const safeMessage = sanitizeForCheckRun(message).slice(0, 65535);
    if (!path || !safeTitle || !safeMessage) return;
    const key = `${path}:${safeTitle}:${safeMessage}`;
    if (seen.has(key)) return;
    seen.add(key);
    const startLine = Math.max(1, line);
    candidates.push({
      path,
      start_line: startLine,
      end_line: startLine,
      annotation_level: level,
      title: safeTitle,
      message: safeMessage,
    });
  };

  const codeFiles = annotationContext.files.filter((file) => file.path && isCodePath(file.path) && !isTestPath(file.path));
  const testFiles = annotationContext.files.filter((file) => file.path && isTestPath(file.path));
  if (codeFiles.length > 0 && testFiles.length === 0) {
    for (const file of codeFiles) {
      addCandidate(
        file.path,
        annotationLineForFile(file),
        "warning",
        "Missing test evidence",
        "Code changed without an obvious test file in this PR. Add focused tests or explain why existing coverage is sufficient.",
      );
    }
  }

  for (const cluster of collisionClustersForPull(annotationContext.collisions, annotationContext.pullNumber)) {
    const level: CheckRunAnnotation["annotation_level"] = cluster.risk === "high" ? "warning" : "notice";
    for (const file of annotationContext.files) {
      addCandidate(file.path, annotationLineForFile(file), level, "Possible duplicate overlap", cluster.reason);
    }
  }

  const changedPaths = annotationContext.files.map((file) => file.path).filter(Boolean);
  for (const finding of advisoryResult.findings) {
    if (!finding.publicText) continue;
    const targets = changedPaths.length > 0 ? changedPaths : [];
    for (const path of targets) {
      addCandidate(
        path,
        1,
        severityToAnnotationLevel(finding.severity),
        finding.title,
        finding.publicText,
      );
    }
  }

  const omittedCount = Math.max(0, candidates.length - CHECK_RUN_ANNOTATION_LIMIT);
  return { annotations: candidates.slice(0, CHECK_RUN_ANNOTATION_LIMIT), omittedCount };
}

export function formatCheckRunOutput(
  advisoryResult: Advisory,
  detailLevel: "minimal" | "standard" | "deep" = "minimal",
  annotationContext?: CheckRunAnnotationContext,
): CheckRunOutput {
  const title = advisoryResult.conclusion === "success" ? "Gittensory context checked" : "Gittensory context posted";
  const summary = "Gittensory public check output is intentionally minimal. Detailed maintainer context is available only through private API/MCP surfaces.";

  let text: string;
  if (detailLevel === "minimal") {
    text = "No detailed findings are published in check runs.";
  } else if (advisoryResult.findings.length === 0) {
    text = "No detailed findings are published in check runs.";
  } else {
    const publicLines = advisoryResult.findings.flatMap((f) => {
      if (!f.publicText) return [];
      const label = f.severity === "warning" ? "⚠️" : "ℹ️";
      return [`${label} ${sanitizeForCheckRun(f.publicText)}`];
    });
    text = publicLines.length === 0 ? "No detailed findings are published in check runs." : publicLines.join("\n");
  }

  const { annotations, omittedCount } = buildCheckRunAnnotations(advisoryResult, annotationContext, detailLevel);
  if (omittedCount > 0) {
    text = `${text}\n\n…${omittedCount} more hotspot annotation(s) omitted from inline check output.`;
  }

  return annotations.length > 0 ? { title, summary, text, annotations } : { title, summary, text };
}

export function evaluateGateCheck(advisoryResult: Advisory, policy: GateCheckPolicy = {}): GateCheckEvaluation {
  const evaluationBlockers = advisoryResult.findings.filter((finding) => isEvaluationBlocker(finding.code));
  const configuredBlockers = advisoryResult.findings.filter((finding) => isConfiguredGateBlocker(finding.code, policy));
  const qualityBlocker = buildQualityGateBlocker(policy);
  const blockers = [...evaluationBlockers, ...configuredBlockers, ...(qualityBlocker ? [qualityBlocker] : [])];
  if (blockers.length === 0) {
    return {
      enabled: true,
      conclusion: "success",
      title: "Gittensory Gate passed",
      summary: "No configured hard blocker was found. Advisory findings, if any, stay advisory.",
      blockers,
      warnings: advisoryResult.findings.filter((finding) => finding.severity === "warning"),
    };
  }
  return {
    enabled: true,
    conclusion: evaluationBlockers.length > 0 ? "action_required" : "failure",
    title: evaluationBlockers.length > 0 ? "Gittensory Gate needs app attention" : "Gittensory Gate is blocking merge",
    summary:
      evaluationBlockers.length > 0
        ? "Gittensory cannot evaluate this PR until app or repo state is repaired."
        : `${blockers.length} configured hard blocker${blockers.length === 1 ? "" : "s"} found.`,
    blockers,
    warnings: advisoryResult.findings.filter((finding) => finding.severity === "warning" && !blockers.includes(finding)),
  };
}

export function formatGateCheckOutput(gate: GateCheckEvaluation): { title: string; summary: string; text: string } {
  if (gate.conclusion === "success") {
    return {
      title: gate.title,
      summary: "Gittensory Gate is advisory-first. This PR has no configured hard blocker.",
      text: "No configured hard blocker was found. Advisory signals remain visible in the PR panel when comments are enabled.",
    };
  }
  if (gate.conclusion === "neutral" || gate.conclusion === "skipped") {
    return {
      title: gate.title,
      summary: gate.summary,
      text: "Gittensory did not create a contributor-facing failure for this event.",
    };
  }
  const blockerLines = gate.blockers.slice(0, 8).map((finding) => {
    const action = finding.action ? ` Action: ${sanitizeForCheckRun(finding.action)}` : "";
    return `- ${sanitizeForCheckRun(finding.title)}.${action}`;
  });
  return {
    title: gate.title,
    summary:
      gate.conclusion === "action_required"
        ? "Gittensory Gate could not evaluate this PR because app or repo state needs attention."
        : "Gittensory Gate found a repo-configured hard blocker.",
    text: blockerLines.length > 0 ? blockerLines.join("\n") : "A configured hard blocker was found.",
  };
}

function addRepoFindings(repo: RepositoryRecord, findings: AdvisoryFinding[]): void {
  if (!repo.isRegistered) {
    findings.push({
      code: "repo_unregistered",
      severity: "warning",
      title: "Repository is not registered in the latest snapshot",
      detail: "This repository is installed in Gittensory, but the latest registry snapshot does not include it.",
      action: "Verify repository registration before relying on Gittensor-specific signals.",
    });
    return;
  }
  if (!repo.registryConfig) {
    findings.push({
      code: "repo_config_missing",
      severity: "warning",
      title: "Repository config was not parsed",
      detail: "The repository appears in the registry, but its config was not available in normalized form.",
    });
    return;
  }
  const issueShare = repo.registryConfig.issueDiscoveryShare;
  if (issueShare === 0) {
    findings.push({
      code: "issue_discovery_disabled",
      severity: "info",
      title: "Issue discovery is disabled for this repo",
      detail: "The current Gittensor registry config routes this repository away from issue-discovery work.",
      publicText: "This repo is configured for direct contribution review rather than issue-discovery flow.",
    });
  } else if (issueShare === 1) {
    findings.push({
      code: "direct_pr_pool_disabled",
      severity: "info",
      title: "Direct PR scoring is disabled for this repo",
      detail: "The current Gittensor registry config routes this repository fully toward issue-discovery work.",
      publicText: "This repo is configured around issue-discovery flow. Maintainers should review PR expectations manually.",
    });
  }
  if (repo.registryConfig.maintainerCut > 0) {
    findings.push({
      code: "maintainer_cut_enabled",
      severity: "info",
      title: "Maintainer allocation is configured",
      detail: "This repo has a maintainer allocation configured in the registry.",
    });
  }
}

function addPullRequestFindings(
  repo: RepositoryRecord | null,
  pr: PullRequestRecord,
  findings: AdvisoryFinding[],
  otherOpenPullRequests: PullRequestRecord[],
  requireLinkedIssue: boolean,
): void {
  if (pr.state !== "open") {
    findings.push({
      code: "pr_not_open",
      severity: "info",
      title: "Pull request is not open",
      detail: `The pull request state is ${pr.state}.`,
    });
  }
  if (pr.linkedIssues.length === 0 && requireLinkedIssue) {
    findings.push({
      code: "missing_linked_issue",
      severity: "warning",
      title: "No linked issue detected",
      detail: "No closing reference or linked issue number was found in the PR metadata/body.",
      action: "If this PR is intended to solve an issue, link it explicitly in the PR body.",
    });
  } else {
    const overlappingPrs = otherOpenPullRequests.filter((otherPr) =>
      otherPr.linkedIssues.some((issueNumber) => pr.linkedIssues.includes(issueNumber)),
    );
    if (overlappingPrs.length > 0) {
      findings.push({
        code: "duplicate_pr_risk",
        severity: "warning",
        title: "Linked issue overlaps another open PR",
        detail: `Other open pull requests reference the same linked issue set: ${overlappingPrs.map((otherPr) => `#${otherPr.number}`).join(", ")}.`,
        action: "Review the related PRs before spending reviewer time on duplicate work.",
      });
    }
  }
  if (otherOpenPullRequests.length >= 10) {
    findings.push({
      code: "busy_pr_queue",
      severity: "info",
      title: "Open PR queue is busy",
      detail: `Gittensory has ${otherOpenPullRequests.length} other open pull requests cached for this repository.`,
      publicText: "This repo has a busy open PR queue in the local Gittensory cache.",
    });
  }
  const repoMultipliers = repo?.registryConfig?.labelMultipliers ?? {};
  const matchedLabels = pr.labels.filter((label) => repoMultipliers[label] !== undefined);
  if (matchedLabels.length > 0) {
    findings.push({
      code: "label_context_found",
      severity: "info",
      title: "Configured label context found",
      detail: `Matched configured labels: ${matchedLabels.join(", ")}.`,
    });
  }
  if (pr.authorAssociation && ["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.authorAssociation)) {
    findings.push({
      code: "maintainer_authored_pr",
      severity: "info",
      title: "PR author has maintainer association",
      detail: "GitHub marks this PR author as owner, member, or collaborator for the repository.",
      publicText: "This PR appears to come from a maintainer-associated account.",
    });
  }
}

function addIssueFindings(repo: RepositoryRecord | null, issue: IssueRecord, findings: AdvisoryFinding[]): void {
  if (issue.state !== "open") {
    findings.push({
      code: "issue_not_open",
      severity: "info",
      title: "Issue is not open",
      detail: `The issue state is ${issue.state}.`,
    });
  }
  if (issue.linkedPrs.length > 0) {
    findings.push({
      code: "issue_has_linked_prs",
      severity: "warning",
      title: "Issue already has linked PRs",
      detail: `Linked pull requests detected: ${issue.linkedPrs.join(", ")}.`,
      action: "Avoid duplicate work unless the linked PR is abandoned or incomplete.",
    });
  }
  const issueShare = repo?.registryConfig?.issueDiscoveryShare;
  if (issueShare === 0) {
    findings.push({
      code: "issue_discovery_not_configured",
      severity: "info",
      title: "Issue discovery is not configured for this repo",
      detail: "The current repo config does not route this repository toward issue-discovery work.",
    });
  }
}

function advisory(
  targetType: Advisory["targetType"],
  targetKey: string,
  repoFullName: string,
  findings: AdvisoryFinding[],
  fallbackSummary: string,
  pullNumber?: number,
  issueNumber?: number,
  headSha?: string,
): Advisory {
  const severity = highestSeverity(findings);
  const conclusion = conclusionForSeverity(severity, findings);
  const title = conclusion === "success" ? "Gittensory advisory passed" : "Gittensory advisory available";
  return {
    id: crypto.randomUUID(),
    targetType,
    targetKey,
    repoFullName,
    ...(pullNumber === undefined ? {} : { pullNumber }),
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(headSha === undefined ? {} : { headSha }),
    conclusion,
    severity,
    title,
    summary: findings.length > 0 ? `${findings.length} advisory finding${findings.length === 1 ? "" : "s"} generated.` : fallbackSummary,
    findings,
    generatedAt: nowIso(),
  };
}

function highestSeverity(findings: AdvisoryFinding[]): AdvisorySeverity {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "warning")) return "warning";
  return "info";
}

function conclusionForSeverity(severity: AdvisorySeverity, findings: AdvisoryFinding[]): AdvisoryConclusion {
  if (findings.some((finding) => finding.code === "repo_unregistered" || finding.code === "repo_not_seen")) return "action_required";
  if (severity === "warning") return "neutral";
  if (severity === "critical") return "action_required";
  return "success";
}

function isEvaluationBlocker(code: string): boolean {
  return code === "repo_not_registered" || code === "repo_not_seen" || code === "pr_not_cached";
}

function isConfiguredGateBlocker(code: string, policy: GateCheckPolicy): boolean {
  if (code === "missing_linked_issue") return gateMode(policy.linkedIssueGateMode ?? "block") === "block";
  if (code === "duplicate_pr_risk") return gateMode(policy.duplicatePrGateMode ?? "block") === "block";
  return false;
}

function buildQualityGateBlocker(policy: GateCheckPolicy): AdvisoryFinding | null {
  if (gateMode(policy.qualityGateMode) !== "block") return null;
  const score = normalizeScore(policy.readinessScore);
  const minScore = normalizeScore(policy.qualityGateMinScore);
  if (score === null || minScore === null || score >= minScore) return null;
  return {
    code: "readiness_score_below_threshold",
    severity: "warning",
    title: "Readiness score is below the configured threshold",
    detail: `The public readiness score is ${score}/100, below the repository threshold of ${minScore}/100.`,
    action: "Address the short explicit PR panel actions, then re-run the gate.",
  };
}

function gateMode(value: GateRuleMode | null | undefined): GateRuleMode {
  return value === "off" || value === "block" ? value : "advisory";
}

function normalizeScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
