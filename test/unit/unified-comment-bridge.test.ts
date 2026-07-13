import { describe, expect, it } from "vitest";
import {
  buildClosedUnifiedCommentBody,
  buildDualReviewNotes,
  buildUnifiedCommentBody,
  buildVisualFindingsCollapsible,
  consensusDefectFromFindings,
  gateConclusionToVerdict,
  isUnifiedReviewCommentEnabled,
  isBoilerplateNit,
  panelRowsToSignalRows,
  PR_PANEL_COMMENT_MARKER,
  splitAiReviewNits,
  verdictToRecommendation,
  visualFindingsFromFindings,
} from "../../src/review/unified-comment-bridge";
import { VISUAL_REGRESSION_FINDING_CODE } from "../../src/review/visual/visual-findings";
import { PR_PANEL_COMMENT_MARKER as MARKER_FROM_COMMENTS } from "../../src/github/comments";
import { deriveUnifiedStatus, type MergeReadiness, type UnifiedCollapsible, type UnifiedCommentStatus } from "../../src/review/unified-comment";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
import type { AdvisoryFinding } from "../../src/types";
import type { PublicPrPanelSignalRow } from "../../src/signals/engine";

function gate(over: Partial<GateCheckEvaluation> = {}): GateCheckEvaluation {
  return {
    enabled: true,
    conclusion: "success",
    title: "Gittensory Orb Review Agent passed",
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
  { key: "reviewLoad", cells: ["Change scope", "⚠️ 14/20", "Medium review scope.", "Add a concise scope and risk note."] },
  { key: "validationEvidence", cells: ["Validation posture", "✅ 25/25", "PR body includes validation.", "No action."] },
  { key: "openPrQueue", cells: ["Contributor workload", "✅ 10/10", "No contributor cleanup pressure.", "No action."] },
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
    const reviewLoad = rows.find((row) => row.label === "Change scope");
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

describe("visualFindingsFromFindings (#4111 — advisory-only AI-vision analysis)", () => {
  it("recovers only visual_regression_finding entries, formatted 'title: detail', ignoring other codes", () => {
    const findings: AdvisoryFinding[] = [
      { code: "missing_linked_issue", severity: "warning", title: "No linked issue", detail: "..." },
      { code: VISUAL_REGRESSION_FINDING_CODE, severity: "warning", title: "Possible visual regression: /pricing", detail: "The third column lost its border." },
    ];
    expect(visualFindingsFromFindings(findings)).toEqual([
      "Possible visual regression: /pricing: The third column lost its border.",
    ]);
    expect(visualFindingsFromFindings([])).toEqual([]);
    expect(visualFindingsFromFindings(undefined)).toEqual([]);
  });

  it("scrubs a private term out of a visual finding before it reaches the public comment (privacy invariant)", () => {
    const findings: AdvisoryFinding[] = [
      { code: VISUAL_REGRESSION_FINDING_CODE, severity: "warning", title: "Possible visual regression: /pricing", detail: "Your trust score looks broken here." },
    ];
    const [line] = visualFindingsFromFindings(findings);
    expect(line).not.toMatch(/trust score/i);
    expect(line).toContain("[context]");
  });
});

describe("buildVisualFindingsCollapsible (#4111)", () => {
  it("renders one bullet per finding", () => {
    const c = buildVisualFindingsCollapsible([
      "Possible visual regression: /pricing: The third column lost its border.",
      "Possible visual regression: /about: The hero image is missing.",
    ]);
    expect(c?.title).toBe("Visual findings");
    expect(c?.body).toBe(
      "- Possible visual regression: /pricing: The third column lost its border.\n- Possible visual regression: /about: The hero image is missing.",
    );
  });

  it("returns null when there are no findings (no empty section)", () => {
    expect(buildVisualFindingsCollapsible([])).toBeNull();
  });
});

describe("buildDualReviewNotes", () => {
  it("folds the advisory notes (assessment), the consensus defect (blocker), and warnings (nits) into one note", () => {
    const reviews = buildDualReviewNotes({
      aiReview: { notes: "The refactor looks correct." },
      consensusDefect: { title: "Off-by-one", detail: "Loop bound is wrong." },
      // Present in gateBlockers ⇒ aiReviewGateMode: "block" actually promoted it — a REAL blocker (#2592).
      gateBlockers: [{ code: "ai_consensus_defect", severity: "critical", title: "Off-by-one", detail: "Loop bound is wrong." }],
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
      gateBlockers: [{ code: "ai_consensus_defect", severity: "critical", title: "Null deref", detail: "" }],
      warnings: [{ code: "w1", severity: "warning", title: "No test", detail: "..." }], // no `action`
      recommendation: "close",
      verdict: "close",
    });
    expect(reviews[0]?.notes?.blockers).toEqual(["Null deref"]); // title only, no trailing ": "
    expect(reviews[0]?.notes?.nits).toEqual(["No test"]); // title only, no trailing " — "
  });

  it("does not repeat the consensus defect detail when the gate title already embeds it", () => {
    const reviews = buildDualReviewNotes({
      consensusDefect: {
        title: "AI reviewers agree on a likely critical defect: src/types.ts:111 leaves `Finding` unclosed",
        detail: "src/types.ts:111 leaves `Finding` unclosed",
      },
      gateBlockers: [
        {
          code: "ai_consensus_defect",
          severity: "critical",
          title: "AI reviewers agree on a likely critical defect: src/types.ts:111 leaves `Finding` unclosed",
          detail: "src/types.ts:111 leaves `Finding` unclosed",
        },
      ],
      recommendation: "close",
      verdict: "close",
    });
    expect(reviews[0]?.notes?.blockers).toEqual(["src/types.ts:111 leaves `Finding` unclosed"]);
  });

  // #2592: aiReviewGateMode defaults to advisory, so a consensus defect DOES NOT reach gate.blockers by
  // default even though it is unconditionally added to advisory.findings (see queue/processors.ts). The
  // comment must not then label it a "Blocker" — that claims a merge is blocked when it will not be.
  describe("consensus defect NOT promoted by the gate (aiReviewGateMode off/advisory — #2592)", () => {
    it("routes the defect into Nits, clearly labeled advisory-only, instead of Blockers", () => {
      const reviews = buildDualReviewNotes({
        aiReview: { notes: "Looks mostly fine." },
        consensusDefect: { title: "Off-by-one", detail: "Loop bound is wrong." },
        // No gateBlockers containing ai_consensus_defect ⇒ the gate did NOT promote it (advisory mode).
        recommendation: "merge",
        verdict: "merge",
      });
      expect(reviews[0]?.notes?.blockers).toEqual([]);
      expect(reviews[0]?.notes?.nits).toEqual(["Off-by-one: Loop bound is wrong. (advisory only — not configured to block merge)"]);
    });

    it("still surfaces the note when the defect is the ONLY reviewer-side content (no assessment, no blockers)", () => {
      // Regression guard: before #2592 the early-return only checked `blockers.length === 0`, so an
      // advisory-only defect with no aiReview.notes and no gate blockers would silently vanish entirely.
      const reviews = buildDualReviewNotes({
        consensusDefect: { title: "Null deref", detail: "src/foo.ts:12" },
        recommendation: "merge",
        verdict: "merge",
      });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.notes?.blockers).toEqual([]);
      expect(reviews[0]?.notes?.nits).toEqual(["Null deref: src/foo.ts:12 (advisory only — not configured to block merge)"]);
    });

    it("a gateBlockers list present but NOT containing ai_consensus_defect still treats the defect as advisory-only", () => {
      const reviews = buildDualReviewNotes({
        consensusDefect: { title: "Off-by-one", detail: "Loop bound is wrong." },
        gateBlockers: [{ code: "missing_linked_issue", severity: "critical", title: "No linked issue", detail: "..." }],
        recommendation: "merge",
        verdict: "merge",
      });
      expect(reviews[0]?.notes?.blockers).toEqual(["No linked issue"]); // the real (non-AI) gate blocker still blocks
      expect(reviews[0]?.notes?.nits).toEqual(["Off-by-one: Loop bound is wrong. (advisory only — not configured to block merge)"]);
    });
  });

  it("demotes self-host environmental/process warnings out of the nits, keeping real code nits (#review-accuracy)", () => {
    const reviews = buildDualReviewNotes({
      aiReview: { notes: "Looks fine." },
      warnings: [
        { code: "missing_linked_issue", severity: "warning", title: "No linked issue detected", detail: "...", action: "Link it." },
        { code: "repo_not_registered", severity: "warning", title: "Registration is not available in the local Gittensory cache", detail: "..." },
        { code: "real_code_nit", severity: "warning", title: "Missing test", detail: "...", action: "Add a test." },
      ],
      recommendation: "merge",
      verdict: "comment",
    });
    expect(reviews[0]?.notes?.nits).toEqual(["Missing test — Add a test."]); // only the real code nit survives
  });

  it("demotes the AI review's **Nits (N)** out of the assessment into the collapsible nits, ahead of gate warnings", () => {
    const reviews = buildDualReviewNotes({
      aiReview: {
        notes:
          "Solid change.\n\n**Blockers**\n- none\n\n**Nits (2)**\n- Rename `x` to `count`.\n- Add a doc comment.",
      },
      warnings: [{ code: "w1", severity: "warning", title: "Missing test", detail: "...", action: "Add a test." }],
      recommendation: "merge",
      verdict: "comment",
    });
    // assessment keeps the prose + real Blockers; the nits are gone from the headline
    expect(reviews[0]?.notes?.assessment).toBe("Solid change.\n\n**Blockers**\n- none");
    // AI nits lead, gate warnings follow — all in the collapsible nits section
    expect(reviews[0]?.notes?.nits).toEqual([
      "Rename `x` to `count`.",
      "Add a doc comment.",
      "Missing test — Add a test.",
    ]);
  });
});

describe("splitAiReviewNits", () => {
  it("splits trailing **Nits (N)** bullets from the body, leaving the assessment + blockers in the body", () => {
    expect(splitAiReviewNits("Assessment.\n\n**Blockers**\n- bug\n\n**Nits (2)**\n- a\n- b")).toEqual({
      main: "Assessment.\n\n**Blockers**\n- bug",
      nits: ["a", "b"],
    });
  });
  it("returns the whole blob as main with no nits when there is no Nits section (byte-identical to before)", () => {
    expect(splitAiReviewNits("Just an assessment.")).toEqual({ main: "Just an assessment.", nits: [] });
  });
  it("handles an empty blob", () => {
    expect(splitAiReviewNits("")).toEqual({ main: "", nits: [] });
  });
});

describe("isBoilerplateNit", () => {
  it("flags environmental/process findings by code or title, never real code nits", () => {
    expect(isBoilerplateNit({ code: "missing_linked_issue", severity: "warning", title: "No linked issue detected", detail: "" })).toBe(true); // code match
    expect(isBoilerplateNit({ code: "x", severity: "warning", title: "Repository registration is not available in the local Gittensory cache", detail: "" })).toBe(true); // title match
    expect(isBoilerplateNit({ code: "real_nit", severity: "warning", title: "Missing test", detail: "" })).toBe(false); // real code nit
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

  it("forwards the reviewEffort estimate into the rendered chip when present, and omits it otherwise (#1955)", () => {
    const withEffort = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
      reviewEffort: { band: 2, minutes: 12 },
    });
    expect(withEffort).toContain("`review effort: 2/5 (~12 min)`");
    const withoutEffort = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
    });
    expect(withoutEffort).not.toContain("review effort:");
  });

  it("forwards the linked-issue satisfaction result into the rendered collapsible section, and omits it otherwise (#1961/#3906)", () => {
    const withResult = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
      linkedIssueSatisfaction: { status: "unaddressed", rationale: "The linked issue asks for an SSE stream; this PR adds an unrelated REST endpoint." },
    });
    expect(withResult).toContain("Linked issue satisfaction");
    expect(withResult).toContain("Not yet addressed");
    expect(withResult).toContain("The linked issue asks for an SSE stream");
    const without = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
    });
    expect(without).not.toContain("Linked issue satisfaction");
  });

  it("renders the read-only auto-merge readiness collapsible when autoMergeSummary is present, and omits it otherwise (#2051/#4147)", () => {
    const withSummary = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
      autoMergeSummary: { ciGreen: true, gatePassing: true, mergeableClean: false, linkedIssueValid: true },
    });
    expect(withSummary).toContain("Auto-merge readiness");
    expect(withSummary).toContain("CI checks green");
    expect(withSummary).toContain("Branch mergeable (clean)");
    expect(withSummary).toContain("_Read-only snapshot of the current auto-merge conditions");
    const without = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
    });
    expect(without).not.toContain("Auto-merge readiness");
  });

  it("forwards maxFindings caps into the rendered blocker/nit sections (#2049)", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "action_required",
        summary: "Fix blockers.",
        blockers: [
          { code: "b1", severity: "critical", title: "one", detail: "d" },
          { code: "b2", severity: "critical", title: "two", detail: "d" },
          { code: "b3", severity: "critical", title: "three", detail: "d" },
        ],
      }),
      aiReview: { notes: "Needs work.\n\n**Nits (2)**\n- a\n- b" },
      panelRows,
      readinessTotal: 40,
      changedFiles: 2,
      footerMarkdown: footer,
      maxFindingsCaps: { blockers: 1, nits: 1 },
    });
    expect(body).toContain("+2 more");
    expect(body).toContain("+1 more");
  });

  it("forwards review.comment_verbosity through to gate the rendered collapsibles (#2047)", () => {
    const buildArgs = {
      gate: gate(),
      aiReview: { notes: "Clean change.\n\n**Nits (1)**\n- a nit" },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
    };
    const quiet = buildUnifiedCommentBody({ ...buildArgs, commentVerbosity: "quiet" });
    expect(quiet).not.toContain("<summary><b>Nits</b>");
    const detailed = buildUnifiedCommentBody({ ...buildArgs, commentVerbosity: "detailed" });
    expect(detailed).toContain("<details open><summary><b>Nits</b>");
    const withoutVerbosity = buildUnifiedCommentBody(buildArgs);
    expect(withoutVerbosity).toContain("<details><summary><b>Nits</b>");
  });

  it("passes a public review update timestamp into the unified comment", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows,
      readinessTotal: 88,
      changedFiles: 3,
      footerMarkdown: footer,
      reviewedAt: "2026-06-29T08:05:59.852Z",
    });
    expect(body).toContain("<sub>Review updated: 2026-06-29 08:05:59 UTC</sub>");
  });

  it("does not claim an AI reviewer or synthesize a review from deterministic warnings alone", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "action_required",
        summary: "Manual maintainer review required.",
        warnings: [
          {
            code: "large_change",
            severity: "warning",
            title: "Large change — held for manual review",
            detail: "Large change.",
            action: "Split this into smaller PRs.",
          },
        ],
      }),
      panelRows,
      readinessTotal: 55,
      changedFiles: 5,
      footerMarkdown: footer,
    });
    expect(body).not.toContain("AI reviewer");
    expect(body).not.toContain("Review summary");
    expect(body).toContain("No AI review summary");
  });

  it("the gate conclusion drives the status: a gate failure blocks regardless of reviewer recs", () => {
    const failing = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        title: "Gittensory Orb Review Agent: blocked",
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
    // failure → close verdict → blocked status (CAUTION alert + reject/close suggested action).
    expect(failing).toContain("> [!CAUTION]");
    expect(failing).toContain("Suggested Action - Reject/Close");
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

  // #4589: generateTestsLabel is a SEPARATE explicit field on BuildUnifiedCommentBodyArgs (not implicitly
  // forwarded) — a prior version of this bridge silently dropped it because only reRunLabel was allowlisted
  // here, so the checkbox never appeared in a real webhook-posted comment despite the renderer itself
  // supporting it and every pure-function unit test passing. This pins the bridge-layer wiring specifically.
  it("threads the optional generate-tests checkbox label into the renderer, independent of the re-run label", () => {
    const bothLabels = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 80,
      changedFiles: 2,
      reRunLabel: "Re-run Gittensory review",
      generateTestsLabel: "Generate an AI Playwright test for this PR",
      footerMarkdown: footer,
    });
    expect(bothLabels).toContain("- [ ] Re-run Gittensory review");
    expect(bothLabels).toContain("- [ ] Generate an AI Playwright test for this PR");

    const onlyGenerateTests = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 80,
      changedFiles: 2,
      generateTestsLabel: "Generate an AI Playwright test for this PR",
      footerMarkdown: footer,
    });
    expect(onlyGenerateTests).not.toContain("Re-run Gittensory review");
    expect(onlyGenerateTests).toContain("- [ ] Generate an AI Playwright test for this PR");

    const neitherLabel = buildUnifiedCommentBody({ gate: gate(), panelRows, readinessTotal: 80, changedFiles: 2, footerMarkdown: footer });
    expect(neitherLabel).not.toContain("- [ ]");
  });

  it("maps a non-merge/non-failure gate conclusion (manual / comment verdicts) through the bridge", () => {
    const manual = buildUnifiedCommentBody({ gate: gate({ conclusion: "action_required" }), panelRows, readinessTotal: 60, changedFiles: 2, footerMarkdown: footer });
    expect(manual).toContain("> [!WARNING]"); // action_required → manual → held
    const advisory = buildUnifiedCommentBody({ gate: gate({ conclusion: "skipped" }), panelRows, readinessTotal: 50, changedFiles: 2, footerMarkdown: footer });
    expect(advisory).toContain("> [!NOTE]"); // skipped → comment → advisory
  });

  it("heldForReview renders a passing PR as HELD, never 'safe to merge' (#guarded-hold-comment)", () => {
    const args = { gate: gate({ conclusion: "success" }), panelRows, readinessTotal: 90, changedFiles: 2, mergeReadiness: { ciState: "passed" as const }, footerMarkdown: footer };
    // Without the hold, a success+green PR is the green approve/merge recommendation.
    const ready = buildUnifiedCommentBody(args);
    expect(ready).toContain("> [!TIP]");
    expect(ready).toContain("Suggested Action - Approve/Merge");
    // With the guarded hold, the SAME PR renders held (WARNING), not safe-to-merge — matching the disposition.
    const held = buildUnifiedCommentBody({ ...args, heldForReview: true });
    expect(held).toContain("> [!WARNING]");
    expect(held).toContain("Suggested Action - Manual Review");
    expect(held).not.toContain("> [!TIP]");
  });

  it("preflightHeld renders a passing PR as HELD (incomplete review), never 'safe to merge' (#2002)", () => {
    const args = { gate: gate({ conclusion: "success" }), panelRows, readinessTotal: 90, changedFiles: 2, mergeReadiness: { ciState: "passed" as const }, footerMarkdown: footer };
    // Without the preflight hold, a success+green PR is the green approve/merge recommendation.
    const ready = buildUnifiedCommentBody(args);
    expect(ready).toContain("Suggested Action - Approve/Merge");
    // With a preflight hold (e.g. the review lane is unavailable → the review is incomplete), the SAME PR renders
    // held (WARNING), never safe-to-merge — the incomplete review can't recommend a merge.
    const held = buildUnifiedCommentBody({ ...args, preflightHeld: true });
    expect(held).toContain("> [!WARNING]");
    expect(held).toContain("Suggested Action - Manual Review");
    expect(held).not.toContain("> [!TIP]");
  });

  it("neverClosed renders a gate-failure (close) PR as HELD when CI is green, not reject/close (#8/#9)", () => {
    const args = { gate: gate({ conclusion: "failure" }), panelRows, readinessTotal: 40, changedFiles: 2, mergeReadiness: { ciState: "passed" as const }, footerMarkdown: footer };
    // A contributor close → the red reject/close recommendation.
    const closed = buildUnifiedCommentBody(args);
    expect(closed).toContain("Suggested Action - Reject/Close");
    // The SAME verdict on an owner / automation-bot PR (never auto-closed) renders held, not reject/close.
    const held = buildUnifiedCommentBody({ ...args, neverClosed: true });
    expect(held).toContain("> [!WARNING]");
    expect(held).toContain("Suggested Action - Manual Review");
    expect(held).not.toContain("Suggested Action - Reject/Close");
  });

  it("neverClosed still renders failed CI as a red manual-review result", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "failure" }),
      panelRows,
      readinessTotal: 40,
      changedFiles: 2,
      mergeReadiness: { ciState: "failed", failingChecks: ["test"] },
      footerMarkdown: footer,
      neverClosed: true,
    });
    expect(body).toContain("> [!CAUTION]");
    expect(body).toContain("Suggested Action - Manual Review");
    expect(body).toContain("CI checks failing");
    expect(body).not.toContain("Suggested Action - Reject/Close");
  });
});

