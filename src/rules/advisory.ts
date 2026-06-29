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
import { isDuplicateClusterWinner } from "../signals/duplicate-winner";
import { nowIso } from "../utils/json";
import { GITTENSORY_GATE_CHECK_NAME } from "../review/check-names";

export type GateCheckConclusion = "success" | "failure" | "action_required" | "neutral" | "skipped";

export type GateCheckPolicy = {
  linkedIssueGateMode?: GateRuleMode | undefined;
  duplicatePrGateMode?: GateRuleMode | undefined;
  /** Historical readiness-score mode. Retained for config compatibility, but readiness is informational only:
   *  a low readiness score may be surfaced as an advisory warning and must never fail the Gate check. */
  qualityGateMode?: GateRuleMode | undefined;
  qualityGateMinScore?: number | null | undefined;
  /** When `block`, a dual-model AI consensus defect (`ai_consensus_defect` finding) becomes a hard
   *  blocker. Defaults to advisory — AI never blocks unless the maintainer opts in. */
  aiReviewGateMode?: GateRuleMode | undefined;
  /** Minimum calibrated confidence (0-1) for an AI-judgment defect (`ai_consensus_defect` / `ai_review_split`) to
   *  BLOCK under `aiReviewGateMode: block` (#7). The finding blocks only when its `confidence >= this`; below-threshold
   *  AI defects hold for human review instead of passing or auto-closing. `null`/undefined ⇒ the 0.93 default. A finding
   *  with no confidence (deterministic, or a graceful-fallback AI defect) is treated as 1.0 and always clears the floor
   *  — matching the historical always-block behavior. */
  aiReviewCloseConfidence?: number | null | undefined;
  readinessScore?: number | null | undefined;
  /** When `block`, the deterministic slop score becomes a hard blocker once `slopRisk >= slopGateMinScore`
   *  (default threshold 60, the `high` band). Defaults to off/advisory — slop never blocks unless opted in. */
  slopGateMode?: GateRuleMode | undefined;
  slopGateMinScore?: number | null | undefined;
  slopRisk?: number | null | undefined;
  /** Master "merge-readiness" composite (#551). When set (advisory/block) it OVERRIDES all four sub-gates —
   *  linked-issue, duplicate, quality/readiness, slop — to its mode, so a maintainer flips ONE switch instead
   *  of four and the review-agent check stays the single required check. `off` = sub-gates use their own modes. */
  mergeReadinessGateMode?: GateRuleMode | undefined;
  /** Focus-manifest policy gate (#555). When `block`, linked-issue/test policy findings become hard blockers;
   *  blocked-path findings become manual-review holds because guardrailed paths should be reviewed, not closed.
   *  An INDEPENDENT dimension, deliberately NOT folded into the merge-readiness composite so #555 stays focused.
   *  `off`/`advisory` = the findings stay advisory (never block). Default off. */
  manifestPolicyGateMode?: GateRuleMode | undefined;
  /** Self-authored linked-issue gate. When `block`, a `self_authored_linked_issue` finding — raised when
   *  the PR author also filed the linked issue — becomes a hard blocker. Defaults to `advisory` — the
   *  finding is surfaced but never blocks unless the maintainer opts in. */
  selfAuthoredLinkedIssueGateMode?: GateRuleMode | undefined;
  /** First-time-contributor grace (#552). When true AND the author is a genuine newcomer (0 merged PRs in
   *  this repo) who is NOT a repeat offender (< 3 closed-unmerged PRs), a would-be BLOCK is softened to a
   *  neutral/advisory gate. `undefined`/false = the grace rule does not apply and blockers gate normally. */
  firstTimeContributorGrace?: boolean | undefined;
  /** The PR author's merged PR count in THIS repo (newcomer = 0). Used only by the grace rule. */
  authorMergedPrCount?: number | undefined;
  /** The PR author's closed-unmerged PR count in THIS repo (repeat offender = >= 3). Used only by grace. */
  authorClosedUnmergedPrCount?: number | undefined;
  /** The PR author's confirmed-Gittensor status. Carried for context/telemetry only — it no longer
   *  changes the gate verdict (every author is gated identically; a configured blocker fails the gate
   *  regardless of confirmed status, which now affects only on-chain scoring). `undefined` = unresolved.
   *  (#gate-nonconfirmed) */
  confirmedContributor?: boolean | undefined;
  /** PR-size HOLD (#gate-size). When set (advisory/block), a PR with >= sizeGateMaxFiles changed files OR
   *  >= sizeGateMaxLines changed (added+deleted) lines that would OTHERWISE pass is HELD for manual review — a
   *  neutral gate → "manual" verdict, never auto-merged and never a hard failure. Defaults off; thresholds default
   *  to 10 files / 500 lines. This is a HOLD (advisory dry-run friendly), not a close. */
  sizeGateMode?: GateRuleMode | undefined;
  /** Aggregate change size, threaded from the resolved file list (changedLineCount = additions + deletions). */
  changedFileCount?: number | null | undefined;
  changedLineCount?: number | null | undefined;
  /** True when the PR's diff trips a hard guardrail path (caller computes via loadHardGuardrailGlobs + isGuardrailHit).
   *  A guardrail hit HOLDS an otherwise-passing gate for manual review (neutral → "manual"), never auto-merged.
   *  Always-on (the guardrail globs default to the crucial/config-as-code/engine paths). (#gate-guardrail) */
  guardrailHit?: boolean | undefined;
  /** Dry-run disposition (#gate-dryrun). When true, the gate ALSO computes the would-be conclusion with every
   *  `advisory` sub-gate promoted to `block` and exposes it as `displayConclusion` (the rendered merge/close/manual
   *  verdict), WITHOUT changing the posted, non-enforcing `conclusion`. Lets advisory mode show exactly what it WOULD
   *  do (close/merge/manual) before the maintainer flips to real enforcement. Default off. */
  dryRun?: boolean | undefined;
};

