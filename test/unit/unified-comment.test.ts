import { describe, expect, it } from "vitest";
import {
  buildUnifiedReviewInput,
  deriveUnifiedStatus,
  type DualReviewNote,
  renderReviewingPlaceholder,
  renderUnifiedReviewComment,
  type ReviewNotes,
  type ReviewRecommendation,
  shouldPostReviewingPlaceholder,
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

  it("failed CI is a failing review result; pending CI holds but does not block", () => {
    // Red CI must never render "safe to merge"; it is a failing review result even if the PR cannot auto-close.
    expect(deriveUnifiedStatus({ ...base, readiness: { ciState: "failed" } })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "failed" } })).toBe("blocked");
    // CI still running / not yet reported (chip "CI pending") → HELD, never "safe to merge".
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "unverified" } })).toBe("held");
    // ONLY green CI + a merge verdict renders ready.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed" } })).toBe("ready");
  });

  it("never renders 'safe to merge' on an incomplete review — a preflight hold downgrades a gate merge verdict (#2002)", () => {
    // A preflight HOLD means the review is incomplete (e.g. the review lane is unavailable). A gate `merge` decision
    // sets `ready` and the hold otherwise only lands in the advisory readiness score — so this downgrade catches it,
    // and an unfinished review can never read as approve/merge.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed" } }, { preflightHeld: true })).toBe("held");
    // Regression: a clean merge with no hold STILL renders ready — the downgrade only ever downgrades, never approves.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed" } })).toBe("ready");
    // A gate `merge` WITH advisory blockers stays authoritative-ready by design (the gate already weighed them);
    // tightening that lives in the gate's confidence/approval bars, not this renderer. See the authoritative-merge test.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed" }, blockers: ["minor"] })).toBe("ready");
  });

  it("blocked for a close verdict or consensus blockers", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "close" })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, decision: "close", readiness: { ciState: "unverified" } })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, recommendations: [], blockers: ["leaks a secret"] })).toBe("blocked");
  });

  it("a non-mergeable merge state is advisory — dirty/behind hold, but never block a merge verdict (#4220)", () => {
    // The reported bug: green CI + merge verdict but a `dirty` base conflict rendered "safe to merge".
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed", mergeStateLabel: "dirty" } })).toBe("held");
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed", mergeStateLabel: "DIRTY" } })).toBe("held"); // case-insensitive
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed", mergeStateLabel: "behind" } })).toBe("held");
    // A clean (or not-yet-computed / pending-bot-approval) merge state still renders ready.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed", mergeStateLabel: "clean" } })).toBe("ready");
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed", mergeStateLabel: "unknown" } })).toBe("ready");
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed", mergeStateLabel: "blocked" } })).toBe("ready");
    // No mergeStateLabel at all → no downgrade.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed" } })).toBe("ready");
  });

  it("an explicit merge verdict is authoritative — ready even with a raised concern", () => {
    expect(deriveUnifiedStatus({ ...base, decision: "merge", blockers: ["minor"] })).toBe("ready");
  });

  it("a guarded-path hold downgrades a would-be-ready PR to held — never 'safe to merge' (#guarded-hold-comment)", () => {
    // A clean+green PR that touches a hard-guardrail path is HELD for owner review, so the comment says held.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed" } }, { heldForReview: true })).toBe("held");
    // A guarded close still closes; guardrails hold only otherwise-ready PRs.
    expect(deriveUnifiedStatus({ ...base, decision: "close", readiness: { ciState: "failed" } }, { heldForReview: true })).toBe("blocked");
    // Without the hold flag, the same clean+green PR is ready.
    expect(deriveUnifiedStatus({ ...base, decision: "merge", readiness: { ciState: "passed" } }, { heldForReview: false })).toBe("ready");
  });

  it("renders a non-closing disposition as held, but still red when CI failed (#8/#9)", () => {
    // #9: an owner / automation-bot author is NEVER auto-closed → a gate "close" verdict renders held while CI is green/unknown.
    expect(deriveUnifiedStatus({ ...base, decision: "close" }, { neverClosed: true })).toBe("held");
    expect(deriveUnifiedStatus({ ...base, decision: "close", readiness: { ciState: "failed" } }, { neverClosed: true })).toBe("blocked");
    // Guardrails do not downgrade a close/blocker verdict to held.
    expect(deriveUnifiedStatus({ ...base, decision: "close", readiness: { ciState: "passed" } }, { heldForReview: true })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, decision: "close" }, { heldForReview: true })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, decision: "close", readiness: { ciState: "failed" } }, { heldForReview: true })).toBe("blocked");
    // A genuine contributor close (no guard, not owner/bot) still headlines Closed/blocked.
    expect(deriveUnifiedStatus({ ...base, decision: "close" })).toBe("blocked");
    expect(deriveUnifiedStatus({ ...base, decision: "close", readiness: { ciState: "failed" } })).toBe("blocked");
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
    expect(md).toContain("Gittensory review result - approve/merge recommended · auto-merged");
    expect(md).toContain("Suggested Action - Approve/Merge");
    expect(md).toContain("- auto-merged");
    expect(md).toContain("`2 files`");
    expect(md).toContain("`2 AI reviewers`");
    expect(md).toContain("`no blockers`");
    expect(md).toContain("`readiness 93/100`");
    expect(md).toContain("`CI green`");
    expect(md).toContain("**Review summary**");
    expect(md).toContain("| **Code review** | ✅ No blockers | 2 reviewers, synthesized |");
    expect(md).toContain("| Linked issue | ✅ Linked | #1372 |");
    expect(md).toContain("<details><summary><b>Nits</b> — 1 non-blocking</summary>");
    expect(md).toContain("- [ ] Document the new property.");
    expect(md.indexOf("**Review summary**")).toBeLessThan(md.indexOf("<details><summary><b>Nits</b>"));
    expect(md.indexOf("<details><summary><b>Nits</b>")).toBeLessThan(md.indexOf("| Signal | Result | Evidence |"));
    expect(md).toContain("<details><summary><b>Signal definitions</b></summary>");
    expect(md).toContain("- [ ] Re-run Gittensory review");
    expect(md).toContain("Checked by Gittensory.");
  });

  it("renders the compact review-effort chip only when input.reviewEffort is present — omitted keeps the comment byte-identical (#2069)", () => {
    const withEffort = renderUnifiedReviewComment({ ...base, decision: "merge", reviewEffort: { band: 3, minutes: 15 } }, ctx);
    expect(withEffort).toContain("`review effort: 3/5 (~15 min)`");
    const withoutEffort = renderUnifiedReviewComment({ ...base, decision: "merge" }, ctx);
    expect(withoutEffort).not.toContain("review effort:");
  });

  it("does not describe a single reviewer as synthesized", () => {
    const md = renderUnifiedReviewComment({ ...base, reviewerCount: 1, decision: "manual", recommendations: ["manual_review"] }, ctx);
    expect(md).toContain("`1 AI reviewer`");
    expect(md).toContain("| **Code review** | ✅ No blockers | 1 reviewer |");
    expect(md).not.toContain("1 reviewers, synthesized");
  });

  it("wraps the review body in the colored blockquote but renders the re-run checkbox OUTSIDE it (interactive)", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "merge" }, ctx);
    const lines = md.split("\n");
    const checkboxLine = lines.find((l) => l.includes("Re-run Gittensory review"));
    expect(checkboxLine).toBeDefined();
    // GitHub disables task-list checkboxes inside a blockquote, so the re-run box must be at top level
    // (otherwise it can never be ticked → no issue_comment.edited → the on-demand re-run never fires).
    expect(checkboxLine!.startsWith(">")).toBe(false);
    // The colored sidebar — every non-empty line above the checkbox — IS blockquote-wrapped.
    const bodyAbove = lines.slice(0, lines.indexOf(checkboxLine!)).filter((l) => l.length > 0);
    expect(bodyAbove.every((l) => l.startsWith(">"))).toBe(true);
  });

  it("blocked state uses the caution alert, red bar, and an expanded blockers section", () => {
    const md = renderUnifiedReviewComment(
      { ...base, decision: "close", recommendations: ["close", "close"], blockers: ["Introduces a hardcoded secret."] },
      ctx,
    );
    expect(md).toContain("> [!CAUTION]");
    expect(md).toContain("🟥");
    expect(md).toContain("Suggested Action - Reject/Close");
    expect(md).toContain("Why this is blocked");
    expect(md).toContain("Introduces a hardcoded secret.");
    expect(md).toContain("| **Code review** | ❌ 1 blocker |");
  });

  it("held state uses the warning alert and amber bar", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "manual", recommendations: ["manual_review"] }, ctx);
    expect(md).toContain("> [!WARNING]");
    expect(md).toContain("🟨");
    expect(md).toContain("Suggested Action - Manual Review");
  });

  it("advisory state uses the note alert and blue bar", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "comment", recommendations: [] }, {});
    expect(md).toContain("> [!NOTE]");
    expect(md).toContain("🟦");
    expect(md).toContain("Suggested Action - Advisory Only");
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
    expect(md).not.toContain("Review updated:");
    expect(md.split("\n").some((l) => l.trim() === "> ---")).toBe(false);
  });

  it("renders a UTC freshness marker when the host supplies the review update time", () => {
    const md = renderUnifiedReviewComment(
      { ...base, decision: "merge" },
      { reviewedAt: "2026-06-29T08:05:59.852Z" },
    );
    expect(md).toContain("<sub>Review updated: 2026-06-29 08:05:59 UTC</sub>");
    expect(md.indexOf("Gittensory review result")).toBeLessThan(md.indexOf("<sub>Review updated:"));
    expect(md.indexOf("<sub>Review updated:")).toBeLessThan(md.indexOf("`2 files`"));
    expect(renderUnifiedReviewComment({ ...base, decision: "merge" }, { reviewedAt: "not-a-date" })).not.toContain("Review updated:");
  });

  it("drops blank failing-check details and falls back to bare check names", () => {
    const md = renderUnifiedReviewComment(
      {
        ...base,
        readiness: {
          ciState: "failed",
          failingChecks: ["fallback-check"],
          failingDetails: [{ name: "   " }, { name: "lint" }],
        },
      },
      {},
    );
    expect(md).toContain("CI checks failing");
    expect(md).toContain("- lint");
    expect(md).not.toContain("fallback-check");
  });

  it("only emits provided content (no internal fields leak in)", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "merge" }, ctx);
    expect(md).not.toMatch(/confidenceFloor|scopeCap|hardGuardrailGlobs|rubric/i);
  });

  it("a blocked status from reviewer recs (no close decision) reads 'blocked', not 'closed'", () => {
    const md = renderUnifiedReviewComment({ ...base, recommendations: ["close"], blockers: ["Leaks a token."], consensusBlocker: true }, {});
    expect(md).toContain("> [!CAUTION]");
    expect(md).toContain("Gittensory review result - fixes required"); // headlineLabel(): decision !== "close"
    expect(md).toContain("**🛑 Suggested Action - Fix Blockers**"); // verdictLine(): decision !== "close"
    expect(md).not.toContain("Suggested Action - Reject/Close");
  });

  it("renders CI-failing / CI-pending chips and the merge-state label", () => {
    const failing = renderUnifiedReviewComment({ ...base, readiness: { ciState: "failed", mergeStateLabel: "behind" } }, {});
    expect(failing).toContain("> [!CAUTION]");
    expect(failing).toContain("Gittensory review result - fixes required");
    expect(failing).toContain("Suggested Action - Fix Blockers");
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
    const merged = renderUnifiedReviewComment({ ...base, decision: "merge", merged: true, verdictReason: "all checks green" }, {});
    expect(merged).toContain("**✅ Suggested Action - Approve/Merge**");
    expect(merged).toContain("- all checks green");
    const unmerged = renderUnifiedReviewComment({ ...base, decision: "merge", verdictReason: "looks correct" }, {});
    expect(unmerged).not.toContain("auto-merged"); // the unmerged ready variant
    expect(unmerged).toContain("**✅ Suggested Action - Approve/Merge**");
    expect(unmerged).toContain("- looks correct");
    const advisory = renderUnifiedReviewComment({ ...base, decision: "comment", recommendations: [], verdictReason: "for your awareness" }, {});
    expect(advisory).toContain("**💡 Suggested Action - Advisory Only**");
    expect(advisory).toContain("- for your awareness");
  });

  it("renders suggested-action reasons as bullets below the action line", () => {
    const md = renderUnifiedReviewComment(
      {
        ...base,
        decision: "manual",
        recommendations: ["manual_review"],
        verdictReason: "Touches a guarded path — held for manual review; Touches a maintainer-blocked path — held for manual review",
      },
      {},
    );
    expect(md).toContain("**⏸️ Suggested Action - Manual Review**");
    expect(md).toContain("- Touches a guarded path — held for manual review");
    expect(md).toContain("- Touches a maintainer-blocked path — held for manual review");
    expect(md).not.toContain("Suggested Action - Manual Review — Touches");
  });

  it("renders non-closable failed-CI reviews as red manual-review actions, not reject/close", () => {
    const md = renderUnifiedReviewComment({ ...base, decision: "close", readiness: { ciState: "failed" } }, { neverClosed: true });
    expect(md).toContain("> [!CAUTION]");
    expect(md).toContain("Gittensory review result - fixes required");
    expect(md).toContain("Suggested Action - Manual Review");
    expect(md).toContain("`CI failing`");
    expect(md).not.toContain("Suggested Action - Reject/Close");
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
    expect(md).toContain("- [ ] Nit closes &lt;/details&gt;");
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

  it("threads the caller's reviewEffort estimator output through; omitted when absent (#2069)", () => {
    const withEffort = buildUnifiedReviewInput({ changedFiles: 1, reviews: [reviewNote("merge")], reviewEffort: { band: 2, minutes: 8 } });
    expect(withEffort.reviewEffort).toEqual({ band: 2, minutes: 8 });
    const withoutEffort = buildUnifiedReviewInput({ changedFiles: 1, reviews: [reviewNote("merge")] });
    expect(withoutEffort.reviewEffort).toBeUndefined();
  });
});