// ── Reconciliation invariant (#1016): comment-verdict ↔ gate-conclusion alignment ──────────────────
//
// The two-gate reconciliation makes gittensory's `evaluateGateCheck` conclusion AUTHORITATIVE for the
// unified comment's headline tone. `buildUnifiedCommentBody` maps the gate conclusion → a Verdict
// (`gateConclusionToVerdict`) and feeds it as the renderer `decision`, which `deriveUnifiedStatus` honors
// FIRST — before any reviewer recommendation. So the comment's alert/headline can NEVER contradict the
// Gate check-run conclusion, even when the AI reviewer disagrees. This pins that contract across every
// gate conclusion (success/failure/action_required/neutral/skipped) so a future renderer/bridge change
// that let a reviewer rec override the gate would fail here.
describe("reconciliation invariant: comment tone is pinned to the gate conclusion (#1016)", () => {
  // gate conclusion → the alert + the verbatim headline phrase the renderer must emit for that conclusion.
  const cases: Array<{ conclusion: GateCheckEvaluation["conclusion"]; alert: string; headline: RegExp }> = [
    { conclusion: "success", alert: "> [!TIP]", headline: /Suggested Action - Approve\/Merge/ }, // success → merge → ready
    { conclusion: "failure", alert: "> [!CAUTION]", headline: /Suggested Action - Reject\/Close/ }, // failure → close → blocked
    { conclusion: "action_required", alert: "> [!WARNING]", headline: /Suggested Action - Manual Review/ }, // → manual → held
    { conclusion: "neutral", alert: "> [!WARNING]", headline: /Suggested Action - Manual Review/ }, // → manual → held
    { conclusion: "skipped", alert: "> [!NOTE]", headline: /Suggested Action - Advisory Only/ }, // → comment → advisory
  ];

  for (const { conclusion, alert, headline } of cases) {
    it(`${conclusion} → ${alert} (gate conclusion drives the headline, not the reviewer)`, () => {
      const body = buildUnifiedCommentBody({
        gate: gate({ conclusion }),
        // An upbeat, recommend-merge reviewer assessment — the OPPOSITE of a block — to prove the gate, not
        // the reviewer, sets the tone. If the reviewer rec ever leaked through, a failure/neutral case below
        // would render the ready (TIP/Approved) tone and this would fail.
        aiReview: { notes: "Looks great to me, recommend merge." },
        panelRows,
        readinessTotal: 50,
        changedFiles: 2,
        footerMarkdown: footer,
      });
      expect(body, `${conclusion} must use the ${alert} alert`).toContain(alert);
      expect(body, `${conclusion} headline phrase`).toMatch(headline);
      // Cross-check: every other conclusion's alert is ABSENT (exactly one tone, never two).
      for (const other of cases) {
        if (other.alert === alert) continue;
        expect(body, `${conclusion} must NOT also carry ${other.alert}`).not.toContain(other.alert);
      }
    });
  }

  it("the comment tone matches gateConclusionToVerdict → deriveUnifiedStatus for EVERY conclusion (no divergence)", () => {
    // The status the renderer derives from the gate-mapped verdict, computed directly, must equal the tone
    // the assembled body shows — proving the body cannot diverge from the gate's own decision path.
    const expectedStatus: Record<GateCheckEvaluation["conclusion"], UnifiedCommentStatus> = {
      success: "ready",
      failure: "blocked",
      action_required: "held",
      neutral: "held",
      skipped: "advisory",
    };
    const alertFor: Record<UnifiedCommentStatus, string> = {
      ready: "> [!TIP]",
      advisory: "> [!NOTE]",
      held: "> [!WARNING]",
      blocked: "> [!CAUTION]",
    };
    for (const conclusion of Object.keys(expectedStatus) as GateCheckEvaluation["conclusion"][]) {
      // deriveUnifiedStatus over the gate-mapped verdict alone agrees with the table above…
      const derived = deriveUnifiedStatus({ changedFiles: 0, reviewerCount: 0, recommendations: [], summary: "", decision: gateConclusionToVerdict(conclusion) });
      expect(derived, `derived status for ${conclusion}`).toBe(expectedStatus[conclusion]);
      // …and the full rendered body carries that same status' alert.
      const body = buildUnifiedCommentBody({ gate: gate({ conclusion }), panelRows, readinessTotal: 50, changedFiles: 2, footerMarkdown: footer });
      expect(body, `body tone for ${conclusion}`).toContain(alertFor[expectedStatus[conclusion]]);
    }
  });
});