export type GateCheckEvaluation = {
  enabled: boolean;
  conclusion: GateCheckConclusion;
  /** Dry-run only (#gate-dryrun): the would-be conclusion (advisory sub-gates promoted to block) used to render the
   *  merge/close/manual verdict. Absent ⇒ the renderer falls back to `conclusion`. Never affects what is posted. */
  displayConclusion?: GateCheckConclusion | undefined;
  title: string;
  summary: string;
  blockers: AdvisoryFinding[];
  warnings: AdvisoryFinding[];
};

// AI-JUDGMENT blocker codes (#ai-ci-refutation): a gate failure driven SOLELY by these is the dual-model AI
// reviewer's OPINION, not a deterministic fact. Shared by the disposition refutation (agent-actions) and the
// public-comment reconciliation so the merge/close ACTION and the rendered comment always agree.
// `ai_review_inconclusive` is deliberately EXCLUDED — that is a "could not review" HOLD, not a false defect.
export const AI_JUDGMENT_BLOCKER_CODES = new Set<string>(["ai_consensus_defect", "ai_review_split"]);

/** True when the gate FAILED *solely* because of AI-judgment blockers (every blocker is an AI-judgment code).
 *  An empty blocker list is NOT an AI-judgment-only failure (there is nothing to refute). PURE. */
export function isAiJudgmentOnlyFailure(evaluation: GateCheckEvaluation): boolean {
  return evaluation.conclusion === "failure" && evaluation.blockers.length > 0 && evaluation.blockers.every((blocker) => AI_JUDGMENT_BLOCKER_CODES.has(blocker.code));
}

/**
 * Reconcile a gate evaluation with the deterministic CI for the PUBLIC review comment (#ai-ci-refutation).
 * When the gate FAILED solely on an AI-judgment blocker (ai_consensus_defect / ai_review_split) but the real CI
 * is GREEN, the AI claim is refuted by the validator — so the comment must render SUCCESS (advisory), matching
 * the disposition (planAgentMaintenanceActions merges such a PR) instead of a contradictory red "blocked/closed"
 * headline + Gate row. The AI concern stays VISIBLE without double-listing: the specific consensus defect still
 * surfaces from the advisory findings as a raised concern under the green verdict, so we only clear the gate's
 * hard blockers here. `enabled` is the caller's grounding+convergence gate (passed in so this stays a PURE,
 * unit-testable function and the processor carries no branch); `enabled` false, `ciState !== "passed"`, or a
 * non-AI-only failure ⇒ the evaluation is returned UNCHANGED.
 */
