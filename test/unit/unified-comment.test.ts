import { describe, expect, it } from "vitest";
import {
  buildUnifiedReviewInput,
  deriveUnifiedStatus,
  type DualReviewNote,
  renderUnifiedReviewComment,
  type ReviewNotes,
  type ReviewRecommendation,
  type UnifiedCommentContext,
  type UnifiedReviewInput,
} from "../../src/review/unified-comment";

const base: UnifiedReviewInput = {
  changedFiles: 2,
  reviewerCount: 2,
  recommendations: ["merge", "merge"],
  summary: "Replaces the custom CASE expression with the shared helper and adds a test.",
};

describe("deriveUnifiedStatus", () => {
  it("ready when the gate decision is merge", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "merge" })).toBe("ready");
  });

  it("ready when every reviewer recommends merge", () => {
    expect(deriveUnifiedStatus({ ...base, recommendations: ["merge", "merge"] })).toBe("ready");
  });

  it("advisory for a comment-only verdict or no actionable recs", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "comment", recommendations: [] })).toBe("advisory");
    expect(deriveUnifiedStatus({ ...base, recommendations: [] })).toBe("advisory");
  });

  it("held for manual / request_changes / failing CI", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "manual" })).toBe("held");
    expect(deriveUnifiedStatus({ ...base, recommendations: ["request_changes"] })).toBe("held");
    expect(deriveUnifiedStatus({ ...base, readiness: { ciState: "failed" } })).toBe("held");
  });

  it("blocked for a close verdict or consensus blockers", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "close" })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, recommendations: [], blockers: ["leaks a secret"] })).toBe("blocked");
  });

  it("an explicit merge verdict is authoritative — ready even with a raised concern", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "merge", blockers: ["minor"] })).toBe("ready");
  });

  it("honors an explicit host status override", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "close" }, { statusOverride: "ready" })).toBe("ready");
  });
});

describe("renderUnifiedReviewComment", () => {
  const ctx: UnifiedCommentContext = {
    readinessScore: 93,
    signals: [
      { label: "Linked issue", state: "ok", result: "Linked", evidence: "#1372" },
      { label: "Contributor", state: "ok", result: "Confirmed", evidence: "galuis116 · 168 PRs" },
    ],
    extraCollapsibles: [{ title: "Signal definitions", body: "Readiness signals describe public-metadata readiness." }],
    reRunLabel: "Re-run Gittensory review",
    footerMarkdown: "Checked by Gittensory.",
  };

  it("renders the ready/auto-merged state in the gittensory shape", () => {
    const md = renderUnifiedReviewComment(
      { ...base, decision: "merge", merged: true, readiness: { ciState: "passed" }, nits: ["Document the new property."] },
      ctx,
    );
    expect(md).toContain("> [!TIP]");
    expect(md).toContain("🟩");
    expect(md).toContain("Gittensory review — safe to merge · auto-merged");
    expect(md).toContain("Approved & auto-merged");
    expect(md).toContain("`2 files`");
    expect(md).toContain("`2 AI reviewers`");
    expect(md).toContain("`no blockers`");
    expect(md).toContain("`readiness 93/100`");
    expect(md).toContain("`CI green`");
    expect(md).toContain("**Review summary**");
    expect(md).toContain("| **Code review** | ✅ No blockers | 2 reviewers, synthesized |");
    expect(md).toContain("| Linked issue | ✅ Linked | #1372 |");
    expect(md).toContain("<details><summary><b>Nits</b> — 1 non-blocking</summary>");
    expect(md).toContain("<details><summary><b>Signal definitions</b></summary>");
    expect(md).toContain("- [ ] Re-run Gittensory review");
    expect(md).toContain("Checked by Gittensory.");
  });

  it("the entire comment is blockquote-wrapped (the full colored sidebar)", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "merge" }, ctx);
    expect(md.split("\n").every((l) => l.startsWith(">"))).toBe(true);
  });

  it("blocked state uses the caution alert, red bar, and an expanded blockers section", () => {
    const md = renderUnifiedReviewComment(
      { ...base, decision: "close", recommendations: ["close", "close"], blockers: ["Introduces a hardcoded secret."] },
      ctx,
    );
    expect(md).toContain("> [!CAUTION]");
    expect(md).toContain("🟥");
    expect(md).toContain("Closed");
    expect(md).toContain("Why this is blocked");
    expect(md).toContain("Introduces a hardcoded secret.");
    expect(md).toContain("| **Code review** | ❌ 1 blocker |");
  });

  it("held state uses the warning alert and amber bar", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "manual", recommendations: ["manual_review"] }, ctx);
    expect(md).toContain("> [!WARNING]");
    expect(md).toContain("🟨");
    expect(md).toContain("Held for maintainer review");
  });

  it("advisory state uses the note alert and blue bar", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "comment", recommendations: [] }, {});
    expect(md).toContain("> [!NOTE]");
    expect(md).toContain("🟦");
    expect(md).toContain("Advisory only");
  });

  it("dedupes repeated blockers and nits", () => {
    const md = renderUnifiedReviewComment(
      { ...base, decision: "close", blockers: ["Same issue", "same issue", "Same issue"] },
      {},
    );
    expect(md.match(/Same issue/gi)?.length).toBe(1);
  });

  it("omits optional chrome when the host provides none", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "merge" }, {});
    expect(md).not.toContain("readiness");
    expect(md).not.toContain("- [ ]");
    expect(md.split("\n").some((l) => l.trim() === "> ---")).toBe(false);
  });

  it("only emits provided content (no internal fields leak in)", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "merge" }, ctx);
    expect(md).not.toMatch(/confidenceFloor|scopeCap|hardGuardrailGlobs|rubric/i);
  });
});