// ── Single AI pass + single surfacing of the consensus defect (#1016) ───────────────────────────────
//
// The processor runs ONE AI review (`runAiReviewForAdvisory` → one `runGittensoryAiReview`) whose result
// feeds BOTH the gate (it mutates `advisory.findings` with the `ai_consensus_defect`, which
// `evaluateGateCheck` reads) AND the comment (the same finding is RECOVERED from `advisory.findings` by
// the bridge — never a second model call/synthesis). These bridge-level tests pin the "recover, don't
// re-derive" contract that makes the single pass sufficient, and that the recovered defect is surfaced
// exactly once (as the Code-review blocker, NOT also re-printed in the gate signal row).
describe("single AI pass: the bridge RECOVERS the consensus defect, never re-derives it (#1016)", () => {
  it("surfaces the gate's ai_consensus_defect exactly once — as the Code-review blocker, not also in the Gate row", () => {
    const defectTitle = "Use-after-free in the request handler";
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        title: "Gittensory Orb Review Agent: blocked",
        summary: "A hard blocker was found.",
        // The gate's own blockers list carries the defect (as evaluateGateCheck produced it)…
        blockers: [{ code: "ai_consensus_defect", severity: "critical", title: defectTitle, detail: "Both models agree." }],
      }),
      aiReview: { notes: "The change is risky." },
      // …and the bridge recovers the SAME finding from advisory.findings — it does not run a second pass.
      advisoryFindings: [{ code: "ai_consensus_defect", severity: "critical", title: defectTitle, detail: "Both models agree." }],
      panelRows,
      readinessTotal: 30,
      changedFiles: 4,
      footerMarkdown: footer,
    });
    // The defect title appears in the Code-review blocker bullet AND once more inside the "Copy for AI
    // agents" block (a deliberate copyable rendition) -- but never a THIRD time duplicated into the gate
    // signal row (which only renders the conclusion-derived "Blocking" status text).
    const occurrences = body.split(defectTitle).length - 1;
    expect(occurrences, "consensus defect title must appear exactly twice (blocker bullet + AI-context block)").toBe(2);
    // It is rendered under the blocked-reasons heading (the Code-review side), confirming where the one copy lives.
    expect(body).toMatch(/Why this is blocked|Concerns raised/);
  });

  it("a SINGLE reviewer note is produced (one AI pass), not two — the renderer shows one synthesized review", () => {
    // buildDualReviewNotes folds the single AI pass (assessment + consensus blocker + nits) into ONE note;
    // the renderer's reviewer count is 1. A second pass would surface as a second note / reviewerCount 2.
    const reviews = buildDualReviewNotes({
      aiReview: { notes: "Single synthesized assessment." },
      consensusDefect: { title: "Real defect", detail: "..." },
      warnings: [{ code: "w", severity: "warning", title: "Nit", detail: "...", action: "fix" }],
      recommendation: "close",
      verdict: "close",
    });
    expect(reviews).toHaveLength(1);
  });
});

