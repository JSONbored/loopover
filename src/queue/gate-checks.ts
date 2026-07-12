// Gate-check policy resolution and publish/audit bookkeeping (#4013 step 8 -- extracted from
// processors.ts, eighth step of the file's own module-split sequence, after transient-locks.ts,
// signal-snapshot.ts, duplicate-detection.ts, slop-detection.ts, review-evasion.ts, ci-resolution.ts, and
// retention.ts). Pure move -- these three functions were never physically adjacent in the original file
// (interspersed with unrelated linked-issue/pre-merge-check/public-surface helpers that stay behind), but
// share no state and have no caller besides processors.ts's own many disposition/publish call sites, so
// they group cleanly by concern here.

import { recordAuditEvent, upsertCheckSummary } from "../db/repositories";
import { LOOPOVER_GATE_CHECK_NAME } from "../github/app";
import { guardrailPathMatches } from "../signals/change-guardrail";
import type { RepositorySettings } from "../types";
import { nowIso } from "../utils/json";

// Intentionally writes to check_summaries only, not audit_events (#2908): this fires on every successful gate-
// check publish, which is a very high-frequency event (every review pass, potentially several times per PR as
// it iterates) -- check_summaries is the purpose-built, already-queryable canonical record for "when was this
// check published and what did it conclude" (repo/PR/headSha/checkRunId/conclusion/detailsUrl), so a parallel
// audit_events row would roughly double that table's volume for no new queryable information. The DOWNSTREAM
// actions this verdict triggers (merge/close/hold) are already fully audited via recordNativeGateDecision and
// agent-action-executor's audit() closure. Only the FAILURE/degraded sub-paths of the caller below are audited
// (auditGateCheckPermissionMissing, auditPrVisibilitySkip) -- that asymmetry is deliberate, not a gap.
export async function recordPublishedGateCheckSummary(
  env: Env,
  args: {
    repoFullName: string;
    pullNumber: number;
    headSha: string | null | undefined;
    checkRunId: number;
    conclusion: string | null | undefined;
    detailsUrl?: string | undefined;
    deliveryId: string;
  },
): Promise<void> {
  /* v8 ignore next -- createOrUpdateNamedCheckRun returns null without a head SHA, so published results have one. */
  if (!args.headSha) return;
  const completedAt = nowIso();
  await upsertCheckSummary(env, {
    id: String(args.checkRunId),
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    headSha: args.headSha,
    name: LOOPOVER_GATE_CHECK_NAME,
    status: "completed",
    /* v8 ignore next -- Gate publication always supplies a conclusion; this keeps the DB value defensive. */
    conclusion: args.conclusion ?? null,
    startedAt: null,
    completedAt,
    ...(args.detailsUrl ? { detailsUrl: args.detailsUrl } : {}),
    payload: {
      deliveryId: args.deliveryId,
      source: "gittensory_gate_check",
    },
  });
}