describe("renderReviewingPlaceholder", () => {
  it("renders the IMPORTANT (purple) GitHub alert type", () => {
    const body = renderReviewingPlaceholder();
    expect(body).toContain("[!IMPORTANT]");
  });

  it("includes the 🟪 reviewing square in the body and legend", () => {
    const body = renderReviewingPlaceholder();
    // Appears at least twice: the repeating banner and the legend entry.
    expect(body.split("🟪").length).toBeGreaterThan(2);
    expect(body).toContain("🟪 Reviewing");
  });

  it("includes the reviewing-in-progress prose", () => {
    const body = renderReviewingPlaceholder();
    expect(body).toContain("is reviewing");
    expect(body).toContain("in progress");
    expect(body).toContain("will update when the review is complete");
  });

  it("uses the default brand when none is provided", () => {
    expect(renderReviewingPlaceholder()).toContain("Gittensory is reviewing");
  });

  it("respects a custom brand override", () => {
    expect(renderReviewingPlaceholder({ brand: "MyBot" })).toContain("MyBot is reviewing");
  });

  it("angle-escapes HTML in the brand to prevent comment injection", () => {
    const body = renderReviewingPlaceholder({ brand: "<script>alert(1)</script>" });
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("includes the full legend row with all four final-state colors", () => {
    const body = renderReviewingPlaceholder();
    expect(body).toContain("🟩");
    expect(body).toContain("🟦");
    expect(body).toContain("🟨");
    expect(body).toContain("🟥");
  });
});

describe("shouldPostReviewingPlaceholder", () => {
  it("returns true when a live review refresh will post a comment", () => {
    expect(shouldPostReviewingPlaceholder({ reviewWillRun: true, mode: "live", willComment: true })).toBe(true);
  });

  it("returns false when no review refresh is running", () => {
    expect(shouldPostReviewingPlaceholder({ reviewWillRun: false, mode: "live", willComment: true })).toBe(false);
  });

  it("returns false in dry-run mode — placeholder must never write to GitHub in non-live mode", () => {
    expect(shouldPostReviewingPlaceholder({ reviewWillRun: true, mode: "dry_run", willComment: true })).toBe(false);
  });

  it("returns false in paused mode", () => {
    expect(shouldPostReviewingPlaceholder({ reviewWillRun: true, mode: "paused", willComment: true })).toBe(false);
  });

  it("returns false when no comment will be posted — avoids a permanent orphaned purple comment", () => {
    expect(shouldPostReviewingPlaceholder({ reviewWillRun: true, mode: "live", willComment: false })).toBe(false);
  });
});