// ── FIX D: fuller blocked / CI-failing comment (gate blockers + verdictReason + failing-check details) ──────
describe("gate blockers render in 'Why this is blocked' (FIX D1)", () => {
  it("maps a NON-AI gate blocker into the reviewer blockers (populated list, not empty)", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        title: "Gittensory Orb Review Agent: blocked",
        summary: "A hard blocker was found.",
        // A non-AI gate failure (no ai_consensus_defect anywhere) — the consensus defect alone would have left
        // "Why this is blocked" empty. The gate blocker must now render.
        blockers: [{ code: "missing_linked_issue", severity: "critical", title: "No linked issue", detail: "Link an issue.", action: "Add `Closes #123`." }],
      }),
      // no aiReview, no advisoryFindings (no consensus defect) — only the gate blocker drives the list.
      panelRows,
      readinessTotal: 30,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Why this is blocked");
    expect(body).toContain("No linked issue");
    expect(body).toContain("Add `Closes #123`."); // the finding's action is appended after " — "
  });

  it("does NOT double-list the ai_consensus_defect when it is both a gate blocker and the recovered defect", () => {
    const title = "Use-after-free in handler";
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        summary: "A hard blocker was found.",
        // The defect is present in BOTH the gate blockers AND advisory findings (as evaluateGateCheck produces).
        blockers: [{ code: "ai_consensus_defect", severity: "critical", title, detail: "Both models agree." }],
      }),
      advisoryFindings: [{ code: "ai_consensus_defect", severity: "critical", title, detail: "Both models agree." }],
      panelRows,
      readinessTotal: 20,
      changedFiles: 3,
      footerMarkdown: footer,
    });
    // The defect surfaces as ONE blocker (recovered via consensusDefect; excluded from the folded gate
    // blockers so it isn't double-counted as two separate findings) -- which then legitimately renders in
    // two places: the blocker bullet and the "Copy for AI agents" block.
    expect(body.split(title).length - 1).toBe(2);
  });

  it("renders BOTH the recovered consensus defect AND a separate non-AI gate blocker", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        summary: "A hard blocker was found.",
        blockers: [
          { code: "ai_consensus_defect", severity: "critical", title: "Real bug", detail: "Both agree." },
          { code: "slop_gate", severity: "critical", title: "Slop risk too high", detail: "Padding detected." },
        ],
      }),
      advisoryFindings: [{ code: "ai_consensus_defect", severity: "critical", title: "Real bug", detail: "Both agree." }],
      panelRows,
      readinessTotal: 10,
      changedFiles: 4,
      footerMarkdown: footer,
    });
    expect(body).toContain("Real bug"); // recovered consensus defect
    expect(body).toContain("Slop risk too high"); // folded non-AI gate blocker
  });

  it("scrubs a private term out of a gate blocker before it reaches the public comment (privacy invariant)", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        summary: "A hard blocker was found.",
        // A gate blocker whose title names a private internal must be scrubbed → "[context]", never leaked.
        blockers: [{ code: "x", severity: "critical", title: "Your trust score is too low", detail: "...", action: "n/a" }],
      }),
      panelRows,
      readinessTotal: 10,
      changedFiles: 1,
      footerMarkdown: footer,
    });
    expect(body).not.toMatch(/trust score/i);
    expect(body).toContain("[context]");
  });

  // gittensory PR #5347: the real-world `summary` evaluateGateCheckCore produces for a "failure" conclusion is
  // LITERALLY `blockers.map(f => title + action).join("; ")` -- not the short hand-authored string the tests
  // above use. The earlier tests in this describe block never exercise that realistic value, so they never
  // caught this. Reproduce it exactly here.
  it("does NOT print the blocker text twice when gate.summary is the REALISTIC blockers-restated string (#5347)", () => {
    const blockerTitle = "schema-version.js:42 applies multiple migrations before stamping once";
    const blockerAction = "wrap the migration loop and the stamp in one transaction";
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        title: `Gittensory Orb Review Agent: ${blockerTitle}`,
        // The exact shape evaluateGateCheckCore's `summary` field produces: blockers restated, title + action.
        summary: `${blockerTitle} — ${blockerAction}.`,
        blockers: [{ code: "ai_consensus_defect", severity: "critical", title: blockerTitle, detail: blockerAction, action: blockerAction }],
      }),
      advisoryFindings: [{ code: "ai_consensus_defect", severity: "critical", title: blockerTitle, detail: blockerAction }],
      panelRows,
      readinessTotal: 100,
      changedFiles: 10,
      footerMarkdown: footer,
    });
    // Never restated under "Suggested Action" (the original #5347 bug) -- the text before "Why this is
    // blocked" must not contain it. It legitimately appears twice total: once under "Why this is blocked",
    // once more inside the "Copy for AI agents" block (a deliberate, separate copyable rendition).
    const [beforeWhyBlocked, afterWhyBlocked] = body.split("Why this is blocked");
    expect(beforeWhyBlocked).not.toContain(blockerTitle);
    expect(afterWhyBlocked).toContain(blockerTitle);
    expect(body.split(blockerTitle).length - 1).toBe(2);
  });

  it("a manual-review HOLD (no gate blockers) still shows its own top-level reason, unaffected by the #5347 fix", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "neutral",
        title: "Gittensory Orb Review Agent — held for manual review",
        summary: "A repo-configured guardrail path was touched.",
        blockers: [],
        warnings: [{ code: "guardrail_hold", severity: "warning", title: "Guardrail path touched", detail: "wrangler.jsonc" }],
      }),
      panelRows,
      readinessTotal: 50,
      changedFiles: 1,
      footerMarkdown: footer,
    });
    expect(body).toContain("Guardrail path touched: wrangler.jsonc");
  });
});

