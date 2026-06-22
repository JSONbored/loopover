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
// Public-safe: most inputs are already safe by construction — the AI notes via
// `composeAdvisoryNotes`→`toPublicSafe`; the consensus-defect blocker via `toPublicSafe` (in
// `consensusDefectOf`); the signal rows via the panel helpers' `sanitizePanelText`. The ONE input not
// covered by an existing filter is the gate's `warnings` (rendered as Nits) — those carry an
// AdvisoryFinding's raw title/action, which the check-run path sanitizes (`sanitizeForCheckRun`) but this
// comment path historically did not. This module therefore scrubs Nits itself (see `publicSafeNit` /
// `PRIVATE_FORBIDDEN_TERMS`) as defense-in-depth before they reach a public comment.

import type { AdvisoryFinding, CheckSummaryRecord } from "../types";
import type { GateCheckConclusion, GateCheckEvaluation } from "../rules/advisory";
import type { PublicPrPanelSignalRow } from "../signals/engine";
// Single-source the panel marker from its canonical home (the upsert reads it there); re-export so existing
// importers of `PR_PANEL_COMMENT_MARKER` from this module keep working. The unified body MUST prepend this
// verbatim or `createOrUpdatePrIntelligenceComment` posts a DUPLICATE instead of updating in place.
import { PR_PANEL_COMMENT_MARKER } from "../github/comments";
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

export { PR_PANEL_COMMENT_MARKER };

// ── Public-safe defense-in-depth (privacy-critical) ──────────────────────────────────────────────
//
// Every field this bridge feeds into the renderer is ALREADY public-safe by construction on the live
// gittensory inputs (verified at convergence issue #1):
//   • panel rows (result/evidence) — built by buildPublicPrPanelSignalRows' panel helpers (public-safe);
//   • aiReview.notes — composed via composeAdvisoryNotes → toPublicSafe (drops anything unsafe);
//   • the consensus-defect title/detail — produced via toPublicSafe in consensusDefectOf.
// The ONE field whose inputs are NOT routed through an existing public-safe filter is the gate's
// `warnings` (turned into Nits): they carry an AdvisoryFinding's raw title/action. The gate/check-run
// path sanitizes those strings (sanitizeForCheckRun) before they reach GitHub, but this comment path
// did not. Rather than trust that every present and FUTURE warning finding is benign, scrub Nits with a
// boundary mirroring the check-run sanitizer + the legacy panel's private-term guard, and DROP a Nit
// that still trips the guard. This never alters flag-OFF (the legacy panel keeps its own filtering).
//
// Mirrors src/rules/advisory.ts CHECK_RUN_FORBIDDEN_TERMS (scrubbed → "[context]") and
// src/signals/engine.ts containsPrivatePublicTerm (drop if still present). Kept inline so this module
// stays a pure, dependency-light renderer-mapping seam.

const FAILED_CHECK_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

function isCompletedSuccessfulCheck(check: CheckSummaryRecord): boolean {
  return check.status.toLowerCase() === "completed" && (check.conclusion ?? "").toLowerCase() === "success";
}

/**
 * Build public merge-readiness from cached check summaries without allowing stale or partial CI to look green.
 * Only check summaries for the current PR head SHA are considered, and CI is green only when every current-head
 * check is completed successfully. Pending/in-progress checks, missing checks, or an unknown head SHA are
 * deliberately rendered as unverified.
 */
export function buildMergeReadinessFromChecks(input: {
  checks: readonly CheckSummaryRecord[];
  headSha?: string | null | undefined;
  mergeableState?: string | null | undefined;
}): MergeReadiness {
  const currentHead = input.headSha?.trim();
  const currentChecks = currentHead ? input.checks.filter((check) => check.headSha === currentHead) : [];
  const failedChecks = currentChecks.filter((check) => FAILED_CHECK_CONCLUSIONS.has((check.conclusion ?? "").toLowerCase()));
  const ciState: MergeReadiness["ciState"] =
    failedChecks.length > 0 ? "failed" : currentChecks.length > 0 && currentChecks.every(isCompletedSuccessfulCheck) ? "passed" : "unverified";

  return {
    ciState,
    ...(input.mergeableState ? { mergeStateLabel: input.mergeableState } : {}),
    ...(failedChecks.length > 0 ? { failingChecks: failedChecks.map((check) => check.name) } : {}),
  };
}

