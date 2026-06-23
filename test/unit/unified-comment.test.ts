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

  it("held for manual / request_changes", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "manual" })).toBe("held");
    expect(deriveUnifiedStatus({ ...base, recommendations: ["request_changes"] })).toBe("held");
  });

  it("CI that hasn't passed is NEVER safe-to-merge — failed→blocked, pending/unverified→held, even over a merge verdict", () => {
    // A red CI must never render "safe to merge". It downgrades even an explicit `merge` verdict to blocked.
    expect(deriveUnifiedStatus({ ...base, readiness: { ciState: "failed" } })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "failed" } })).toBe("blocked");
    // CI still running / not yet reported (chip "CI pending") → HELD, never "safe to merge".
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "unverified" } })).toBe("held");
    // ONLY green CI + a merge verdict renders ready.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed" } })).toBe("ready");
  });

  it("blocked for a close verdict or consensus blockers", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "close" })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, decision: "close", readiness: { ciState: "unverified" } })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, recommendations: [], blockers: ["leaks a secret"] })).toBe("blocked");
  });

  it("an explicit merge verdict is authoritative — ready even with a raised concern", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "merge", blockers: ["minor"] })).toBe("ready");
  });

  it("honors an explicit host status override", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "close" }, { statusOverride: "ready" })).toBe("ready");
  });

  it("treats a missing recommendations array as no recs → advisory", () => {
    // exercises the `recommendations ?? []` guard for a defensively-shaped input
    expect(deriveUnifiedStatus({ changedFiles: 1, reviewerCount: 0, summary: "" } as UnifiedReviewInput)).toBe("advisory");
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

  it("a blocked status from reviewer recs (no close decision) reads 'blocked', not 'closed'", () => {
    const md = renderUnifiedReviewComment({ ...base, recommendations: ["close"], blockers: ["Leaks a token."], consensusBlocker: true }, {});
    expect(md).toContain("> [!CAUTION]");
    expect(md).toContain("Gittensory review — blocked"); // verb(): decision !== "close"
    expect(md).toContain("**🛑 Blocked**"); // verdictLine(): decision !== "close"
    expect(md).not.toContain("Closed");
  });

  it("renders CI-failing / CI-pending chips and the merge-state label", () => {
    const failing = renderUnifiedReviewComment({ ...base, readiness: { ciState: "failed", mergeStateLabel: "behind" } }, {});
    expect(failing).toContain("`CI failing`");
    expect(failing).toContain("`behind`");
    const pending = renderUnifiedReviewComment({ ...base, readiness: { ciState: "unverified" } }, {});
    expect(pending).toContain("`CI pending`");
  });

  it("lists failing check names + per-check details under a 'CI checks failing' section (FIX D3)", () => {
    const md = renderUnifiedReviewComment(
      {
        ...base,
        readiness: {
          ciState: "failed",
          failingChecks: ["codecov/patch", "lint"],
          failingDetails: [
            { name: "codecov/patch", summary: "60% of diff hit (target 97%)" },
            { name: "lint", summary: "2 errors in src/foo.ts" },
          ],
        },
      },
      {},
    );
    expect(md).toContain("CI checks failing");
    expect(md).toContain("- codecov/patch — 60% of diff hit (target 97%)");
    expect(md).toContain("- lint — 2 errors in src/foo.ts");
  });

  it("falls back to bare failing check names when no per-check detail is present (FIX D3)", () => {
    const md = renderUnifiedReviewComment({ ...base, readiness: { ciState: "failed", failingChecks: ["build", "e2e"] } }, {});
    expect(md).toContain("CI checks failing");
    expect(md).toContain("- build");
    expect(md).toContain("- e2e");
  });

  it("omits the failing-checks section when CI passed or is unverified (FIX D3)", () => {
    expect(renderUnifiedReviewComment({ ...base, readiness: { ciState: "passed" } }, {})).not.toContain("CI checks failing");
    expect(renderUnifiedReviewComment({ ...base, readiness: { ciState: "unverified", failingChecks: ["stale"] } }, {})).not.toContain("CI checks failing");
  });

  it("angle-escapes a failing check name + detail (FIX D3 public-safety)", () => {
    const md = renderUnifiedReviewComment(
      { ...base, readiness: { ciState: "failed", failingDetails: [{ name: "check <x>", summary: "broke </details>" }] } },
      {},
    );
    expect(md).toContain("check &lt;x&gt;");
    expect(md).toContain("broke &lt;/details&gt;");
    expect(md).not.toContain("broke </details>");
  });

  it("appends an explicit verdict reason across ready (merged + unmerged) and advisory states", () => {
    // The verdict word is bolded (`**…**`); the reason follows outside the bold, so assert each separately.
    const merged = renderUnifiedReviewComment({ ...base, decision: "merge", merged: true, verdictReason: "all checks green" }, {});
    expect(merged).toContain("Approved & auto-merged");
    expect(merged).toContain("all checks green"); // verdictReason appended, not the default " — all checks passed"
    const unmerged = renderUnifiedReviewComment({ ...base, decision: "merge", verdictReason: "looks correct" }, {});
    expect(unmerged).not.toContain("auto-merged"); // the unmerged ready variant
    expect(unmerged).toContain("looks correct");
    const advisory = renderUnifiedReviewComment({ ...base, decision: "comment", recommendations: [], verdictReason: "for your awareness" }, {});
    expect(advisory).toContain("Advisory only");
    expect(advisory).toContain("for your awareness");
  });

  it("skips empty blocker lines and caps long nit lists at 12", () => {
    const withEmpty = renderUnifiedReviewComment({ ...base, decision: "close", blockers: ["", "   ", "Real blocker"] }, {});
    expect(withEmpty.match(/Real blocker/g)?.length).toBe(1);
    const capped = renderUnifiedReviewComment({ ...base, decision: "merge", nits: Array.from({ length: 13 }, (_, i) => `Distinct nit ${i + 1}`) }, {});
    expect(capped).toContain("Distinct nit 12");
    expect(capped).not.toContain("Distinct nit 13");
  });

  it("renders a signal row that has neither a result nor evidence", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "merge" }, { signals: [{ label: "Bare row", state: "warn" }] });
    expect(md).toContain("| Bare row | ⚠️ |  |");
  });

  it("uses the 'Concerns raised' heading (not 'Why this is blocked') for blockers on a non-blocked status", () => {
    // a lone request_changes blocker → held, but the concern is still surfaced under the softer heading
    const md = renderUnifiedReviewComment({ ...base, recommendations: ["request_changes"], blockers: ["Edge case unhandled."], consensusBlocker: false }, {});
    expect(md).toContain("> [!WARNING]");
    expect(md).toContain("Concerns raised — review before merging");
    expect(md).not.toContain("Why this is blocked");
    expect(md).toContain("Edge case unhandled.");
  });

  it("skips an extra collapsible whose body is empty", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "merge" }, { extraCollapsibles: [{ title: "Empty section", body: "   " }] });
    expect(md).not.toContain("Empty section");
  });

  it("escapes angle brackets from public renderer fields while preserving details wrappers", () => {
    const md = renderUnifiedReviewComment(
      {
        ...base,
        decision: "manual",
        summary: "Safe summary </details><!-- hidden -->",
        blockers: ["Blocker <script>alert(1)</script>"],
        nits: ["Nit closes </details>"],
        verdictReason: "needs <maintainer> review",
      },
      {
        signals: [{ label: "Gate <row>", state: "fail", result: "Bad <tag>", evidence: "Evidence </td>" }],
        extraCollapsibles: [{ title: "Extra <title>", body: "Body <!-- comment -->" }],
      },
    );

    expect(md).toContain("Safe summary &lt;/details&gt;&lt;!-- hidden --&gt;");
    expect(md).toContain("- Blocker &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(md).toContain("- Nit closes &lt;/details&gt;");
    expect(md).toContain("needs &lt;maintainer&gt; review");
    expect(md).toContain("| Gate &lt;row&gt; | ❌ Bad &lt;tag&gt; | Evidence &lt;/td&gt; |");
    expect(md).toContain("<details><summary><b>Extra &lt;title&gt;</b></summary>");
    expect(md).toContain("Body &lt;!-- comment --&gt;");
    expect(md).toContain("<details><summary><b>Nits</b> — 1 non-blocking</summary>");
    expect(md).not.toContain("Safe summary </details>");
    expect(md).not.toContain("Body <!-- comment -->");
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

  it("drops empty/whitespace blocker lines in the shared extraction", () => {
    const input = buildUnifiedReviewInput({ changedFiles: 1, reviews: [reviewNote("close", { blockers: ["", "   ", "Real defect"] })] });
    expect(input.blockers).toEqual(["Real defect"]);
  });

  it("threads optional readiness, merged, and verdictReason through to the input", () => {
    const input = buildUnifiedReviewInput({
      changedFiles: 1,
      reviews: [reviewNote("merge")],
      readiness: { ciState: "passed" },
      merged: true,
      verdictReason: "auto-merged after green CI",
    });
    expect(input.readiness).toEqual({ ciState: "passed" });
    expect(input.merged).toBe(true);
    expect(input.verdictReason).toBe("auto-merged after green CI");
  });
});