describe("buildUnifiedCommentBody: visual findings render in their OWN section, never duplicated as a generic Nit (#4111)", () => {
  it("renders the 'Visual findings' collapsible from advisoryFindings and stays advisory-only (merge verdict unaffected)", () => {
    const visualFinding: AdvisoryFinding = {
      code: VISUAL_REGRESSION_FINDING_CODE,
      severity: "warning",
      title: "Possible visual regression: /pricing",
      detail: "The third column lost its border.",
      action: "Advisory only — verify against the Visual preview screenshots before deciding.",
    };
    const body = buildUnifiedCommentBody({
      // A real evaluateGateCheck run would carry this "warning"-severity finding into gate.warnings too —
      // simulated here so the exclusion-from-generic-Nits behavior is exercised the same way it is live.
      gate: gate({ warnings: [visualFinding] }),
      advisoryFindings: [visualFinding],
      panelRows,
      readinessTotal: 80,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Visual findings");
    expect(body).toContain("Possible visual regression: /pricing: The third column lost its border.");
    // Never duplicated into the generic Nits collapsible.
    expect(body.split("Possible visual regression: /pricing").length - 1).toBe(1);
    // Strictly advisory: a "warning"-severity, non-blocker finding never turns a passing gate into anything else.
    expect(body).toContain("Suggested Action - Approve/Merge");
  });

  it("omits the 'Visual findings' section entirely when no visual finding is present (byte-identical to today)", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 80,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).not.toContain("Visual findings");
  });
});