export function reconcileGateEvaluationForGreenCi(evaluation: GateCheckEvaluation, ciState: "passed" | "failed" | "unverified", enabled: boolean): GateCheckEvaluation {
  if (!enabled || ciState !== "passed" || !isAiJudgmentOnlyFailure(evaluation)) return evaluation;
  return {
    ...evaluation,
    conclusion: "success",
    title: `${GITTENSORY_GATE_CHECK_NAME} passed`,
    summary: "The AI review raised a concern, but the deterministic checks (CI) are green — the concern is advisory, not blocking.",
    blockers: [],
  };
}

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
  context: {
    otherOpenPullRequests?: PullRequestRecord[];
    requireLinkedIssue?: boolean;
    /** Duplicate-winner adjudication (#dup-winner). When true AND this PR is the cluster winner (the lowest
     *  open sibling number), the `duplicate_pr_risk` finding is suppressed so the winner is not gate-blocked /
     *  closed as a duplicate. Default/false ⇒ every duplicate sibling keeps the finding (byte-identical). The
     *  caller sets this to `env.GITTENSORY_DUPLICATE_WINNER === "true"`. */
    duplicateWinnerEnabled?: boolean;
    /** Author logins of the linked issues (one entry per resolved issue, may be null when unknown). Used to
     *  surface a `self_authored_linked_issue` finding when the PR author also opened the linked issue. Absent
     *  or empty ⇒ the finding is never raised (fail-open: unknown issue authorship stays advisory-only). */
    linkedIssueAuthorLogins?: (string | null | undefined)[];
  } = {},
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
    addPullRequestFindings(repo, pr, findings, context.otherOpenPullRequests ?? [], Boolean(context.requireLinkedIssue), Boolean(context.duplicateWinnerEnabled), context.linkedIssueAuthorLogins ?? []);
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

const SIZE_HOLD_DEFAULT_MAX_FILES = 10;
const SIZE_HOLD_DEFAULT_MAX_LINES = 500;

/** Oversized-PR manual-review HOLD finding (#gate-size), or null when the size gate is off or the PR is within both
 *  thresholds. A HOLD (→ neutral gate → "manual" verdict), never a hard blocker, so it is dry-run/advisory friendly. */
function buildSizeHoldFinding(policy: GateCheckPolicy): AdvisoryFinding | null {
  if (!policy.sizeGateMode || policy.sizeGateMode === "off") return null;
  const files = policy.changedFileCount ?? 0;
  const lines = policy.changedLineCount ?? 0;
  if (
    files < SIZE_HOLD_DEFAULT_MAX_FILES &&
    lines < SIZE_HOLD_DEFAULT_MAX_LINES
  )
    return null;
  return {
    code: "oversized_pr",
    severity: "warning",
    title: "Large change — held for manual review",
    detail: `This PR changes ${files} file(s) / ${lines} line(s) (hold threshold: ${SIZE_HOLD_DEFAULT_MAX_FILES} files or ${SIZE_HOLD_DEFAULT_MAX_LINES} lines).`,
    action: "Split this into smaller, focused PRs, or a maintainer reviews and merges it manually.",
  };
}

/** Guardrail-path manual-review HOLD finding (#gate-guardrail). A HOLD (neutral gate), never a hard blocker. */
function buildGuardrailHoldFinding(): AdvisoryFinding {
  return {
    code: "guardrail_hold",
    severity: "warning",
    title: "Touches a guarded path — held for manual review",
    detail: "This PR changes a guardrail-protected path, so it is held for a maintainer to review and merge manually.",
    action: "A maintainer must review and merge this change.",
  };
}

function buildManifestBlockedPathHoldFinding(
  findings: AdvisoryFinding[],
  policy: GateCheckPolicy,
): AdvisoryFinding | null {
  if (gateMode(policy.manifestPolicyGateMode ?? "off") !== "block")
    return null;
  const blocked = findings.find(
    (finding) => finding.code === "manifest_blocked_path",
  );
  if (!blocked) return null;
  return {
    code: "manifest_blocked_path",
    severity: "warning",
    title: "Touches a maintainer-blocked path — held for manual review",
    detail:
      "This PR changes a maintainer-blocked path, so it is held for a maintainer to review and merge manually.",
    action: "A maintainer must review and merge this change.",
    ...(blocked.publicText !== undefined ? { publicText: blocked.publicText } : {}),
  };
}

