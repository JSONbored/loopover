import { describe, expect, it, vi } from "vitest";
import {
  buildUnifiedCommentBody,
  deriveAutoMergeConditionsFromSignals,
} from "../../src/review/unified-comment-bridge";
import * as unifiedComment from "../../src/review/unified-comment";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
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

const panelRowsPassing: PublicPrPanelSignalRow[] = [
  { key: "linkedIssue", cells: ["Linked issue", "✅ Linked", "#42", "No action."] },
  { key: "gateResult", cells: ["Gate result", "✅ Passing", "No configured blocker found.", "No action."] },
];

const footer = "💰 Earn for open-source contributions. Checked by Gittensory.";

describe("buildAutoMergeSummaryCollapsible", () => {
  it("renders a four-row read-only conditions table", () => {
    const conditions = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "passed", mergeStateLabel: "clean" },
      panelRows: panelRowsPassing,
    });
    const c = unifiedComment.buildAutoMergeSummaryCollapsible(conditions);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Auto-merge conditions");
    expect(c?.body).toContain("| Condition | Status | Evidence |");
    expect(c?.body).toContain("| CI green | ✅ |");
    expect(c?.body).toContain("| Gate passing | ✅ |");
    expect(c?.body).toContain("| Mergeable / clean | ✅ |");
    expect(c?.body).toContain("| Valid linked issue | ✅ |");
    expect(c?.body).toContain("Does not change the merge decision");
  });

  it("returns null for an empty condition list", () => {
    expect(unifiedComment.buildAutoMergeSummaryCollapsible([])).toBeNull();
  });
});

describe("deriveAutoMergeConditionsFromSignals", () => {
  it("maps failing CI, gate failure, dirty merge state, and missing linked issue to fail/warn states", () => {
    const rows = deriveAutoMergeConditionsFromSignals({
      gate: gate({ conclusion: "failure" }),
      mergeReadiness: {
        ciState: "failed",
        mergeStateLabel: "dirty",
        failingChecks: ["codecov/patch"],
      },
      panelRows: [
        { key: "linkedIssue", cells: ["Linked issue", "⚠️ Missing", "No linked issue or no-issue rationale found.", "Explain no-issue PR."] },
        { key: "gateResult", cells: ["Gate result", "❌ Blocking", "Repo-configured hard blocker found.", "Fix blocker."] },
      ],
    });
    expect(rows.map((row) => row.state)).toEqual(["fail", "fail", "fail", "warn"]);
    expect(rows[0]?.evidence).toContain("codecov/patch");
    expect(rows[2]?.evidence).toContain("dirty");
  });

  it("falls back to gate fields when the gateResult panel row is absent", () => {
    const rows = deriveAutoMergeConditionsFromSignals({
      gate: gate({ enabled: false, conclusion: "skipped" }),
      mergeReadiness: { ciState: "unverified" },
      panelRows: [],
    });
    expect(rows.find((row) => row.condition === "Gate passing")?.state).toBe("warn");
    expect(rows.find((row) => row.condition === "CI green")?.state).toBe("warn");
    expect(rows.find((row) => row.condition === "Mergeable / clean")?.state).toBe("warn");
    expect(rows.find((row) => row.condition === "Valid linked issue")?.state).toBe("warn");
  });

  it("does not invoke deriveUnifiedStatus — display-only derivation from pre-computed signals (#2051)", () => {
    const spy = vi.spyOn(unifiedComment, "deriveUnifiedStatus");
    deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "passed", mergeStateLabel: "clean" },
      panelRows: panelRowsPassing,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("buildUnifiedCommentBody autoMergeSummary wiring (#2051)", () => {
  const base = {
    gate: gate(),
    panelRows: panelRowsPassing,
    readinessTotal: 90,
    changedFiles: 2,
    mergeReadiness: { ciState: "passed" as const, mergeStateLabel: "clean" },
    footerMarkdown: footer,
  };

  it("appends the Auto-merge conditions section when autoMergeSummary is on", () => {
    const body = buildUnifiedCommentBody({ ...base, autoMergeSummary: true });
    expect(body).toContain("Auto-merge conditions");
    expect(body).toContain("| CI green | ✅ |");
    expect(body).toContain("| Valid linked issue | ✅ |");
  });

  it("does NOT add the section when autoMergeSummary is absent (flag-OFF parity)", () => {
    const body = buildUnifiedCommentBody(base);
    expect(body).not.toContain("Auto-merge conditions");
  });

  it("coexists with Changed files and Visual preview collapsibles", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      autoMergeSummary: true,
      changedFilesSummary: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
      beforeAfter: [{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }],
    });
    expect(body).toContain("Auto-merge conditions");
    expect(body).toContain("Changed files");
    expect(body).toContain("Visual preview");
    expect(body.indexOf("Auto-merge conditions")).toBeLessThan(body.indexOf("Changed files"));
  });
});