describe("verdictReason on a held/blocked headline (FIX D2)", () => {
  it("appends the gate summary to a BLOCKED (close) verdict headline", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "failure", title: "Gittensory Orb Review Agent: blocked", summary: "A hard blocker was found." }),
      panelRows,
      readinessTotal: 30,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Suggested Action - Reject/Close");
    expect(body).toContain("A hard blocker was found."); // the gate's authoritative reason on the headline
  });

  it("appends the gate summary to a HELD (manual) verdict headline", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "action_required", title: "Gittensory Orb Review Agent — needs review", summary: "Manual maintainer review required." }),
      panelRows,
      readinessTotal: 55,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Suggested Action - Manual Review");
    expect(body).toContain("Manual maintainer review required.");
  });

  it("uses guardrail warning details for the manual-review reason so the exact path and glob are public", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "neutral",
        summary: "Touches a guarded path — held for manual review",
        warnings: [
          {
            code: "guardrail_hold",
            severity: "warning",
            title: "Touches a guarded path — held for manual review",
            detail: "This PR changes guardrail-protected path(s): `workers/api.mjs` (matched `workers/**`).",
            action: "A maintainer must review this manually.",
          },
        ],
      }),
      aiReview: { notes: "The AI review still ran and found only non-blocking concerns." },
      panelRows,
      readinessTotal: 73,
      changedFiles: 18,
      footerMarkdown: footer,
    });
    expect(body).toContain("Suggested Action - Manual Review");
    expect(body).toContain("Touches a guarded path — held for manual review: This PR changes guardrail-protected path(s): `workers/api.mjs` (matched `workers/**`).");
    expect(body).toContain("The AI review still ran and found only non-blocking concerns.");
  });

  it("falls back to the guardrail warning title when a manual hold warning has no detail", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "neutral",
        summary: "Manual review required.",
        warnings: [{ code: "guardrail_hold", severity: "warning", title: "Touches a guarded path — held for manual review", detail: "" }],
      }),
      panelRows,
      readinessTotal: 73,
      changedFiles: 18,
      footerMarkdown: footer,
    });
    expect(body).toContain("Touches a guarded path — held for manual review");
    expect(body).not.toContain("Touches a guarded path — held for manual review:");
  });

  it("falls back to the gate TITLE when the summary is empty", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "failure", title: "Gittensory Orb Review Agent: blocked by policy", summary: "  " }),
      panelRows,
      readinessTotal: 20,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Gittensory Orb Review Agent: blocked by policy");
  });

  it("renders the Manual Review headline with no reason bullet when the whole fallback chain is exhausted (no matching warning, blank summary, blank title)", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "action_required", title: "  ", summary: "  ", warnings: [] }),
      panelRows,
      readinessTotal: 55,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Suggested Action - Manual Review");
    // "held" has no default reason (unlike ready/advisory/blocked), so an exhausted chain renders the bare
    // heading with no trailing "- reason" bullet at all -- not even an empty one.
    expect(body).not.toMatch(/Suggested Action - Manual Review\*\*\n-/);
  });

  it("does NOT overwrite the positive ready wording on a passing (merge) verdict", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "success", title: "Gittensory Orb Review Agent passed", summary: "No configured hard blocker was found." }),
      panelRows,
      readinessTotal: 90,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Suggested Action - Approve/Merge"); // ready headline kept its positive wording…
    expect(body).not.toContain("No configured hard blocker was found."); // …the gate summary did NOT replace it
  });
});

