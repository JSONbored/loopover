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
  /** When `block`, a dual-model AI consensus defect (`ai_consensus_defect` finding) becomes a hard
   *  blocker. Defaults to advisory — AI never blocks unless the maintainer opts in. */
  aiReviewGateMode?: GateRuleMode | undefined;
  readinessScore?: number | null | undefined;
  /** When `block`, the deterministic slop score becomes a hard blocker once `slopRisk >= slopGateMinScore`
   *  (default threshold 60, the `high` band). Defaults to off/advisory — slop never blocks unless opted in. */
  slopGateMode?: GateRuleMode | undefined;
  slopGateMinScore?: number | null | undefined;
  slopRisk?: number | null | undefined;
  /** Master "merge-readiness" composite (#551). When set (advisory/block) it OVERRIDES all four sub-gates —
   *  linked-issue, duplicate, quality/readiness, slop — to its mode, so a maintainer flips ONE switch instead
   *  of four and `Gittensory Gate` stays the single required check. `off` = sub-gates use their own modes. */
  mergeReadinessGateMode?: GateRuleMode | undefined;
  /** Focus-manifest policy gate (#555). When `block`, the focus manifest's declared policy findings —
   *  `manifest_blocked_path`, `manifest_linked_issue_required`, `manifest_missing_tests` — become hard
   *  blockers. An INDEPENDENT dimension, deliberately NOT folded into the merge-readiness composite so #555
   *  stays focused. `off`/`advisory` = the findings stay advisory (never block). Default off. */
  manifestPolicyGateMode?: GateRuleMode | undefined;
  /** First-time-contributor grace (#552). When true AND the author is a genuine newcomer (0 merged PRs in
   *  this repo) who is NOT a repeat offender (< 3 closed-unmerged PRs), a would-be BLOCK is softened to a
   *  neutral/advisory gate. `undefined`/false = the grace rule does not apply and blockers gate normally. */
  firstTimeContributorGrace?: boolean | undefined;
  /** The PR author's merged PR count in THIS repo (newcomer = 0). Used only by the grace rule. */
  authorMergedPrCount?: number | undefined;
  /** The PR author's closed-unmerged PR count in THIS repo (repeat offender = >= 3). Used only by grace. */
  authorClosedUnmergedPrCount?: number | undefined;
  /** ONLY confirmed gittensor contributors can be hard-blocked. When explicitly `false`, the gate is
   *  forced to a neutral (non-blocking) conclusion regardless of blockers — gittensory must never block
   *  a non-confirmed contributor. `undefined` = the caller did not gate on contributor status. */
  confirmedContributor?: boolean | undefined;
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

export function isTestPath(path: string): boolean {
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

const ANNOTATABLE_PR_FILE_STATUSES = new Set(["added", "changed", "modified"]);

export function firstAddedLineFromPatch(patch: string): number | null {
  for (const line of patch.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match?.[1]) return Math.max(1, Number.parseInt(match[1], 10));
  }
  return null;
}

function annotationLineForFile(file: PullRequestFileRecord): number | null {
  if (file.additions <= 0) return null;
  const status = file.status?.toLowerCase();
  if (status && !ANNOTATABLE_PR_FILE_STATUSES.has(status)) return null;
  const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
  const addedLine = firstAddedLineFromPatch(patch);
  if (addedLine !== null) return addedLine;
  return status === "added" || !status ? 1 : null;
}