function reviewNote(rec: ReviewRecommendation, extra: Partial<ReviewNotes> = {}): DualReviewNote {
  return {
    model: "test-model",
    notes: { verdict: "merge", recommendation: rec, confidence: 0.9, assessment: "Looks fine.", suggestions: [], risks: [], ...extra },
  };
}

describe("buildUnifiedReviewInput", () => {
  it("maps a clean dual-merge review to a ready input", () => {
    const input = buildUnifiedReviewInput({ changedFiles: ["a.ts", "b.ts"], reviews: [reviewNote("merge"), reviewNote("merge")], decision: "merge" });
    expect(input.changedFiles).toBe(2);
    expect(input.reviewerCount).toBe(2);
    expect(input.summary).toBe("Looks fine.");
    expect(deriveUnifiedStatus(input)).toBe("ready");
  });

  it("a consensus blocker (both reviewers) → blocked even without a gate decision", () => {
    const input = buildUnifiedReviewInput({
      changedFiles: 1,
      reviews: [reviewNote("request_changes", { blockers: ["secret"] }), reviewNote("request_changes", { blockers: ["secret"] })],
    });
    expect(input.consensusBlocker).toBe(true);
    expect(deriveUnifiedStatus(input)).toBe("blocked");
  });

  it("a lone blocker is a split → held, not blocked", () => {
    const input = buildUnifiedReviewInput({
      changedFiles: 1,
      reviews: [reviewNote("request_changes", { blockers: ["maybe"] }), reviewNote("merge")],
    });
    expect(input.consensusBlocker).toBe(false);
    expect(deriveUnifiedStatus(input)).toBe("held");
  });

  it("counts reviewers that produced no verdict (partial review)", () => {
    const input = buildUnifiedReviewInput({ changedFiles: 1, reviews: [reviewNote("merge"), { model: "m2", notes: null }] });
    expect(input.failedCount).toBe(1);
    expect(input.reviewerCount).toBe(1);
  });

  it("dedupes blockers via the shared extraction", () => {
    const input = buildUnifiedReviewInput({
      changedFiles: 1,
      reviews: [reviewNote("close", { blockers: ["Same", "same"] }), reviewNote("close", { blockers: ["Same"] })],
    });
    expect(input.blockers).toEqual(["Same"]);
  });
});
