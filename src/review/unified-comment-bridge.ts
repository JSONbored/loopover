// Unified-comment bridge (reviewbot→gittensory convergence, Stage D).
//
// A PURE, testable mapping from gittensory's live PR-review data (the gate `GateCheckEvaluation`, the AI
// `advisoryNotes` + consensus defect, the readiness signal rows + total, the footer) onto the ported
// unified renderer (`renderUnifiedReviewComment`). Flag-gated and default-OFF in the processor; flag-OFF
// keeps the legacy `buildPublicPrIntelligenceComment` path byte-identical.
//
// gittensory's GATE stays authoritative: we pass the gate-derived `decision` into `buildUnifiedReviewInput`
// so `deriveUnifiedStatus` lets it override the reviewer recommendations (the renderer already enforces
// this). The output PREPENDS the exact panel marker the legacy body carries, so the existing in-place
// upsert (`createOrUpdatePrIntelligenceComment`) updates the same comment instead of posting a duplicate.
//
// This module is pure (no I/O, no redaction). The caller applies gittensory's public-safe handling the
// same way it does for the legacy body. The data fed in is already public-safe by construction (the AI
// notes via `composeAdvisoryNotes`→`toPublicSafe`; the gate blockers via `sanitizeForCheckRun`; the signal
// rows via the panel helpers' `sanitizePanelText`).

import type { AdvisoryFinding } from "../types";
import type { GateCheckConclusion, GateCheckEvaluation } from "../rules/advisory";
import type { PublicPrPanelSignalRow } from "../signals/engine";
import {
  buildUnifiedReviewInput,
  renderUnifiedReviewComment,
  type DualReviewNote,
  type MergeReadiness,
  type ReviewNotes,
  type ReviewRecommendation,
  type UnifiedCollapsible,
  type UnifiedSignalRow,
  type Verdict,
} from "./unified-comment";

/** The exact marker the legacy panel carries (engine.ts `buildPublicPrIntelligenceComment` /
 *  `comments.ts` PR_PANEL_COMMENT_MARKER). The unified body MUST prepend this verbatim or the upsert
 *  posts a DUPLICATE instead of updating in place. */
export const PR_PANEL_COMMENT_MARKER = "<!-- gittensory-pr-panel:v1 -->";

/** Map gittensory's gate conclusion to the renderer's authoritative `Verdict`.
 *  success → merge · failure → close · action_required/neutral → manual · skipped → comment. */
export function gateConclusionToVerdict(conclusion: GateCheckConclusion): Verdict {
  switch (conclusion) {
    case "success":
      return "merge";
    case "failure":
      return "close";
    case "action_required":
    case "neutral":
      return "manual";
    case "skipped":
      return "comment";
  }
}

/** A reviewer recommendation aligned with the gate verdict (advisory; the gate `decision` overrides it). */
export function verdictToRecommendation(verdict: Verdict): ReviewRecommendation {
  switch (verdict) {
    case "merge":
      return "merge";
    case "close":
      return "close";
    case "manual":
      return "manual_review";
    case "comment":
    case "ignore":
      return "manual_review";
  }
}

/** Derive an ok/warn/fail state from a legacy panel result cell's leading status icon (✅/⚠️/❌). */
function rowState(resultCell: string): UnifiedSignalRow["state"] {
  if (resultCell.startsWith("✅")) return "ok";
  if (resultCell.startsWith("❌")) return "fail";
  return "warn";
}

/** Strip the leading status icon from a result cell so it is not duplicated next to the unified icon. */
function rowResultText(resultCell: string): string {
  return resultCell.replace(/^[✅⚠️❌]+\s*/u, "").trim();
}

/** Map the legacy panel signal rows → the unified table's rows (label/state/result/evidence). The
 *  unified renderer adds its own "Code review" row first; these follow it (gittensory's gate row included). */
export function panelRowsToSignalRows(rows: PublicPrPanelSignalRow[]): UnifiedSignalRow[] {
  return rows.map((row) => {
    const [label, result, evidence] = row.cells;
    return { label, state: rowState(result), result: rowResultText(result), evidence };
  });
}

/** Build the single AI reviewer note from gittensory's AI output: the composed advisory write-up becomes
 *  the assessment; a consensus defect (recovered from the advisory findings) becomes a blocker; the gate's
 *  non-blocking warnings become nits. Returns `[]` when there is nothing reviewer-side to surface (no AI
 *  notes, no consensus defect) so the renderer hides the reviewer chip. The gate `decision` (passed
 *  separately) stays authoritative over `recommendation` — this is advisory framing only. */
export function buildDualReviewNotes(args: {
  aiReview?: { notes: string } | undefined;
  consensusDefect?: { title: string; detail: string } | undefined;
  warnings?: AdvisoryFinding[] | undefined;
  recommendation: ReviewRecommendation;
  verdict: Verdict;
  reviewerModel?: string;
}): DualReviewNote[] {
  const assessment = args.aiReview?.notes?.trim() ?? "";
  const blockers = args.consensusDefect ? [`${args.consensusDefect.title}${args.consensusDefect.detail ? `: ${args.consensusDefect.detail}` : ""}`.trim()] : [];
  const nits = (args.warnings ?? []).map((warning) => `${warning.title}${warning.action ? ` — ${warning.action}` : ""}`.trim()).filter(Boolean);
  if (!assessment && blockers.length === 0 && nits.length === 0) return [];
  const notes: ReviewNotes = {
    assessment,
    suggestions: [],
    risks: [],
    verdict: args.verdict,
    recommendation: args.recommendation,
    confidence: 0.9,
    blockers,
    nits,
  };
  return [{ model: args.reviewerModel ?? "Gittensory AI review", notes }];
}

