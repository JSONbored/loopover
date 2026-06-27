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
  splitAiReviewNits,
  verdictToRecommendation,
} from "../../src/review/unified-comment-bridge";
import { PR_PANEL_COMMENT_MARKER as MARKER_FROM_COMMENTS } from "../../src/github/comments";
import { deriveUnifiedStatus, type MergeReadiness, type UnifiedCollapsible, type UnifiedCommentStatus } from "../../src/review/unified-comment";
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

  it("heldForReview renders a passing PR as HELD, never 'safe to merge' (#guarded-hold-comment)", () => {
    const args = { gate: gate({ conclusion: "success" }), panelRows, readinessTotal: 90, changedFiles: 2, mergeReadiness: { ciState: "passed" as const }, footerMarkdown: footer };
    // Without the hold, a success+green PR is the green "safe to merge" headline.
    const ready = buildUnifiedCommentBody(args);
    expect(ready).toContain("> [!TIP]");
    expect(ready).toContain("safe to merge");
    // With the guarded hold, the SAME PR renders held (WARNING), not safe-to-merge — matching the disposition.
    const held = buildUnifiedCommentBody({ ...args, heldForReview: true });
    expect(held).toContain("> [!WARNING]");
    expect(held).toContain("Held for maintainer review");
    expect(held).not.toContain("> [!TIP]");
  });

  it("neverClosed renders a gate-failure (close) PR as HELD, not 'Closed' (#8/#9)", () => {
    const args = { gate: gate({ conclusion: "failure" }), panelRows, readinessTotal: 40, changedFiles: 2, mergeReadiness: { ciState: "passed" as const }, footerMarkdown: footer };
    // A contributor close → the red "Closed" headline.
    const closed = buildUnifiedCommentBody(args);
    expect(closed).toContain("Closed");
    // The SAME verdict on an owner / automation-bot PR (never auto-closed) renders held, not Closed.
    const held = buildUnifiedCommentBody({ ...args, neverClosed: true });
    expect(held).toContain("> [!WARNING]");
    expect(held).toContain("Held for maintainer review");
    expect(held).not.toContain("Closed");
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
    { conclusion: "success", alert: "> [!TIP]", headline: /Approved/ }, // success → merge → ready
    { conclusion: "failure", alert: "> [!CAUTION]", headline: /Closed|Blocked/ }, // failure → close → blocked
    { conclusion: "action_required", alert: "> [!WARNING]", headline: /Held for maintainer review/ }, // → manual → held
    { conclusion: "neutral", alert: "> [!WARNING]", headline: /Held for maintainer review/ }, // → manual → held
    { conclusion: "skipped", alert: "> [!NOTE]", headline: /Advisory only/ }, // → comment → advisory
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
        title: "Gittensory Gate: blocked",
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
    // The defect title appears EXACTLY ONCE in the whole comment (the Code-review blocker bullet), never
    // duplicated into the gate signal row (which only renders the conclusion-derived "Blocking" status text).
    const occurrences = body.split(defectTitle).length - 1;
    expect(occurrences, "consensus defect title must appear exactly once").toBe(1);
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
        title: "Gittensory Gate: blocked",
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
    // The defect surfaces exactly once (recovered via consensusDefect; excluded from the folded gate blockers).
    expect(body.split(title).length - 1).toBe(1);
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
});

describe("verdictReason on a held/blocked headline (FIX D2)", () => {
  it("appends the gate summary to a BLOCKED (close) verdict headline", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "failure", title: "Gittensory Gate: blocked", summary: "A hard blocker was found." }),
      panelRows,
      readinessTotal: 30,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toMatch(/Closed|Blocked/);
    expect(body).toContain("A hard blocker was found."); // the gate's authoritative reason on the headline
  });

  it("appends the gate summary to a HELD (manual) verdict headline", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "action_required", title: "Gittensory Gate — needs review", summary: "Manual maintainer review required." }),
      panelRows,
      readinessTotal: 55,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Held for maintainer review");
    expect(body).toContain("Manual maintainer review required.");
  });

  it("falls back to the gate TITLE when the summary is empty", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "failure", title: "Gittensory Gate: blocked by policy", summary: "  " }),
      panelRows,
      readinessTotal: 20,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Gittensory Gate: blocked by policy");
  });

  it("does NOT overwrite the positive ready wording on a passing (merge) verdict", () => {
    const body = buildUnifiedCommentBody({
      gate: gate({ conclusion: "success", title: "Gittensory Gate passed", summary: "No configured hard blocker was found." }),
      panelRows,
      readinessTotal: 90,
      changedFiles: 2,
      footerMarkdown: footer,
    });
    expect(body).toContain("Approved"); // ready headline kept its positive wording…
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
        title: "Gittensory Gate: blocked",
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
    // Sanity: the new depth IS present (so this isn't passing on an empty body).
    expect(body).toContain("Why this is blocked");
    expect(body).toContain("CI checks failing");
    expect(body).toContain("A hard blocker was found.");
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
    expect(isUnifiedReviewCommentEnabled({ GITTENSORY_REVIEW_UNIFIED_COMMENT: undefined })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ GITTENSORY_REVIEW_UNIFIED_COMMENT: "false" })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ GITTENSORY_REVIEW_UNIFIED_COMMENT: "0" })).toBe(false);
    expect(isUnifiedReviewCommentEnabled({ GITTENSORY_REVIEW_UNIFIED_COMMENT: "" })).toBe(false);
  });

  it("is ON only for an explicit truthy value", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(isUnifiedReviewCommentEnabled({ GITTENSORY_REVIEW_UNIFIED_COMMENT: value })).toBe(true);
    }
  });
});
