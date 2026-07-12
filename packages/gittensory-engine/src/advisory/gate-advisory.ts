import { randomUUID } from "node:crypto";
import type {
  Advisory,
  AdvisoryConclusion,
  AdvisoryFinding,
  AdvisorySeverity,
  GateRuleMode,
  IssueRecord,
  PullRequestRecord,
  RepositoryRecord,
} from "../types/predicted-gate-types.js";
import type { CollisionReport } from "../types/predicted-gate-types.js";
import { isDuplicateClusterWinnerByClaim } from "../signals/duplicate-winner.js";
import type { GuardrailPathMatch } from "../signals/change-guardrail.js";
import { nowIso } from "../utils/json.js";
import { LOOPOVER_GATE_CHECK_NAME } from "../review/check-names.js";
import { CLA_CHECK_UNRESOLVED_CODE, CLA_CONSENT_MISSING_CODE } from "../review/cla-check.js";
import { REVIEW_THREAD_BLOCKER_CODE } from "../review/review-thread-findings.js";
import { labelMatchesPattern } from "../scoring/label-match.js";

const CHECK_RUN_FORBIDDEN_TERMS =
  /\b(?:rewards?|payouts?|farming|estimated\s+scores?|raw\s+trust\s+scores?|trust\s+scores?|score\s+estimates?|reward\s+estimates?|wallets?|hotkeys?|coldkeys?|reviewability|scoreability|private\s+signals?)\b/gi;

function sanitizeForCheckRun(text: string): string {
  return text.replace(CHECK_RUN_FORBIDDEN_TERMS, "[context]").replace(/\s+/g, " ").trim();
}

const DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE = 0.93;
const DEFAULT_SLOP_BLOCK_THRESHOLD = 60;

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
  /** Minimum calibrated confidence (0-1) configured for AI close calibration. AI defect findings still BLOCK the
   *  gate under `aiReviewGateMode: block` even when below this floor — the floor never turns a real defect into a
   *  non-blocker on its own. What varies below the floor is {@link aiReviewLowConfidenceDisposition}. `null`/
   *  undefined ⇒ the 0.93 default. */
  aiReviewCloseConfidence?: number | null | undefined;
  /** Disposition for a sub-floor `ai_consensus_defect`/`ai_review_split` finding (#4603) — see the host copy's
   *  doc comment (`src/rules/advisory.ts` / `src/types.ts`) for the full semantics. `null`/undefined ⇒
   *  `hold_for_review` (the shipped default). Only `advisory_only` changes what `isConfiguredGateBlocker` returns
   *  for these codes here; `one_shot`/`hold_for_review` are indistinguishable to this predictor (the
   *  `hold_for_review` vs `one_shot` difference is a disposition-planner concern this predictor doesn't model). */
  aiReviewLowConfidenceDisposition?: "one_shot" | "hold_for_review" | "advisory_only" | undefined;
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
  /** Focus-manifest policy gate (#555). When `block`, linked-issue/test policy findings become hard blockers.
   *  Path-based manual-review holds are configured only with `settings.hardGuardrailGlobs`.
   *  An INDEPENDENT dimension, deliberately NOT folded into the merge-readiness composite so #555 stays focused.
   *  `off`/`advisory` = the findings stay advisory (never block). Default off. */
  manifestPolicyGateMode?: GateRuleMode | undefined;
  /** Self-authored linked-issue gate. When `block`, a `self_authored_linked_issue` finding — raised when
   *  the PR author also filed the linked issue — becomes a hard blocker. Defaults to `advisory` — the
   *  finding is surfaced but never blocks unless the maintainer opts in. */
  selfAuthoredLinkedIssueGateMode?: GateRuleMode | undefined;
  /** CLA / license-compatibility gate (#2564). When `block`, a `cla_consent_missing` finding — raised when
   *  neither configured detection method (a consent phrase in the PR body, or a named CLA-bot check-run
   *  conclusion) confirms consent — becomes a hard blocker. `off` (default) = no finding at all; `advisory` =
   *  the finding surfaces but never blocks. Independent of every other gate dimension, like manifestPolicy. */
  claGateMode?: GateRuleMode | undefined;
  /** First-time-contributor grace (#552). RESERVED / currently INERT (#2266): threaded through from config,
   *  but evaluateGateCheckCore never reads it (see the removal note below) — a would-be blocker gates a
   *  genuine newcomer exactly like a repeat contributor. Kept for potential future use. */
  firstTimeContributorGrace?: boolean | undefined;
  /** The PR author's merged PR count in THIS repo. RESERVED / currently INERT (#2266) alongside
   *  firstTimeContributorGrace above — populated but never read by the gate evaluator today. */
  authorMergedPrCount?: number | undefined;
  /** The PR author's closed-unmerged PR count in THIS repo. RESERVED / currently INERT (#2266) alongside
   *  firstTimeContributorGrace above — populated but never read by the gate evaluator today. */
  authorClosedUnmergedPrCount?: number | undefined;
  /** The PR author's confirmed-Gittensor status. Carried for context/telemetry only — it no longer
   *  changes the gate verdict (every author is gated identically; a configured blocker fails the gate
   *  regardless of confirmed status, which now affects only on-chain scoring). `undefined` = unresolved.
   *  (#gate-nonconfirmed) */
  confirmedContributor?: boolean | undefined;
  /** PR-size HOLD (#gate-size). When set (advisory/block), a PR with >= sizeGateMaxFiles changed files OR
   *  >= sizeGateMaxLines changed (added+deleted) lines that would OTHERWISE pass is HELD for manual review — a
   *  neutral gate → "manual" verdict, never auto-merged and never a hard failure. Defaults off; thresholds default
   *  to 10 files / 1000 lines. This is a HOLD (advisory dry-run friendly), not a close. */
  sizeGateMode?: GateRuleMode | undefined;
  /** Lockfile-tamper-risk gate (#2563). When `block`, a `lockfile_tamper_risk` finding (produced by
   *  review/lockfile-tamper.ts when a changed package-lock.json's resolved/integrity value changed without a
   *  matching package.json version bump, or points off the npm registry) becomes a hard blocker. Defaults to
   *  `off` — the finding is never produced when off, and never blocks under `advisory`. */
  lockfileIntegrityGateMode?: GateRuleMode | undefined;
  /** Aggregate change size, threaded from the resolved file list (changedLineCount = additions + deletions). */
  changedFileCount?: number | null | undefined;
  changedLineCount?: number | null | undefined;
  /** True when the PR's diff trips a configured hard guardrail path.
   *  A guardrail hit HOLDS an otherwise-passing gate for manual review (neutral → "manual"), never auto-merged.
   *  Empty/absent guardrail globs disable this path. (#gate-guardrail) */
  guardrailHit?: boolean | undefined;
  /** Matched changed paths/globs for the guardrail hold. Empty when the caller only knows "unknown path set"
   *  (fail-safe guardrail hit) rather than exact paths. */
  guardrailMatches?: GuardrailPathMatch[] | undefined;
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
    /** Same-account issue-avoidance countermeasure (#unlinked-issue-guardrail-followup): `pr.linkedIssues` is
     *  populated by a pure body-text regex that never checks whether the cited issue is actually OPEN, so a
     *  contributor can satisfy `linkedIssueGateMode: "block"` by citing an already-CLOSED (or fabricated)
     *  issue number. When the caller has live-verified that NONE of this PR's linked issue numbers resolve to
     *  a confirmed-open issue, it sets this true and `missing_linked_issue` fires exactly as if nothing were
     *  linked at all. Absent/false ⇒ byte-identical to today (presence alone still satisfies the requirement)
     *  — this is fail-open by construction: the caller only ever sets it true after a live check confirms
     *  every reference is dead, never on ambiguity. */
    confirmedNoOpenLinkedIssue?: boolean;
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
    addPullRequestFindings(repo, pr, findings, context.otherOpenPullRequests ?? [], Boolean(context.requireLinkedIssue), Boolean(context.duplicateWinnerEnabled), context.linkedIssueAuthorLogins ?? [], Boolean(context.confirmedNoOpenLinkedIssue));
  }
  return advisory("pull_request", targetKey, repoFullName, findings, "Pull request advisory generated.", pr?.number, undefined, pr?.headSha ?? undefined);
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
  confirmedNoOpenLinkedIssue: boolean,
): void {
  if (pr.state !== "open") {
    findings.push({
      code: "pr_not_open",
      severity: "info",
      title: "Pull request is not open",
      detail: `The pull request state is ${pr.state}.`,
    });
  }
  const noLinkedIssueCited = pr.linkedIssues.length === 0;
  if ((noLinkedIssueCited || confirmedNoOpenLinkedIssue) && requireLinkedIssue) {
    findings.push({
      code: "missing_linked_issue",
      severity: "warning",
      title: "No linked issue detected",
      detail: noLinkedIssueCited
        ? "No closing reference or linked issue number was found in the PR metadata/body."
        : "The PR cites an issue number, but it could not be verified as a currently open issue.",
      action: "If this PR is intended to solve an issue, link it explicitly in the PR body.",
    });
  } else {
    const overlappingPrs = otherOpenPullRequests.filter((otherPr) =>
      otherPr.linkedIssues.some((issueNumber) => pr.linkedIssues.includes(issueNumber)),
    );
    // Duplicate-winner adjudication (#dup-winner): when the flag is ON and this PR is the earliest observed
    // linked-issue claimant, SKIP the duplicate finding — suppressing it suppresses the gate failure, so the
    // winner survives while later claimants keep the finding. Sparse legacy rows fail closed instead of
    // suppressing duplicate evidence with arbitrary PR-number ordering.
    // Flag-OFF (default) short-circuits ⇒ the finding is pushed exactly as before (byte-identical).
    if (overlappingPrs.length > 0 && !(duplicateWinnerEnabled && isDuplicateClusterWinnerByClaim(pr, overlappingPrs))) {
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
  const multiplierPatterns = Object.keys(repo?.registryConfig?.labelMultipliers ?? {});
  const matchedLabels = pr.labels.filter((label) => multiplierPatterns.some((pattern) => labelMatchesPattern(label, pattern)));
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
  const title = conclusion === "success" ? "LoopOver advisory passed" : "LoopOver advisory available";
  return {
    id: randomUUID(),
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

const SIZE_HOLD_DEFAULT_MAX_FILES = 10;
const SIZE_HOLD_DEFAULT_MAX_LINES = 1000;

/** Oversized-PR manual-review HOLD finding (#gate-size), or null when the size gate is off or the PR is within both
 *  thresholds. A HOLD (→ neutral gate → "manual" verdict), never a hard blocker, so it is dry-run/advisory friendly. */
function buildSizeHoldFinding(policy: GateCheckPolicy): AdvisoryFinding | null {
  if (!policy.sizeGateMode || policy.sizeGateMode === "off") return null;
  let files = policy.changedFileCount;
  if (files === undefined || files === null) files = 0;
  let lines = policy.changedLineCount;
  if (lines === undefined || lines === null) lines = 0;
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

function buildGuardrailHoldFinding(matches: GuardrailPathMatch[] = []): AdvisoryFinding {
  const detail =
    matches.length > 0
      ? `This PR changes guardrail-protected path(s): ${matches
          .slice(0, 5)
          .map((match) => `\`${match.path}\` (matched \`${match.glob}\`)`)
          .join(", ")}${matches.length > 5 ? `, and ${matches.length - 5} more` : ""}.`
      : "This PR changes a guardrail-protected path, or the changed-file list could not be verified while guardrails are configured.";
  return {
    code: "guardrail_hold",
    severity: "warning",
    title: "Touches a guarded path — held for manual review",
    detail,
    action: "A maintainer must review and merge this change.",
  };
}

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
  if (advisoryResult.findings.some((finding) => isEvaluationBlocker(finding.code, policy))) {
    return {
      enabled: true,
      conclusion: "neutral",
      title: `${LOOPOVER_GATE_CHECK_NAME} — not evaluated yet`,
      summary: "LoopOver has not finished syncing this repo/PR. The gate stays advisory and re-evaluates automatically; no action is needed.",
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
  // Non-confirmed contributors are gated NORMALLY (real blockers → failure → one-shot close; clean → success →
  // merge), the SAME as confirmed contributors: the review + CI + guardrail vet every PR, and confirmed-status
  // affects only on-chain SCORING, never the merge/close decision. (#gate-nonconfirmed) The old blanket
  // "never block a non-confirmed contributor" forced every non-confirmed PR with a blocker to a neutral → HELD
  // state, burying the maintainer in manual review. The old first-time-contributor grace path also softened
  // blockers; that is intentionally no longer applied because blocker findings must remain closure/rejection
  // outcomes for normal contributors. Owner/automation close exemptions live in the disposition planner instead.
  if (blockers.length === 0) {
    // Fail-CLOSED AI hold (#ai-fail-closed, #audit-3.5): with NO deterministic blocker, a block-mode AI review
    // that could not return a usable verdict HOLDS the gate (neutral) for a human rather than passing
    // automatically — NEVER a failure, so a contributor PR is never auto-CLOSED because a model hiccupped. This
    // is evaluated AFTER the deterministic blockers above, so a real violation (secret_leak, duplicate,
    // missing-issue, slop, quality) still blocks: an inconclusive AI can no longer bury a blocked PR in a hold.
    if (advisoryResult.findings.some((finding) => finding.code === "ai_review_inconclusive")) {
      return {
        enabled: true,
        conclusion: "neutral",
        title: `${LOOPOVER_GATE_CHECK_NAME} — held for human review`,
        summary: "The AI review could not be completed for this change, so the gate is held for a human reviewer rather than passed automatically. It re-evaluates on the next update.",
        blockers: [],
        warnings: gateWarnings,
      };
    }
    // Manual-review HOLD (#gate-size / #gate-guardrail): a PR that would otherwise PASS but is oversized or touches
    // a guarded path is HELD for a human (neutral → "manual" verdict) rather than auto-approved — never a failure,
    // so neutral never blocks the merge (dry-run/advisory friendly) and a contributor PR is never auto-closed for size.
    const sizeHold = buildSizeHoldFinding(effective);
    const guardrailHold = effective.guardrailHit ? buildGuardrailHoldFinding(effective.guardrailMatches) : null;
    const holds = [sizeHold, guardrailHold].filter(
      (f): f is AdvisoryFinding => f !== null,
    );
    if (holds.length > 0) {
      return {
        enabled: true,
        conclusion: "neutral",
        title: `${LOOPOVER_GATE_CHECK_NAME} — held for manual review`,
        summary: holds.map((h) => sanitizeForCheckRun(h.title)).join("; "),
        blockers: [],
        warnings: [...gateWarnings, ...holds],
      };
    }
    return {
      enabled: true,
      conclusion: "success",
      title: `${LOOPOVER_GATE_CHECK_NAME} passed`,
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
    title: `${LOOPOVER_GATE_CHECK_NAME}: ${titleDetail}`,
    summary: blockers
      .map((finding) => `${sanitizeForCheckRun(finding.title)}${finding.action ? ` — ${sanitizeForCheckRun(finding.action)}` : ""}`)
      .join("; "),
    blockers,
    warnings: [...advisoryResult.findings.filter((finding) => finding.severity === "warning" && !blockers.includes(finding)), ...(qualityWarning ? [qualityWarning] : [])],
  };
}

function isEvaluationBlocker(code: string, policy: GateCheckPolicy): boolean {
  // pre_merge_check_unresolved: an enforced path-gated pre-merge check whose changed-file set could not be
  // resolved — gittensory cannot evaluate it yet, so the gate is NEUTRAL (held) and re-evaluates on the next
  // sync, rather than auto-merging past the unverified requirement or hard-closing on a transient miss. (#review-audit)
  if (code === "repo_not_registered" || code === "repo_not_seen" || code === "pr_not_cached" || code === "pre_merge_check_unresolved") return true;
  // cla_check_unresolved (#2564): the CLA-bot check-run's conclusion could not be resolved. Unlike the codes
  // above (which are never mode-gated), evaluateClaCheck runs for BOTH claGateMode "advisory" and "block" (so
  // the finding surfaces either way) — only "block" should ever HOLD the gate on an unresolved check-run.
  // "advisory" mode's whole contract is "surface findings, never affect the verdict"; unconditionally holding
  // here would violate that for any advisory-mode repo using check-run-only detection (#2564 gate-review
  // finding). advisory mode still gets the finding in the panel via the normal warnings path below.
  if (code === CLA_CHECK_UNRESOLVED_CODE) return policy.claGateMode === "block";
  return false;
}

function gatePolicyBlocks(mode: GateRuleMode | undefined, defaultMode: GateRuleMode): boolean {
  return gateMode(mode ?? defaultMode) === "block";
}

function isConfiguredGateBlocker(finding: AdvisoryFinding, policy: GateCheckPolicy): boolean {
  const code = finding.code;
  // Missing linked issue defaults to ADVISORY — issues aren't always available, so it only blocks when a
  // repo explicitly opts in with linkedIssueGateMode: "block". Duplicates still default to blocking.
  if (code === "missing_linked_issue") return gatePolicyBlocks(policy.linkedIssueGateMode, "advisory");
  if (code === "duplicate_pr_risk") return gatePolicyBlocks(policy.duplicatePrGateMode, "block");
  // A dual-model AI consensus defect blocks ONLY when the maintainer opted into aiReview: block. It is the
  // most conservative AI signal (two independent models) but still confirmed-contributor gated by
  // evaluateGateCheck, and advisory by default.
  // A consensus defect (both reviewers) OR a SPLIT (one reviewer flagged a blocker the other did not) both block
  // when aiReviewGateMode is `block`. (#ai-review-split) The close-confidence floor + disposition (#4603, mirrors
  // the host copy in src/rules/advisory.ts -- this predictor package doesn't thread aiReviewLowConfidenceDisposition
  // through predicted-gate.ts's own policy-building call yet, same deliberate partial-wiring precedent as
  // linkedIssueSatisfactionGateMode, so this branch only ever sees the default `hold_for_review` here today) decide
  // what happens to a SUB-floor finding: `one_shot`/`hold_for_review` both still block here; only `advisory_only`
  // demotes a sub-floor finding to a non-blocker.
  if (code === "ai_consensus_defect" || code === "ai_review_split") {
    if (!gatePolicyBlocks(policy.aiReviewGateMode, "advisory")) return false;
    if ((policy.aiReviewLowConfidenceDisposition ?? "hold_for_review") === "advisory_only") {
      const floor = policy.aiReviewCloseConfidence ?? DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE;
      const confidence = finding.confidence ?? 1;
      if (confidence < floor) return false;
    }
    return true;
  }
  if (code === REVIEW_THREAD_BLOCKER_CODE) return true;
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
  // Focus-manifest missing-tests policy (#555): blocks ONLY when the maintainer opts into manifestPolicy:
  // block. Path holds are intentionally separate and configured via hardGuardrailGlobs.
  if (code === "manifest_missing_tests") {
    return gatePolicyBlocks(policy.manifestPolicyGateMode, "off");
  }
  // Focus-manifest linked-issue policy (#555, #4618): blocks when EITHER the manifest-policy gate OR the
  // linked-issue gate is opted into block. resolveEffectiveSettings promotes linkedIssueGateMode to "block"
  // whenever the yml-only `linkedIssuePolicy: required` knob is set (mirroring the requireLinkedIssue
  // promotion), so this finding's own escalation must honor that gate too -- not just manifestPolicyGateMode
  // -- or the promotion would have no actual blocking effect and the config-surface-reduction fix would be a
  // no-op.
  if (code === "manifest_linked_issue_required") {
    return gatePolicyBlocks(policy.manifestPolicyGateMode, "off") || gatePolicyBlocks(policy.linkedIssueGateMode, "advisory");
  }
  // Self-authored linked-issue gate: blocks only when the maintainer opts in with `block`. Defaults to
  // advisory — the finding surfaces in the panel without ever closing the PR unless explicitly configured.
  if (code === "self_authored_linked_issue") return gatePolicyBlocks(policy.selfAuthoredLinkedIssueGateMode, "advisory");
  // Lockfile-tamper-risk gate (#2563): blocks only when the maintainer opts in with `block`. Defaults to `off`
  // (the finding is never even produced — see maybeAddLockfileTamperFinding's mode gate in queue/processors.ts),
  // so this branch only matters once a repo has explicitly turned the scan on.
  if (code === "lockfile_tamper_risk") return gatePolicyBlocks(policy.lockfileIntegrityGateMode, "off");
  // CLA / license-compatibility gate (#2564): blocks only when the maintainer opts into claMode: block.
  // Defaults to off (evaluateClaCheck never even runs for an off repo, so the finding does not exist).
  if (code === CLA_CONSENT_MISSING_CODE) return gatePolicyBlocks(policy.claGateMode, "off");
  return false;
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

/** @internal Exported for unit tests of advisory severity wiring. */
export const gateAdvisoryInternals = {
  advisory,
  highestSeverity,
  conclusionForSeverity,
  buildSizeHoldFinding,
  buildGuardrailHoldFinding,
  promoteAdvisoryToBlock,
  isConfiguredGateBlocker,
  buildQualityGateWarning,
  buildSlopGateBlocker,
  gateMode,
  gatePolicyBlocks,
};