/** Recover a consensus defect (the dual-model agreement the gate already folded into its findings) from
 *  the advisory findings so the bridge can surface it as a structured blocker. */
export function consensusDefectFromFindings(findings: AdvisoryFinding[] | undefined): { title: string; detail: string } | undefined {
  const found = (findings ?? []).find((finding) => finding.code === "ai_consensus_defect");
  if (!found) return undefined;
  return { title: found.title, detail: found.detail };
}

export type UnifiedCommentBridgeArgs = {
  /** gittensory's authoritative gate verdict (drives the unified status + the Gate row). */
  gate: GateCheckEvaluation;
  /** The AI maintainer-review advisory notes (already public-safe), if any. */
  aiReview?: { notes: string } | undefined;
  /** The advisory findings — the bridge recovers the `ai_consensus_defect` consensus blocker from here. */
  advisoryFindings?: AdvisoryFinding[] | undefined;
  /** The legacy panel readiness signal rows (from `buildPublicPrPanelSignalRows`). */
  panelRows: PublicPrPanelSignalRow[];
  /** Which rows the maintainer kept visible (`.gittensory.yml review.fields`); a key set to `false` is hidden. */
  reviewFields?: Partial<Record<PublicPrPanelSignalRow["key"], boolean>> | undefined;
  /** The gittensory readiness total (0–100) → the readiness chip. */
  readinessTotal: number;
  /** Number of changed files reviewed. */
  changedFiles: number;
  /** Number of independent AI reviewers synthesized (0 hides the reviewer chip/row evidence count). */
  reviewerCount?: number | undefined;
  /** CI + merge-state readiness, when the caller resolved it (gittensory's panel omits it today). */
  mergeReadiness?: MergeReadiness | undefined;
  /** Whether the PR was auto-merged (only changes the ready-state verdict wording). */
  merged?: boolean | undefined;
  /** The footer markdown (earn CTA + attribution) — rendered under a divider. */
  footerMarkdown: string;
  /** The re-run checkbox label. */
  reRunLabel?: string | undefined;
  /** Extra collapsed sections (e.g. signal definitions / contributor next steps). */
  extraCollapsibles?: UnifiedCollapsible[] | undefined;
  /** Headline brand (default "Gittensory review"). */
  brand?: string | undefined;
};

/**
 * Build the unified PR-review comment body from gittensory's live data. Returns a string that STARTS with
 * the panel marker (so the existing upsert updates in place) followed by the rendered unified comment.
 * The gate verdict is authoritative: it is passed as `decision` so the renderer's `deriveUnifiedStatus`
 * lets it override the reviewer recommendation.
 */
export function buildUnifiedCommentBody(args: UnifiedCommentBridgeArgs): string {
  const verdict = gateConclusionToVerdict(args.gate.conclusion);
  const consensusDefect = consensusDefectFromFindings(args.advisoryFindings);
  const reviews = buildDualReviewNotes({
    aiReview: args.aiReview,
    consensusDefect,
    warnings: args.gate.warnings,
    recommendation: verdictToRecommendation(verdict),
    verdict,
  });
  const input = buildUnifiedReviewInput({
    changedFiles: args.changedFiles,
    reviews,
    decision: verdict,
    ...(args.mergeReadiness !== undefined ? { readiness: args.mergeReadiness } : {}),
    ...(args.merged !== undefined ? { merged: args.merged } : {}),
  });
  // The gate already produced 0/1 reviewer notes from a synthesis of the model pair; reflect the caller's
  // actual reviewer count (for the chip + the "N reviewers, synthesized" evidence) without re-deriving it.
  if (typeof args.reviewerCount === "number") input.reviewerCount = args.reviewerCount;

  // Honor `.gittensory.yml review.fields` row visibility, exactly as the legacy panel does.
  const visibleRows = args.panelRows.filter((row) => args.reviewFields?.[row.key] !== false);
  const signals = panelRowsToSignalRows(visibleRows);

  const body = renderUnifiedReviewComment(input, {
    brand: args.brand ?? "Gittensory review",
    readinessScore: args.readinessTotal,
    signals,
    footerMarkdown: args.footerMarkdown,
    ...(args.reRunLabel !== undefined ? { reRunLabel: args.reRunLabel } : {}),
    ...(args.extraCollapsibles !== undefined ? { extraCollapsibles: args.extraCollapsibles } : {}),
  });

  // Prepend the marker verbatim (matching the legacy body, which leads with the marker then a blank line)
  // so `createOrUpdatePrIntelligenceComment` finds and updates the SAME comment in place.
  return `${PR_PANEL_COMMENT_MARKER}\n\n${body}`;
}

/** Truthy-env flag check, matching the codebase convention (e.g. SCORING_TIME_DECAY_ENABLED). */
export function isUnifiedReviewCommentEnabled(env: { UNIFIED_REVIEW_COMMENT?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.UNIFIED_REVIEW_COMMENT ?? "");
}
