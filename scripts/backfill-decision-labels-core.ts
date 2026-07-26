// Backfill the risk-control calibration set from decision history (#8828 epic follow-through) — PURE core.
//
// The risk-control guarantee (#8835) needs adjudicated (confidence, correct?) pairs, and until 2026-07-26
// decision records did not persist confidence — but ai_review_cache has retained per-finding confidence
// since 2026-06-28, and review_audit holds every acted gate decision. This core reconstructs the calibration
// candidates from those two histories so the label floor (199 clean close labels) can be cleared from
// EXISTING evidence instead of waiting weeks for live accrual.
//
// Population rules, both load-bearing:
//   • ACTED CLOSES (stratum close_arm): the decision the guarantee governs. A realized outcome of `merged`
//     on a target the gate CLOSED means the PR was later reopened and merged — the definitive incorrect-close
//     class — so those candidates carry `definitiveAdjudication: "incorrect"` (no judgment needed).
//   • HOLDS whose ONLY blockers were AI-judgment findings (stratum holdout_close): staged for ANALYSIS, not
//     for calibration — apply must skip them. Adjudicating the 2026-07 backfill proved they are NOT valid
//     close counterfactuals: a hold that survived means some non-confidence criterion (split vs consensus,
//     author tier) blocked the close, so "would close have been right" samples a different population than
//     the acted-close guarantee governs. The LIVE ε-holdout (#8831) samples would-close PRs and stays valid.
//     Holds with any non-AI blocker (CI red, conflicts, policy) are excluded from staging entirely.
//
// Confidence reconstruction mirrors the live writer (processors.ts finalize site): the FIRST finding whose
// code is in AI_JUDGMENT_BLOCKER_CODES supplies the confidence (`gate.blockers.find(...)`), and findings_json
// preserves the derivation order the blocker list was built from. Candidates without a confidence-bearing
// AI-judgment finding are skipped (rule-only decisions cannot join a confidence-thresholded guarantee).
//
// PURE: decides WHAT to stage from rows the caller supplies. The thin IO wrapper owns stdin/stdout.
import { AI_JUDGMENT_BLOCKER_CODES } from "../src/rules/advisory";

/** One gate decision joined to its review's cached findings, as extracted from review_audit + ai_review_cache. */
export type CandidateRow = {
  targetId: string; // "owner/repo#123"
  project: string; // "owner/repo"
  pullNumber: number;
  decision: "close" | "hold";
  headSha: string | null;
  decidedAt: string; // review_audit.created_at of the gate_decision row
  findingsJson: string; // ai_review_cache.findings_json for the target
  /** gate_outcomes.blocker_codes_json for holds (the codes that held it); null/absent for closes. */
  blockerCodesJson?: string | null | undefined;
  /** Latest realized pr_outcome for the target, when one exists. */
  realizedOutcome?: "merged" | "closed" | null | undefined;
};

export type StagedCalibrationTarget = {
  targetId: string;
  project: string;
  pullNumber: number;
  headSha: string;
  stratum: "close_arm" | "holdout_close";
  verdict: "close";
  outcome: "merged" | "closed" | null;
  aiConfidence: number;
  reasonCode: string; // the shaping finding's code — the record's clause
  findingTitle: string; // for the adjudication worklist, never persisted to the record
  decidedAt: string;
  /** Set when the realized outcome already decides the label (close then merged = reopened+merged). */
  definitiveAdjudication: "incorrect" | null;
};

export type BackfillLabelPlan = {
  staged: StagedCalibrationTarget[];
  skipped: {
    noShapingFinding: number;
    unparseableFindings: number;
    mixedBlockerHold: number;
    missingHeadSha: number;
    duplicateTarget: number;
  };
};

type Finding = { code?: unknown; confidence?: unknown; title?: unknown };

/** The live selection contract: first AI-judgment finding, its confidence required numeric in [0, 1]. */
function shapingFinding(findingsJson: string): { code: string; confidence: number; title: string } | "unparseable" | null {
  let findings: unknown;
  try {
    findings = JSON.parse(findingsJson);
  } catch {
    return "unparseable";
  }
  if (!Array.isArray(findings)) return "unparseable";
  for (const raw of findings as Finding[]) {
    if (typeof raw?.code !== "string" || !AI_JUDGMENT_BLOCKER_CODES.has(raw.code)) continue;
    if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) continue;
    return { code: raw.code, confidence: raw.confidence, title: typeof raw.title === "string" ? raw.title : "" };
  }
  return null;
}

/** True when every code that held the PR is an AI-judgment code — the pure would-close population. */
function holdWasAiJudgmentOnly(blockerCodesJson: string | null | undefined): boolean {
  if (typeof blockerCodesJson !== "string" || blockerCodesJson.trim() === "") return false;
  try {
    const codes = JSON.parse(blockerCodesJson);
    return Array.isArray(codes) && codes.length > 0 && codes.every((code) => typeof code === "string" && AI_JUDGMENT_BLOCKER_CODES.has(code));
  } catch {
    return false;
  }
}

/**
 * Stage calibration targets from candidate rows. One target contributes at most ONE pair (the UNIQUE
 * target_id contract of decision_audit_labels): when a target appears as both an acted close and an earlier
 * hold, the ACTED decision wins — it is the one the guarantee is about.
 */
export function planDecisionLabelBackfill(rows: CandidateRow[]): BackfillLabelPlan {
  const skipped = { noShapingFinding: 0, unparseableFindings: 0, mixedBlockerHold: 0, missingHeadSha: 0, duplicateTarget: 0 };
  const staged: StagedCalibrationTarget[] = [];
  const seen = new Set<string>();
  const ordered = [...rows].sort((a, b) => (a.decision === b.decision ? 0 : a.decision === "close" ? -1 : 1));
  for (const row of ordered) {
    if (seen.has(row.targetId)) {
      skipped.duplicateTarget += 1;
      continue;
    }
    if (row.decision === "hold" && !holdWasAiJudgmentOnly(row.blockerCodesJson)) {
      skipped.mixedBlockerHold += 1;
      continue;
    }
    const finding = shapingFinding(row.findingsJson);
    if (finding === "unparseable") {
      skipped.unparseableFindings += 1;
      continue;
    }
    if (finding === null) {
      skipped.noShapingFinding += 1;
      continue;
    }
    if (typeof row.headSha !== "string" || row.headSha.trim() === "") {
      skipped.missingHeadSha += 1;
      continue;
    }
    seen.add(row.targetId);
    const outcome = row.decision === "close" ? (row.realizedOutcome ?? null) : null;
    staged.push({
      targetId: row.targetId,
      project: row.project,
      pullNumber: row.pullNumber,
      headSha: row.headSha,
      stratum: row.decision === "close" ? "close_arm" : "holdout_close",
      verdict: "close",
      outcome,
      aiConfidence: finding.confidence,
      reasonCode: finding.code,
      findingTitle: finding.title,
      decidedAt: row.decidedAt,
      definitiveAdjudication: row.decision === "close" && outcome === "merged" ? "incorrect" : null,
    });
  }
  return { staged, skipped };
}
