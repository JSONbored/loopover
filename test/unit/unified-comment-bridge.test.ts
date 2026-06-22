import { describe, expect, it } from "vitest";
import {
  buildDualReviewNotes,
  buildUnifiedCommentBody,
  consensusDefectFromFindings,
  gateConclusionToVerdict,
  isUnifiedReviewCommentEnabled,
  panelRowsToSignalRows,
  PR_PANEL_COMMENT_MARKER,
  verdictToRecommendation,
} from "../../src/review/unified-comment-bridge";
import type { MergeReadiness, UnifiedCollapsible } from "../../src/review/unified-comment";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
import type { AdvisoryFinding } from "../../src/types";
import type { PublicPrPanelSignalRow } from "../../src/signals/engine";

function gate(over: Partial<GateCheckEvaluation> = {}): GateCheckEvaluation {
  return {
    enabled: true,
    conclusion: "success",
    title: "Gittensory Gate passed",
    summary: "No configured hard blocker was found.",
    blockers: [],
    warnings: [],
    ...over,
  };
}

// The exact shape the legacy panel emits (icon-prefixed result cells). The bridge derives ok/warn/fail
// from the leading ✅/⚠️/❌ and strips it from the result text.
const panelRows: PublicPrPanelSignalRow[] = [
  { key: "linkedIssue", cells: ["Linked issue", "✅ Linked", "#42", "No action."] },
  { key: "relatedWork", cells: ["Related work", "✅ No active overlap found", "No same-issue overlap.", "No action."] },
  { key: "reviewLoad", cells: ["Review load", "⚠️ 14/20", "Medium review burden.", "Add scope summary."] },
  { key: "validationEvidence", cells: ["Validation evidence", "✅ 25/25", "PR body includes validation.", "No action."] },
  { key: "openPrQueue", cells: ["Open PR queue", "✅ 10/10", "Low queue pressure.", "No action."] },
  { key: "contributorContext", cells: ["Contributor context", "✅ Confirmed Gittensor contributor", "octocat", "No action."] },
  { key: "gateResult", cells: ["Gate result", "✅ Passing", "No configured blocker found.", "No action."] },
];

const footer = "💰 **Earn for open-source contributions like this.** Checked by Gittensory.";

describe("gateConclusionToVerdict", () => {
  it("maps every gate conclusion to its authoritative verdict", () => {
    expect(gateConclusionToVerdict("success")).toBe("merge");
    expect(gateConclusionToVerdict("failure")).toBe("close");
    expect(gateConclusionToVerdict("action_required")).toBe("manual");
    expect(gateConclusionToVerdict("neutral")).toBe("manual");
    expect(gateConclusionToVerdict("skipped")).toBe("comment");
  });
});

describe("verdictToRecommendation", () => {
  it("maps every verdict (incl. the comment/ignore advisory pair) to a reviewer recommendation", () => {
    expect(verdictToRecommendation("merge")).toBe("merge");
    expect(verdictToRecommendation("close")).toBe("close");
    expect(verdictToRecommendation("manual")).toBe("manual_review");
    expect(verdictToRecommendation("comment")).toBe("manual_review");
    expect(verdictToRecommendation("ignore")).toBe("manual_review");
  });
});

describe("panelRowsToSignalRows", () => {
  it("derives ok/warn/fail from the leading icon and strips it from the result text", () => {
    const rows = panelRowsToSignalRows(panelRows);
    const linked = rows.find((row) => row.label === "Linked issue");
    expect(linked).toEqual({ label: "Linked issue", state: "ok", result: "Linked", evidence: "#42" });
    const reviewLoad = rows.find((row) => row.label === "Review load");
    expect(reviewLoad?.state).toBe("warn");
    expect(reviewLoad?.result).toBe("14/20");
  });

  it("maps a ❌ result cell to fail", () => {
    const rows = panelRowsToSignalRows([{ key: "contributorContext", cells: ["Contributor context", "❌ No public Gittensor match", "octocat; not a blocker.", "No action."] }]);
    expect(rows[0]?.state).toBe("fail");
  });
});

describe("consensusDefectFromFindings", () => {
  it("recovers the ai_consensus_defect finding, ignoring others", () => {
    const findings: AdvisoryFinding[] = [
      { code: "missing_linked_issue", severity: "warning", title: "No linked issue", detail: "..." },
      { code: "ai_consensus_defect", severity: "critical", title: "Null deref in handler", detail: "Both models flagged it." },
    ];
    expect(consensusDefectFromFindings(findings)).toEqual({ title: "Null deref in handler", detail: "Both models flagged it." });
    expect(consensusDefectFromFindings([])).toBeUndefined();
    expect(consensusDefectFromFindings(undefined)).toBeUndefined();
  });
});