/** Dry-run disposition (#gate-dryrun): promote every `advisory` sub-gate mode to `block` so the core eval yields the
 *  would-be conclusion. `off`/`block`/unset modes are untouched; non-mode policy (grace, size HOLD, guardrail) is
 *  preserved as-is, so the would-be verdict still honours newcomer grace and the manual-review holds. PURE. */
function promoteAdvisoryToBlock(policy: GateCheckPolicy): GateCheckPolicy {
  // #disposition-redesign: the dry-run "would-be" verdict must reflect the REAL disposition model — a CLOSE is driven by
  // the AI reviewer's confidence + genuine hard blockers (secret/CI/banned) ONLY. The advisory signals — missing linked
  // issue, readiness/quality, slop, duplicates, manifest policy, self-authored issue — are NEVER close drivers, so they
  // are deliberately NOT promoted here. Only the AI sub-gate is promoted, so an `advisory` AI defect still previews its
  // would-be close while a missing linked issue or a low readiness score can never render a "close" verdict.
  const block = (mode: GateRuleMode | undefined): GateRuleMode | undefined => (mode === "advisory" ? "block" : mode);
  return {
    ...policy,
    dryRun: false,
    aiReviewGateMode: block(policy.aiReviewGateMode),
  };
}

/** Public entry. In normal mode this is exactly `evaluateGateCheckCore`. In dry-run mode (#gate-dryrun) it ALSO runs
 *  the core eval with advisory sub-gates promoted to block and attaches that as `displayConclusion` — the would-be
 *  merge/close/manual verdict — while the POSTED `conclusion` stays the real, non-enforcing one. */
export function evaluateGateCheck(advisoryResult: Advisory, policy: GateCheckPolicy = {}): GateCheckEvaluation {
  const result = evaluateGateCheckCore(advisoryResult, policy);
  if (!policy.dryRun) return result;
  const wouldBe = evaluateGateCheckCore(advisoryResult, promoteAdvisoryToBlock(policy));
  return { ...result, displayConclusion: wouldBe.conclusion };
}