const PRIVATE_FORBIDDEN_TERMS =
  /\b(?:rewards?|payouts?|farming|estimated\s+scores?|raw\s+trust\s+scores?|trust\s+scores?|score\s+estimates?|reward\s+estimates?|wallets?|hotkeys?|coldkeys?|reviewability|scoreability|private\s+signals?|likely_duplicate|reviewability\s*\d)\b/gi;
const PRIVATE_DROP_TERMS = /\b(?:reward|payout|farming|wallet|hotkey|trust score|raw trust|estimated score|scoreability|likely_duplicate|reviewability\s*\d)\b/i;

/** Scrub forbidden terms from a contributor-facing Nit; return null to DROP it if it still leaks after
 *  scrubbing (fail-safe: never publish a line that names private rubric/scoring/reward internals). */
function publicSafeNit(line: string): string | null {
  const scrubbed = line.replace(PRIVATE_FORBIDDEN_TERMS, "[context]").replace(/\s+/g, " ").trim();
  if (!scrubbed) return null;
  return PRIVATE_DROP_TERMS.test(scrubbed) ? null : scrubbed;
}

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

/** A reviewer recommendation aligned with the gate verdict (advisory; the gate `decision` overrides it).
 *  Exported so the bridge unit tests can pin the gate-verdict → reviewer-recommendation mapping directly. */
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
  // Nits are the only renderer input not already routed through an existing public-safe filter (the gate's
  // raw warning findings). Scrub each with the private-term boundary and DROP any that still leaks. See
  // PRIVATE_FORBIDDEN_TERMS above. (Blockers come from the consensus defect, already public-safe via toPublicSafe.)
  const nits = (args.warnings ?? [])
    .map((warning) => `${warning.title}${warning.action ? ` — ${warning.action}` : ""}`.trim())
    .filter(Boolean)
    .map((line) => publicSafeNit(line))
    .filter((line): line is string => line !== null);
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

/**
 * Build the unified body for the CLOSED/SKIPPED case (the PR closed before full evaluation). This is the
 * unified-renderer analogue of the legacy `buildClosedPrPanelUpdate` "[!NOTE] Gittensory Gate skipped" panel,
 * routed through `buildUnifiedCommentBody` so a comment that started life as a unified OPEN-PR comment keeps
 * its unified shape (and the SAME marker) when the PR closes, instead of being overwritten by the legacy
 * panel under the shared marker. A synthetic `skipped` gate maps (via `gateConclusionToVerdict`) to the
 * `comment` verdict → `advisory` status, matching the legacy panel's non-blocking NOTE tone. No AI review,
 * no findings, and a single synthetic "Gate result — Skipped" signal row (the only signal we can assert for
 * a PR we never finished evaluating). Public-safe by construction: every string here is a static literal.
 */
export function buildClosedUnifiedCommentBody(args: { repoFullName: string; pullNumber: number; footerMarkdown: string }): string {
  const skippedGate: GateCheckEvaluation = {
    enabled: true,
    conclusion: "skipped",
    title: "Gittensory Gate skipped",
    summary: "PR closed before full evaluation. No late first comment was created.",
    blockers: [],
    warnings: [],
  };
  const gateRow: PublicPrPanelSignalRow = {
    key: "gateResult",
    cells: ["Gate result", "⚠️ Skipped", `${args.repoFullName}#${args.pullNumber} is no longer open.`, "No action."],
  };
  return buildUnifiedCommentBody({
    gate: skippedGate,
    panelRows: [gateRow],
    readinessTotal: 0,
    changedFiles: 0,
    reviewerCount: 0,
    footerMarkdown: args.footerMarkdown,
  });
}

/** Truthy-env flag check, matching the codebase convention (e.g. SCORING_TIME_DECAY_ENABLED). */
export function isUnifiedReviewCommentEnabled(env: { GITTENSORY_REVIEW_UNIFIED_COMMENT?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_UNIFIED_COMMENT ?? "");
}