describe("buildDualReviewNotes", () => {
  it("folds the advisory notes (assessment), the consensus defect (blocker), and warnings (nits) into one note", () => {
    const reviews = buildDualReviewNotes({
      aiReview: { notes: "The refactor looks correct." },
      consensusDefect: { title: "Off-by-one", detail: "Loop bound is wrong." },
      warnings: [{ code: "w1", severity: "warning", title: "Missing test", detail: "...", action: "Add a test." }],
      recommendation: "close",
      verdict: "close",
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.notes?.assessment).toBe("The refactor looks correct.");
    expect(reviews[0]?.notes?.blockers).toEqual(["Off-by-one: Loop bound is wrong."]);
    expect(reviews[0]?.notes?.nits).toEqual(["Missing test — Add a test."]);
  });

  it("returns [] when there is nothing reviewer-side to surface", () => {
    expect(buildDualReviewNotes({ recommendation: "merge", verdict: "merge" })).toEqual([]);
  });

  it("omits the ': detail' and ' — action' suffixes when the defect has no detail and the warning has no action", () => {
    const reviews = buildDualReviewNotes({
      consensusDefect: { title: "Null deref", detail: "" },
      warnings: [{ code: "w1", severity: "warning", title: "No test", detail: "..." }], // no `action`
      recommendation: "close",
      verdict: "close",
    });
    expect(reviews[0]?.notes?.blockers).toEqual(["Null deref"]); // title only, no trailing ": "
    expect(reviews[0]?.notes?.nits).toEqual(["No test"]); // title only, no trailing " — "
  });
});

describe("buildUnifiedCommentBody", () => {
  it("starts with the exact panel marker so the upsert updates in place", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
    });
    expect(body.startsWith(PR_PANEL_COMMENT_MARKER)).toBe(true);
    // Same marker the legacy body carries (see comments.ts PR_PANEL_COMMENT_MARKER), so no duplicate comment.
    expect(PR_PANEL_COMMENT_MARKER).toBe("<!-- gittensory-pr-panel:v1 -->");
  });

  it("renders gittensory's unified shape: a Code review row, the readiness chip, and the gate row", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      reviewerCount: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Code review"); // the unified renderer's synthesized row
    expect(body).toContain("readiness 88/100"); // readinessTotal → chip
    expect(body).toContain("Gate result"); // gittensory's signal row is preserved after Code review
    expect(body).toContain("> [!TIP]"); // success → ready → TIP alert
  });

  it("the gate conclusion drives the status: a gate failure blocks regardless of reviewer recs", () => {
    const failing = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        title: "Gittensory Gate: blocked",
        summary: "A hard blocker was found.",
        blockers: [{ code: "ai_consensus_defect", severity: "critical", title: "Real bug", detail: "..." }],
      }),
      // Even with an upbeat reviewer assessment, the gate failure is authoritative.
      aiReview: { notes: "Looks fine to me, recommend merge." },
      advisoryFindings: [{ code: "ai_consensus_defect", severity: "critical", title: "Real bug", detail: "Both models agree." }],
      panelRows,
      readinessTotal: 40,
      changedFiles: 5,
      footerMarkdown: footer,
    });
    // failure → close verdict → blocked status (CAUTION alert + "Blocked"/"Closed" verdict line).
    expect(failing).toContain("> [!CAUTION]");
    expect(failing).toMatch(/Closed|Blocked/);
    // The recovered consensus defect surfaces as a blocker.
    expect(failing).toContain("Real bug");
  });

  it("honors review.fields visibility — a hidden row is dropped from the signal table", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      reviewFields: { contributorContext: false },
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
    });
    expect(body).not.toContain("Confirmed Gittensor contributor");
    expect(body).toContain("Gate result"); // a visible row is still present
  });

  it("threads the optional merge-readiness, merged, re-run label, and extra collapsibles into the renderer", () => {
    const mergeReadiness: MergeReadiness = { ciState: "passed", mergeStateLabel: "clean" };
    const extra: UnifiedCollapsible[] = [{ title: "Signal definitions", body: "Readiness signals describe public-metadata readiness." }];
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 91,
      changedFiles: 4,
      mergeReadiness,
      merged: true,
      reRunLabel: "Re-run Gittensory review",
      extraCollapsibles: extra,
      footerMarkdown: footer,
    });
    expect(body).toContain("`CI green`"); // mergeReadiness ciState → chip
    expect(body).toContain("`clean`"); // mergeStateLabel → chip
    expect(body).toContain("auto-merged"); // merged → ready wording
    expect(body).toContain("- [ ] Re-run Gittensory review"); // reRunLabel
    expect(body).toContain("<details><summary><b>Signal definitions</b></summary>"); // extraCollapsibles
  });

  it("maps a non-merge/non-failure gate conclusion (manual / comment verdicts) through the bridge", () => {
    const manual = buildUnifiedCommentBody({ gate: gate({ conclusion: "action_required" }), panelRows, readinessTotal: 60, changedFiles: 2, footerMarkdown: footer });
    expect(manual).toContain("> [!WARNING]"); // action_required → manual → held
    const advisory = buildUnifiedCommentBody({ gate: gate({ conclusion: "skipped" }), panelRows, readinessTotal: 50, changedFiles: 2, footerMarkdown: footer });
    expect(advisory).toContain("> [!NOTE]"); // skipped → comment → advisory
  });
});

describe("isUnifiedReviewCommentEnabled (flag-OFF selects the legacy path)", () => {
  it("is OFF (legacy buildPublicPrIntelligenceComment path) when the flag is unset or falsy", () => {
    expect(isUnifiedReviewCommentEnabled({})).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ UNIFIED_REVIEW_COMMENT: undefined })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ UNIFIED_REVIEW_COMMENT: "false" })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ UNIFIED_REVIEW_COMMENT: "0" })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ UNIFIED_REVIEW_COMMENT: "" })).toBe(false);
  });

  it("is ON only for an explicit truthy value", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(isUnifiedReviewCommentEnabled({ UNIFIED_REVIEW_COMMENT: value })).toBe(true);
    }
  });
});
