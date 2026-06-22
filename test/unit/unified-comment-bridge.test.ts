import { describe, expect, it } from "vitest";
import {
  buildClosedUnifiedCommentBody,
  buildDualReviewNotes,
  buildUnifiedCommentBody,
  consensusDefectFromFindings,
  gateConclusionToVerdict,
  isUnifiedReviewCommentEnabled,
  panelRowsToSignalRows,
  PR_PANEL_COMMENT_MARKER,
} from "../../src/review/unified-comment-bridge";
import { PR_PANEL_COMMENT_MARKER as MARKER_FROM_COMMENTS } from "../../src/github/comments";
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
});

describe("PR_PANEL_COMMENT_MARKER is single-sourced from github/comments", () => {
  it("re-exports the SAME marker value the upsert reads (no drift between modules)", () => {
    // The bridge re-exports the canonical marker rather than redefining it. A divergence here would post a
    // DUPLICATE comment instead of updating the legacy/unified comment in place.
    expect(PR_PANEL_COMMENT_MARKER).toBe(MARKER_FROM_COMMENTS);
    expect(PR_PANEL_COMMENT_MARKER).toBe("<!-- gittensory-pr-panel:v1 -->");
  });
});

describe("buildDualReviewNotes — public-safe Nit scrub (privacy-critical, gate warnings)", () => {
  // Nits are the only renderer input not already routed through an existing public-safe filter. The bridge
  // scrubs forbidden private terms (→ "[context]") and DROPS a Nit that still leaks after scrubbing. This
  // mirrors src/rules/advisory.ts sanitizeForCheckRun + src/signals/engine.ts containsPrivatePublicTerm.
  it("scrubs a forbidden term from a Nit instead of leaking it verbatim", () => {
    const reviews = buildDualReviewNotes({
      warnings: [{ code: "w", severity: "warning", title: "Adjust the estimated scores threshold", detail: "...", action: "Tune it." }],
      recommendation: "manual_review",
      verdict: "manual",
    });
    const nit = reviews[0]?.notes?.nits?.[0] ?? "";
    expect(nit).not.toMatch(/estimated scores/i);
    expect(nit).toContain("[context]");
  });

  it("neutralizes a private internal in a Nit and leaves a benign Nit untouched", () => {
    const reviews = buildDualReviewNotes({
      warnings: [
        // "trust score" is a forbidden term → scrubbed to "[context]"; the leak never reaches the comment.
        { code: "w1", severity: "warning", title: "Your trust score is low", detail: "...", action: "n/a" },
        { code: "w2", severity: "warning", title: "Add a unit test", detail: "...", action: "Cover the new branch." },
      ],
      recommendation: "manual_review",
      verdict: "manual",
    });
    const nits = reviews[0]?.notes?.nits ?? [];
    expect(nits).toHaveLength(2);
    // The forbidden term is gone; the benign Nit is byte-for-byte preserved.
    expect(nits[0]).not.toMatch(/trust score/i);
    expect(nits[0]).toContain("[context]");
    expect(nits).toContain("Add a unit test — Cover the new branch.");
  });

  it("neutralizes every private drop-term too (the scrub list is a superset of the drop guard)", () => {
    // The drop guard (PRIVATE_DROP_TERMS) is a fail-safe: it removes any Nit that still names a private
    // internal AFTER scrubbing. With the current regexes the scrub list (PRIVATE_FORBIDDEN_TERMS) is a
    // superset of the drop terms, so every drop-term is already neutralized to "[context]" and the line
    // survives scrubbed rather than being dropped. This asserts the privacy guarantee (no leak) across the
    // drop-term vocabulary; the drop branch remains as defense-in-depth against a future scrub-list gap.
    const dropTerms = ["reward", "payout", "farming", "wallet", "hotkey", "trust score", "raw trust", "estimated score", "scoreability", "reviewability3"];
    for (const term of dropTerms) {
      const reviews = buildDualReviewNotes({
        warnings: [{ code: "w", severity: "warning", title: `Concern about ${term} here`, detail: "...", action: "n/a" }],
        recommendation: "manual_review",
        verdict: "manual",
      });
      const nit = reviews[0]?.notes?.nits?.[0] ?? "";
      expect(nit, `"${term}" must not leak`).not.toContain(term);
    }
  });
});

describe("buildClosedUnifiedCommentBody (closed/skipped PR through the unified renderer)", () => {
  it("starts with the canonical marker so it overwrites the OPEN-PR unified comment in place (not a duplicate)", () => {
    const body = buildClosedUnifiedCommentBody({ repoFullName: "octo/repo", pullNumber: 7, footerMarkdown: footer });
    expect(body.startsWith(PR_PANEL_COMMENT_MARKER)).toBe(true);
  });

  it("renders the non-blocking skipped state (skipped → comment verdict → advisory, not a CAUTION block)", () => {
    const body = buildClosedUnifiedCommentBody({ repoFullName: "octo/repo", pullNumber: 7, footerMarkdown: footer });
    // skipped maps to the `comment` verdict (gateConclusionToVerdict) → advisory tone, mirroring the legacy
    // "[!NOTE] Gittensory Gate skipped" panel. It must NOT read as a blocked/closed CAUTION.
    expect(body).not.toContain("> [!CAUTION]");
    expect(body).toContain("Skipped");
    expect(body).toContain("octo/repo#7 is no longer open.");
    // The footer (earn CTA) is carried through under the divider.
    expect(body).toContain(footer);
  });

  it("surfaces no reviewer blocker/nit (the PR was never fully evaluated)", () => {
    const body = buildClosedUnifiedCommentBody({ repoFullName: "octo/repo", pullNumber: 7, footerMarkdown: footer });
    // No AI review and no findings → the renderer shows "No blockers" rather than inventing a defect.
    expect(body).toContain("No blockers");
  });
});

// FOLLOW-UP (convergence): a full processGitHubWebhook end-to-end test that drives the closed-PR branch of
// maybePublishPrPublicSurface (flag ON vs OFF) through real webhook delivery is net-new and entangled with the
// queue/GitHub-client harness. The focused unit coverage here (open + closed body, marker single-source, flag
// gate, Nit scrub) asserts the bridge contract the processor relies on; the e2e wiring is a separate task.

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