export function gateCheckPolicy(
  settings: RepositorySettings,
  readinessScore?: number | null,
  confirmedContributor?: boolean,
  slopRisk?: number | null,
  authorHistory?: { mergedPrCount: number; closedUnmergedPrCount: number },
  sizeContext?: {
    changedFileCount: number;
    changedLineCount: number;
    guardrailHit: boolean;
    guardrailMatches?: ReturnType<typeof guardrailPathMatches> | undefined;
  },
) {
  // `settings` is already the EFFECTIVE config (`.gittensory.yml` > DB > defaults), resolved upstream by
  // resolveRepositorySettings, so the blocker modes here reflect the repo's config file directly.
  // The `oss-anti-slop` pack (#692) is repo-agnostic and carries no confirmed-contributor field at all (no
  // Gittensor coupling). The `gittensor` pack still threads confirmedContributor for context/telemetry, but
  // it no longer changes the verdict — every author is gated identically. (#gate-nonconfirmed)
  const confirmedContributorForPack =
    settings.gatePack === "oss-anti-slop" ? undefined : confirmedContributor;
  return {
    linkedIssueGateMode: settings.linkedIssueGateMode,
    duplicatePrGateMode: settings.duplicatePrGateMode,
    qualityGateMode: settings.qualityGateMode,
    qualityGateMinScore: settings.qualityGateMinScore ?? null,
    aiReviewGateMode: settings.aiReviewMode,
    // Calibrated AI close-confidence floor (#7) — config-as-code via `.gittensory.yml gate.aiReview.closeConfidence`,
    // resolved into settings upstream. `null`/undefined ⇒ advisory.ts applies the 0.93 default.
    aiReviewCloseConfidence: settings.aiReviewCloseConfidence ?? null,
    // Sub-floor AI-judgment disposition (#4603) — DB-backed (dashboard-settable) + `.gittensory.yml
    // gate.aiReview.lowConfidenceDisposition` override, resolved into settings upstream. `null`/undefined ⇒
    // advisory.ts applies the "hold_for_review" default.
    aiReviewLowConfidenceDisposition: settings.aiReviewLowConfidenceDisposition ?? null,
    readinessScore: readinessScore ?? null,
    slopGateMode: settings.slopGateMode,
    mergeReadinessGateMode: settings.mergeReadinessGateMode,
    manifestPolicyGateMode: settings.manifestPolicyGateMode,
    selfAuthoredLinkedIssueGateMode: settings.selfAuthoredLinkedIssueGateMode,
    linkedIssueSatisfactionGateMode: settings.linkedIssueSatisfactionGateMode,
    firstTimeContributorGrace: settings.firstTimeContributorGrace,
    authorMergedPrCount: authorHistory?.mergedPrCount,
    authorClosedUnmergedPrCount: authorHistory?.closedUnmergedPrCount,
    slopGateMinScore: settings.slopGateMinScore ?? null,
    slopRisk: slopRisk ?? null,
    confirmedContributor: confirmedContributorForPack,
    // PR-size + guardrail manual-review HOLD (#gate-size / #gate-guardrail): the MODE comes from config; the
    // thresholds default to 10 files / 1000 lines (advisory.ts constants); the live counts + guardrail-hit come from
    // the per-PR sizeContext threaded by the caller.
    sizeGateMode: settings.sizeGateMode,
    lockfileIntegrityGateMode: settings.lockfileIntegrityGateMode,
    changedFileCount: sizeContext?.changedFileCount ?? null,
    changedLineCount: sizeContext?.changedLineCount ?? null,
    guardrailHit: sizeContext?.guardrailHit ?? false,
    guardrailMatches: sizeContext?.guardrailMatches,
    // CLA / license-compatibility gate (#2564): the MODE comes from config; the `cla_consent_missing` finding
    // itself (or its absence) is pushed into the advisory upstream by evaluateClaCheck, so this only decides
    // whether isConfiguredGateBlocker escalates it to a hard blocker.
    claGateMode: settings.claGateMode,
    // #gate-dryrun: render the would-be merge/close/manual verdict (advisory promoted to block) without enforcing.
    dryRun: settings.gateDryRun ?? false,
  };
}

export async function auditGateCheckPermissionMissing(
  env: Env,
  actor: string | null,
  repoFullName: string,
  pullNumber: number,
  deliveryId: string,
  warning: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.gate_check_permission_missing",
    actor,
    targetKey: `${repoFullName}#${pullNumber}`,
    outcome: "error",
    detail: warning,
    metadata: { deliveryId, repoFullName },
  });
  // Surface the install-wide Checks:write gap to Sentry — until the scope is granted the required gate check-run
  // silently never posts on ANY PR for this install; an operator must SEE this config fault, not just the ledger.
  console.error(JSON.stringify({ level: "error", event: "gate_check_permission_missing", message: warning, repository: repoFullName, pullNumber, deliveryId }));
}