describe("failing CI checks (names + per-check WHY) render under the CI chip (FIX D3)", () => {
  const mergeReadiness: MergeReadiness = {
    ciState: "failed",
    failingChecks: ["codecov/patch", "lint"],
    failingDetails: [
      { name: "codecov/patch", summary: "60% of diff hit (target 97%)" },
      { name: "lint", summary: "2 errors in src/foo.ts" },
    ],
  };

  it("lists each failing check name AND its detail", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "action_required", summary: "CI is red." }),
      panelRows,
      readinessTotal: 40,
      changedFiles: 3,
      mergeReadiness,
      footerMarkdown: footer,
    });
    expect(body).toContain("CI checks failing");
    expect(body).toContain("codecov/patch");
    expect(body).toContain("60% of diff hit (target 97%)");
    expect(body).toContain("lint");
    expect(body).toContain("2 errors in src/foo.ts");
    expect(body).toContain("`CI failing`"); // the chip is still present too
  });

  it("falls back to bare check names when no per-check details were captured", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "action_required", summary: "CI is red." }),
      panelRows,
      readinessTotal: 40,
      changedFiles: 3,
      mergeReadiness: { ciState: "failed", failingChecks: ["build", "e2e"] },
      footerMarkdown: footer,
    });
    expect(body).toContain("CI checks failing");
    expect(body).toContain("build");
    expect(body).toContain("e2e");
  });

  it("omits the failing-checks section entirely when CI passed", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "success" }),
      panelRows,
      readinessTotal: 90,
      changedFiles: 3,
      mergeReadiness: { ciState: "passed" },
      footerMarkdown: footer,
    });
    expect(body).not.toContain("CI checks failing");
    expect(body).toContain("`CI green`");
  });
});