function evaluateGateCheckCore(advisoryResult: Advisory, policy: GateCheckPolicy = {}): GateCheckEvaluation {
  const warnings = advisoryResult.findings.filter((finding) => finding.severity === "warning");
  // App/infra state (repo not synced yet, PR not cached): gittensory cannot evaluate this PR yet, so the
  // gate is NEUTRAL (non-blocking) and re-evaluates automatically on the next sync/webhook. Never block a
  // contributor on the app's OWN state.
  if (advisoryResult.findings.some((finding) => isEvaluationBlocker(finding.code))) {
    return {
      enabled: true,
      conclusion: "neutral",
      title: `${GITTENSORY_GATE_CHECK_NAME} — not evaluated yet`,
      summary: "Gittensory has not finished syncing this repo/PR. The gate stays advisory and re-evaluates automatically; no action is needed.",
      blockers: [],
      warnings,
    };
  }
  // Merge-readiness composite (#551): when set, escalate enforceable sub-gates to its mode so they roll into one
  // pass/fail. Readiness/quality stays advisory-only.
  const effective = applyMergeReadinessGate(policy);
  const configuredBlockers = advisoryResult.findings.filter((finding) => isConfiguredGateBlocker(finding, effective));
  const qualityWarning = buildQualityGateWarning(effective);
  const slopBlocker = buildSlopGateBlocker(effective);
  const blockers = [...configuredBlockers, ...(slopBlocker ? [slopBlocker] : [])];
  const gateWarnings = qualityWarning ? [...warnings, qualityWarning] : warnings;
  const lowConfidenceAiHolds = advisoryResult.findings.filter((finding) => isLowConfidenceAiReviewHold(finding, effective));
  // Non-confirmed contributors are gated NORMALLY (real blockers → failure → one-shot close; clean → success →
  // merge), the SAME as confirmed contributors: the review + CI + guardrail vet every PR, and confirmed-status
  // affects only on-chain SCORING, never the merge/close decision. (#gate-nonconfirmed) The old blanket
  // "never block a non-confirmed contributor" forced every non-confirmed PR with a blocker to a neutral → HELD
  // state, burying the maintainer in manual review. Genuine newcomers stay protected by the opt-in first-time-
  // contributor grace immediately below; everyone else is auto-merged/closed so the queue stays automated.
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
      title: `${GITTENSORY_GATE_CHECK_NAME} — first-contribution grace`,
      summary: "This is a first-time contribution to this repo, so the gate stays advisory rather than blocking. The findings remain visible, and the gate will apply normally once this author has merge history here.",
      blockers: [],
      warnings: gateWarnings,
    };
  }
  if (blockers.length === 0) {
    if (lowConfidenceAiHolds.length > 0) {
      return {
        enabled: true,
        conclusion: "neutral",
        title: `${GITTENSORY_GATE_CHECK_NAME} — held for human review`,
        summary: "The AI review flagged a possible must-fix defect below the automatic close-confidence floor, so the gate is held for a human reviewer instead of passed automatically.",
        blockers: [],
        warnings: [...gateWarnings, ...lowConfidenceAiHolds],
      };
    }
    // Fail-CLOSED AI hold (#ai-fail-closed, #audit-3.5): with NO deterministic blocker, a block-mode AI review
    // that could not return a usable verdict HOLDS the gate (neutral) for a human rather than passing
    // automatically — NEVER a failure, so a contributor PR is never auto-CLOSED because a model hiccupped. This
    // is evaluated AFTER the deterministic blockers above, so a real violation (secret_leak, duplicate,
    // missing-issue, slop, quality) still blocks: an inconclusive AI can no longer bury a blocked PR in a hold.
    if (advisoryResult.findings.some((finding) => finding.code === "ai_review_inconclusive")) {
      return {
        enabled: true,
        conclusion: "neutral",
        title: `${GITTENSORY_GATE_CHECK_NAME} — held for human review`,
        summary: "The AI review could not be completed for this change, so the gate is held for a human reviewer rather than passed automatically. It re-evaluates on the next update.",
        blockers: [],
        warnings: gateWarnings,
      };
    }
    // Manual-review HOLD (#gate-size / #gate-guardrail): a PR that would otherwise PASS but is oversized or touches
    // a guarded path is HELD for a human (neutral → "manual" verdict) rather than auto-approved — never a failure,
    // so neutral never blocks the merge (dry-run/advisory friendly) and a contributor PR is never auto-closed for size.
    const sizeHold = buildSizeHoldFinding(effective);
    const guardrailHold = effective.guardrailHit ? buildGuardrailHoldFinding() : null;
    const manifestBlockedPathHold = buildManifestBlockedPathHoldFinding(
      advisoryResult.findings,
      effective,
    );
    const holds = [sizeHold, guardrailHold, manifestBlockedPathHold].filter(
      (f): f is AdvisoryFinding => f !== null,
    );
    if (holds.length > 0) {
      return {
        enabled: true,
        conclusion: "neutral",
        title: `${GITTENSORY_GATE_CHECK_NAME} — held for manual review`,
        summary: holds.map((h) => sanitizeForCheckRun(h.title)).join("; "),
        blockers: [],
        warnings: [...gateWarnings, ...holds],
      };
    }
    return {
      enabled: true,
      conclusion: "success",
      title: `${GITTENSORY_GATE_CHECK_NAME} passed`,
      summary: "No configured hard blocker was found. Advisory findings, if any, stay advisory.",
      blockers,
      warnings: gateWarnings,
    };
  }
  // Name the exact blocker(s) + fix in the title so the contributor sees WHY at a glance.
  const firstBlocker = blockers[0];
  const titleDetail = blockers.length === 1 && firstBlocker ? sanitizeForCheckRun(firstBlocker.title) : `${blockers.length} blockers`;
  return {
    enabled: true,
    conclusion: "failure",
    title: `${GITTENSORY_GATE_CHECK_NAME}: ${titleDetail}`,
    summary: blockers
      .map((finding) => `${sanitizeForCheckRun(finding.title)}${finding.action ? ` — ${sanitizeForCheckRun(finding.action)}` : ""}`)
      .join("; "),
    blockers,
    warnings: [...advisoryResult.findings.filter((finding) => finding.severity === "warning" && !blockers.includes(finding)), ...(qualityWarning ? [qualityWarning] : [])],
  };
}