function annotatablePullRequestFiles(files: PullRequestFileRecord[]): PullRequestFileRecord[] {
  return files.filter((file) => file.path && isCodePath(file.path) && annotationLineForFile(file) !== null);
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

  const annotatableFiles = annotatablePullRequestFiles(annotationContext.files);
  const codeFiles = annotatableFiles.filter((file) => !isTestPath(file.path));
  const testFiles = annotatableFiles.filter((file) => isTestPath(file.path));
  if (codeFiles.length > 0 && testFiles.length === 0) {
    for (const file of codeFiles) {
      addCandidate(
        file.path,
        annotationLineForFile(file) ?? 1,
        "warning",
        "Missing test evidence",
        "Code changed without an obvious test file in this PR. Add focused tests or explain why existing coverage is sufficient.",
      );
    }
  }

  for (const cluster of collisionClustersForPull(annotationContext.collisions, annotationContext.pullNumber)) {
    const level: CheckRunAnnotation["annotation_level"] = cluster.risk === "high" ? "warning" : "notice";
    for (const file of annotatableFiles) {
      addCandidate(file.path, annotationLineForFile(file) ?? 1, level, "Possible duplicate overlap", cluster.reason);
    }
  }

  const changedPaths = annotatableFiles.map((file) => file.path);
  for (const finding of advisoryResult.findings) {
    if (!finding.publicText) continue;
    const targets = changedPaths.length > 0 ? changedPaths : [];
    for (const path of targets) {
      addCandidate(
        path,
        annotationLineForFile(annotatableFiles.find((file) => file.path === path)!) ?? 1,
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
  const warnings = advisoryResult.findings.filter((finding) => finding.severity === "warning");
  // App/infra state (repo not synced yet, PR not cached): gittensory cannot evaluate this PR yet, so the
  // gate is NEUTRAL (non-blocking) and re-evaluates automatically on the next sync/webhook. Never block a
  // contributor on the app's OWN state.
  if (advisoryResult.findings.some((finding) => isEvaluationBlocker(finding.code))) {
    return {
      enabled: true,
      conclusion: "neutral",
      title: "Gittensory Gate — not evaluated yet",
      summary: "Gittensory has not finished syncing this repo/PR. The gate stays advisory and re-evaluates automatically; no action is needed.",
      blockers: [],
      warnings,
    };
  }
  // Merge-readiness composite (#551): when set, escalate every sub-gate to its mode so they roll into one
  // pass/fail. When off, this is a no-op and each sub-gate keeps its own mode.
  const effective = applyMergeReadinessGate(policy);
  const configuredBlockers = advisoryResult.findings.filter((finding) => isConfiguredGateBlocker(finding.code, effective));
  const qualityBlocker = buildQualityGateBlocker(effective);
  const slopBlocker = buildSlopGateBlocker(effective);
  const blockers = [...configuredBlockers, ...(qualityBlocker ? [qualityBlocker] : []), ...(slopBlocker ? [slopBlocker] : [])];
  // Contributor-gated: ONLY confirmed Gittensor contributors can be hard-blocked. For everyone else the
  // gate is neutral (non-blocking) + the minimal advisory comment — gittensory must never block a
  // non-confirmed contributor, regardless of what blockers fired.
  if (effective.confirmedContributor === false && blockers.length > 0) {
    return {
      enabled: true,
      conclusion: "neutral",
      title: "Gittensory Gate — advisory only",
      summary: "The PR author is not a confirmed Gittensor contributor, so gittensory does not block this PR. Findings stay advisory.",
      blockers: [],
      warnings,
    };
  }
  // First-time-contributor grace (#552): when the maintainer opted in, a genuine newcomer (0 merged PRs in
  // this repo) who is NOT a repeat offender (< 3 closed-unmerged PRs) gets a neutral, non-blocking gate even
  // when blockers fired — they keep the advisory findings without the hard block. Repeat offenders, authors
  // with merge history, and repos with the setting off are gated normally below. Public-safe: this only
  // expresses advisory-vs-block, never any reward/trust internals.
  const isNewcomer = (effective.authorMergedPrCount ?? 0) === 0;
  const isRepeatOffender = (effective.authorClosedUnmergedPrCount ?? 0) >= 3;
  const graceApplies = effective.firstTimeContributorGrace === true && isNewcomer && !isRepeatOffender;
  if (graceApplies && blockers.length > 0) {
    return {
      enabled: true,
      conclusion: "neutral",
      title: "Gittensory Gate — first-contribution grace",
      summary: "This is a first-time contribution to this repo, so the gate stays advisory rather than blocking. The findings remain visible, and the gate will apply normally once this author has merge history here.",
      blockers: [],
      warnings,
    };
  }
  if (blockers.length === 0) {
    return {
      enabled: true,
      conclusion: "success",
      title: "Gittensory Gate passed",
      summary: "No configured hard blocker was found. Advisory findings, if any, stay advisory.",
      blockers,
      warnings,
    };
  }
  // Name the exact blocker(s) + fix in the title so the contributor sees WHY at a glance.
  const firstBlocker = blockers[0];
  const titleDetail = blockers.length === 1 && firstBlocker ? sanitizeForCheckRun(firstBlocker.title) : `${blockers.length} blockers`;
  return {
    enabled: true,
    conclusion: "failure",
    title: `Gittensory Gate: ${titleDetail}`,
    summary: blockers
      .map((finding) => `${sanitizeForCheckRun(finding.title)}${finding.action ? ` — ${sanitizeForCheckRun(finding.action)}` : ""}`)
      .join("; "),
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
      title: gate.title.slice(0, 255),
      summary: gate.summary,
      text: "Gittensory did not create a contributor-facing failure for this event.",
    };
  }
  const blockerLines = gate.blockers.slice(0, 8).map((finding) => {
    const action = finding.action ? ` Action: ${sanitizeForCheckRun(finding.action)}` : "";
    return `- ${sanitizeForCheckRun(finding.title)}.${action}`;
  });
  return {
    // GitHub's check-run output.title 422s when too long; cap it (matches the 255 cap used for annotations).
    // An unbounded title (e.g. when failing-check names are appended) threw a 422 that aborted the ENTIRE
    // review before the comment, audit, and auto-action — so red-CI PRs were never reviewed or closed.
    title: gate.title.slice(0, 255),
    summary: "Gittensory Gate found a repo-configured hard blocker.",
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
  // Missing linked issue defaults to ADVISORY — issues aren't always available, so it only blocks when a
  // repo explicitly opts in with linkedIssueGateMode: "block". Duplicates still default to blocking.
  if (code === "missing_linked_issue") return gateMode(policy.linkedIssueGateMode ?? "advisory") === "block";
  if (code === "duplicate_pr_risk") return gateMode(policy.duplicatePrGateMode ?? "block") === "block";
  // A dual-model AI consensus defect blocks ONLY when the maintainer opted into aiReview: block. It is the
  // most conservative AI signal (two independent models, high confidence) but still confirmed-contributor
  // gated by evaluateGateCheck, and advisory by default.
  if (code === "ai_consensus_defect") return gateMode(policy.aiReviewGateMode ?? "advisory") === "block";
  // A leaked-secret finding (`secret_leak`) ALWAYS hard-blocks: a committed credential must be removed and
  // rotated before merge, with no opt-in. This finding is produced ONLY by the flag-gated safety scan
  // (GITTENSORY_REVIEW_SAFETY); when the flag is off the finding never exists, so this branch is unreachable and the
  // gate verdict is byte-identical to today.
  if (code === "secret_leak") return true;
  // Focus-manifest policy (#555): the three enforceable manifest findings block ONLY when the maintainer
  // opts into manifestPolicy: block. Default off/advisory keeps them advisory-only.
  if (code === "manifest_blocked_path" || code === "manifest_linked_issue_required" || code === "manifest_missing_tests") {
    return gateMode(policy.manifestPolicyGateMode ?? "off") === "block";
  }
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

// Default block threshold = the `high` band (60), used when a maintainer sets slop: block without a minScore.
const DEFAULT_SLOP_BLOCK_THRESHOLD = 60;

function buildSlopGateBlocker(policy: GateCheckPolicy): AdvisoryFinding | null {
  if (gateMode(policy.slopGateMode) !== "block") return null;
  const risk = normalizeScore(policy.slopRisk);
  if (risk === null) return null;
  const minScore = normalizeScore(policy.slopGateMinScore) ?? DEFAULT_SLOP_BLOCK_THRESHOLD;
  if (risk < minScore) return null;
  return {
    code: "slop_risk_above_threshold",
    severity: "warning",
    title: "Slop risk is above the configured threshold",
    detail: `The deterministic slop risk is ${risk}/100, at or above the repository threshold of ${minScore}/100.`,
    action: "Reduce whitespace-only churn, add test evidence, or describe the change, then re-run the gate.",
  };
}

function gateMode(value: GateRuleMode | null | undefined): GateRuleMode {
  return value === "off" || value === "block" ? value : "advisory";
}

// #551: the master merge-readiness composite. When mergeReadinessGateMode is set (advisory/block) it
// OVERRIDES the four sub-gates to its mode so they roll into one pass/fail; when off, the policy is returned
// unchanged and each sub-gate keeps its own mode.
function applyMergeReadinessGate(policy: GateCheckPolicy): GateCheckPolicy {
  const composite = gateMode(policy.mergeReadinessGateMode ?? "off");
  if (composite === "off") return policy;
  return {
    ...policy,
    linkedIssueGateMode: composite,
    duplicatePrGateMode: composite,
    qualityGateMode: composite,
    slopGateMode: composite,
  };
}

function normalizeScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