describe("privacy invariant: the private 'Maintainer notes' internals never reach the public unified comment (FIX D)", () => {
  it("never contains 'Maintainer notes', even on a fully-populated blocked + CI-failing comment", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({
        conclusion: "failure",
        title: "Gittensory Orb Review Agent: blocked",
        summary: "A hard blocker was found.",
        blockers: [
          { code: "ai_consensus_defect", severity: "critical", title: "Real bug", detail: "Both agree." },
          { code: "missing_linked_issue", severity: "critical", title: "No linked issue", detail: "...", action: "Add `Closes #1`." },
        ],
        warnings: [{ code: "w", severity: "warning", title: "Add a test", detail: "...", action: "Cover the branch." }],
      }),
      aiReview: { notes: "The change is risky." },
      advisoryFindings: [{ code: "ai_consensus_defect", severity: "critical", title: "Real bug", detail: "Both agree." }],
      panelRows,
      readinessTotal: 10,
      changedFiles: 6,
      mergeReadiness: { ciState: "failed", failingChecks: ["codecov/patch"], failingDetails: [{ name: "codecov/patch", summary: "60% of diff hit (target 97%)" }] },
      footerMarkdown: footer,
    });
    expect(body).not.toContain("Maintainer notes");
    // Sanity: the new depth IS present (so this isn't passing on an empty body). Since gate.blockers is
    // non-empty here, gateVerdictReason omits the redundant gate.summary fallback (#5347) — the real blocker
    // titles below are the actual populated content, not the generic "A hard blocker was found." placeholder.
    expect(body).toContain("Why this is blocked");
    expect(body).toContain("CI checks failing");
    expect(body).toContain("Real bug");
    expect(body).toContain("No linked issue");
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
      aiReview: { notes: "Reviewer assessment." },
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
      aiReview: { notes: "Reviewer assessment." },
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
        aiReview: { notes: "Reviewer assessment." },
        warnings: [{ code: "w", severity: "warning", title: `Concern about ${term} here`, detail: "...", action: "n/a" }],
        recommendation: "manual_review",
        verdict: "manual",
      });
      const nit = reviews[0]?.notes?.nits?.[0] ?? "";
      expect(nit, `"${term}" must not leak`).not.toContain(term);
    }
  });

  it("excludes a visual_regression_finding warning from Nits (#4111 — it renders in its own 'Visual findings' collapsible instead)", () => {
    const reviews = buildDualReviewNotes({
      aiReview: { notes: "Reviewer assessment." },
      warnings: [
        { code: VISUAL_REGRESSION_FINDING_CODE, severity: "warning", title: "Possible visual regression: /pricing", detail: "The third column lost its border." },
        { code: "w2", severity: "warning", title: "Add a unit test", detail: "...", action: "Cover the new branch." },
      ],
      recommendation: "manual_review",
      verdict: "manual",
    });
    const nits = reviews[0]?.notes?.nits ?? [];
    expect(nits).toHaveLength(1);
    expect(nits).not.toContain(expect.stringContaining("Possible visual regression"));
    expect(nits).toContain("Add a unit test — Cover the new branch.");
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
    // "[!NOTE] Gittensory Orb Review Agent skipped" panel. It must NOT read as a blocked/closed CAUTION.
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
    expect(isUnifiedReviewCommentEnabled({ LOOPOVER_REVIEW_UNIFIED_COMMENT: undefined })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ LOOPOVER_REVIEW_UNIFIED_COMMENT: "false" })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ LOOPOVER_REVIEW_UNIFIED_COMMENT: "0" })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ LOOPOVER_REVIEW_UNIFIED_COMMENT: "" })).toBe(false);
  });

  it("is ON only for an explicit truthy value", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(isUnifiedReviewCommentEnabled({ LOOPOVER_REVIEW_UNIFIED_COMMENT: value })).toBe(true);
    }
  });
});