export function formatGateCheckOutput(gate: GateCheckEvaluation): { title: string; summary: string; text: string } {
  if (gate.conclusion === "success") {
    return {
      title: gate.title,
      summary: `${GITTENSORY_GATE_CHECK_NAME} is advisory-first. This PR has no configured hard blocker.`,
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
    summary: `${GITTENSORY_GATE_CHECK_NAME} found a repo-configured hard blocker.`,
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
  duplicateWinnerEnabled: boolean,
  linkedIssueAuthorLogins: (string | null | undefined)[],
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
    // Duplicate-winner adjudication (#dup-winner): when the flag is ON and this PR is the cluster winner (the
    // lowest open sibling number), SKIP the duplicate finding — suppressing it suppresses the gate failure, so
    // the winner survives while the losers (which still see overlap > 0 and a lower sibling) keep the finding.
    // `overlappingPrs` is derived from the OPEN-only `otherOpenPullRequests`, so the numbers are open siblings.
    // Flag-OFF (default) short-circuits ⇒ the finding is pushed exactly as before (byte-identical).
    if (overlappingPrs.length > 0 && !(duplicateWinnerEnabled && isDuplicateClusterWinner(pr.number, overlappingPrs.map((otherPr) => otherPr.number)))) {
      findings.push({
        code: "duplicate_pr_risk",
        severity: "warning",
        title: "Linked issue overlaps another open PR",
        detail: `Other open pull requests reference the same linked issue set: ${overlappingPrs.map((otherPr) => `#${otherPr.number}`).join(", ")}.`,
        action: "Review the related PRs before spending reviewer time on duplicate work.",
      });
    }
  }
  // Self-authored linked-issue detection: the PR author also filed the linked issue. Raised when at least
  // one linked issue's author login is a case-insensitive match for the PR author. Gated by
  // selfAuthoredLinkedIssueGateMode — advisory by default so this never blocks without maintainer opt-in.
  // Absent/null issue author logins are treated as unknown and never trigger the finding (fail-open).
  if (pr.linkedIssues.length > 0 && pr.authorLogin) {
    const prAuthor = pr.authorLogin.toLowerCase();
    const selfAuthored = linkedIssueAuthorLogins.some((login) => login != null && login.toLowerCase() === prAuthor);
    if (selfAuthored) {
      findings.push({
        code: "self_authored_linked_issue",
        severity: "warning",
        title: "PR author also opened the linked issue",
        detail: "The contributor who opened this PR also filed the linked issue. This pattern can indicate artificial issue-discovery work rather than solving an independently discovered problem.",
        action: "Link an issue that was opened by a different contributor, or provide a rationale for why this self-authored issue represents genuine discovery work.",
      });
    }
  }
  if (otherOpenPullRequests.length >= 10) {
    findings.push({
      code: "busy_pr_queue",
      severity: "info",
      title: "Review queue is busy",
      detail: `Gittensory has ${otherOpenPullRequests.length} other open pull requests cached for this repository.`,
      publicText: "This repo has a busy review queue in the local Gittensory cache.",
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
  // pre_merge_check_unresolved: an enforced path-gated pre-merge check whose changed-file set could not be
  // resolved — gittensory cannot evaluate it yet, so the gate is NEUTRAL (held) and re-evaluates on the next
  // sync, rather than auto-merging past the unverified requirement or hard-closing on a transient miss. (#review-audit)
  return code === "repo_not_registered" || code === "repo_not_seen" || code === "pr_not_cached" || code === "pre_merge_check_unresolved";
}

// Default minimum calibrated confidence for an AI defect to BLOCK (#7) — used when the repo set `aiReview: block`
// without a `closeConfidence`. 0.93 = block only on a high-confidence AI defect; below that stays advisory.
const DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE = 0.93;

function isConfiguredGateBlocker(finding: AdvisoryFinding, policy: GateCheckPolicy): boolean {
  const code = finding.code;
  // Missing linked issue defaults to ADVISORY — issues aren't always available, so it only blocks when a
  // repo explicitly opts in with linkedIssueGateMode: "block". Duplicates still default to blocking.
  if (code === "missing_linked_issue") return gateMode(policy.linkedIssueGateMode ?? "advisory") === "block";
  if (code === "duplicate_pr_risk") return gateMode(policy.duplicatePrGateMode ?? "block") === "block";
  // A dual-model AI consensus defect blocks ONLY when the maintainer opted into aiReview: block. It is the
  // most conservative AI signal (two independent models) but still confirmed-contributor gated by
  // evaluateGateCheck, and advisory by default.
  // A consensus defect (both reviewers) OR a SPLIT (one reviewer flagged a blocker the other did not) both block
  // when aiReviewGateMode is `block` AND the finding's CALIBRATED confidence clears the close-confidence floor (#7).
  // Below-floor AI defects are handled as a neutral human-review HOLD in evaluateGateCheckCore: the LLM-provided
  // confidence must never turn a concrete AI defect into an auto-mergeable passing gate. A finding with no confidence
  // (graceful fallback) is treated as 1.0 and always clears the floor — byte-identical to today's behavior. (#ai-review-split)
  if (code === "ai_consensus_defect" || code === "ai_review_split") {
    if (gateMode(policy.aiReviewGateMode ?? "advisory") !== "block") return false;
    const confidence = finding.confidence ?? 1;
    return confidence >= (policy.aiReviewCloseConfidence ?? DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
  }
  // A leaked-secret finding (`secret_leak`) ALWAYS hard-blocks: a committed credential must be removed and
  // rotated before merge, with no opt-in. This finding is produced ONLY by the flag-gated safety scan
  // (GITTENSORY_REVIEW_SAFETY); when the flag is off the finding never exists, so this branch is unreachable and the
  // gate verdict is byte-identical to today.
  if (code === "secret_leak") return true;
  // A maintainer pre-merge check (#review-pre-merge-checks) marked `enforce: true` produces this DETERMINISTIC
  // finding when it fails (a required title/description phrase or label is missing). It always blocks: the
  // per-check `enforce` flag in `.gittensory.yml` IS the opt-in (mirroring secret_leak — the finding only exists
  // when the maintainer configured an enforced check). The advisory variant (`pre_merge_check_failed`) is a plain
  // warning and is never blocked here. No AI judgment is involved, so this can never cause an AI false-close.
  if (code === "pre_merge_check_required") return true;
  // Focus-manifest policy (#555): linked-issue/test policy findings block ONLY when the maintainer opts into
  // manifestPolicy: block. Blocked paths are guardrails, so they are handled as manual-review holds above.
  if (code === "manifest_linked_issue_required" || code === "manifest_missing_tests") {
    return gateMode(policy.manifestPolicyGateMode ?? "off") === "block";
  }
  // Self-authored linked-issue gate: blocks only when the maintainer opts in with `block`. Defaults to
  // advisory — the finding surfaces in the panel without ever closing the PR unless explicitly configured.
  if (code === "self_authored_linked_issue") return gateMode(policy.selfAuthoredLinkedIssueGateMode ?? "advisory") === "block";
  return false;
}

function isLowConfidenceAiReviewHold(finding: AdvisoryFinding, policy: GateCheckPolicy): boolean {
  if (!AI_JUDGMENT_BLOCKER_CODES.has(finding.code)) return false;
  if (gateMode(policy.aiReviewGateMode ?? "advisory") !== "block") return false;
  const confidence = finding.confidence ?? 1;
  return confidence < (policy.aiReviewCloseConfidence ?? DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
}

function buildQualityGateWarning(policy: GateCheckPolicy): AdvisoryFinding | null {
  if (gateMode(policy.qualityGateMode) === "off") return null;
  const score = normalizeScore(policy.readinessScore);
  const minScore = normalizeScore(policy.qualityGateMinScore);
  if (score === null || minScore === null || score >= minScore) return null;
  return {
    code: "readiness_score_below_threshold",
    severity: "warning",
    title: "Readiness score is below the configured threshold",
    detail: `The public readiness score is ${score}/100, below the repository threshold of ${minScore}/100.`,
    action: "Use the readiness panel as advisory maintainer context; the score does not block this PR.",
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
// OVERRIDES the enforceable sub-gates to its mode so they roll into one pass/fail; when off, the policy is
// returned unchanged and each sub-gate keeps its own mode. Readiness/quality is intentionally excluded:
// readiness is always advisory/informational, even if an older config still says `readiness: block`.
function applyMergeReadinessGate(policy: GateCheckPolicy): GateCheckPolicy {
  const composite = gateMode(policy.mergeReadinessGateMode ?? "off");
  if (composite === "off") return policy;
  return {
    ...policy,
    linkedIssueGateMode: composite,
    duplicatePrGateMode: composite,
    slopGateMode: composite,
  };
}

function normalizeScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
