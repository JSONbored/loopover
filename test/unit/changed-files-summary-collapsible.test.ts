import { describe, expect, it } from "vitest";
import { buildChangedFilesSummaryCollapsible, buildUnifiedCommentBody, type ChangedFileSummaryInput } from "../../src/review/unified-comment-bridge";
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

const panelRows: PublicPrPanelSignalRow[] = [
  { key: "gateResult", cells: ["Gate result", "✅ Passing", "No configured blocker found.", "No action."] },
];
const footer = "💰 Earn for open-source contributions. Checked by Gittensory.";

const files: ChangedFileSummaryInput[] = [
  { path: "src/app.ts", additions: 40, deletions: 10 },
  { path: "src/util.ts", additions: 5, deletions: 0 },
  { path: "test/unit/app.test.ts", additions: 20, deletions: 2 },
  { path: "docs/guide.md", additions: 3, deletions: 1 },
  { path: "package-lock.json", additions: 100, deletions: 50 },
];

describe("buildChangedFilesSummaryCollapsible (#2145)", () => {
  it("groups changed files by category with file counts and +/- totals", () => {
    const c = buildChangedFilesSummaryCollapsible(files);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Changed files");
    expect(c?.body).toContain("| Category | Files | Added | Removed |");
    // Two source files collapse into ONE row with summed totals (45 = 40 + 5, 10 = 10 + 0).
    expect(c?.body).toContain("| Source | 2 | +45 | -10 |");
    expect(c?.body).toContain("| Test | 1 | +20 | -2 |");
    expect(c?.body).toContain("| Docs | 1 | +3 | -1 |");
    // A lockfile classifies as generated.
    expect(c?.body).toContain("| Generated | 1 | +100 | -50 |");
  });

  it("orders rows source-first, generated-last, regardless of input order", () => {
    const c = buildChangedFilesSummaryCollapsible([...files].reverse());
    const body = c?.body ?? "";
    const order = ["| Source", "| Test", "| Docs", "| Generated"].map((marker) => body.indexOf(marker));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    order.forEach((index) => expect(index).toBeGreaterThan(-1));
  });

  it("omits a category with no changed files (no zero rows)", () => {
    const c = buildChangedFilesSummaryCollapsible([{ path: "src/app.ts", additions: 1, deletions: 1 }]);
    expect(c?.body).toContain("| Source | 1 | +1 | -1 |");
    expect(c?.body).not.toContain("Test");
    expect(c?.body).not.toContain("Docs");
    expect(c?.body).not.toContain("Config");
    expect(c?.body).not.toContain("Generated");
  });

  it("returns null for an empty file list (no empty table)", () => {
    expect(buildChangedFilesSummaryCollapsible([])).toBeNull();
  });

  it("is not marked as raw HTML (plain markdown table)", () => {
    const c = buildChangedFilesSummaryCollapsible(files);
    expect(c?.rawHtml).toBeUndefined();
  });
});

describe("buildUnifiedCommentBody changedFilesSummary wiring (#1957 / #2145)", () => {
  const base = {
    gate: gate(),
    panelRows,
    readinessTotal: 90,
    changedFiles: 3,
    footerMarkdown: footer,
  };

  it("appends the Changed files section when changedFilesSummary is present + non-empty", () => {
    const body = buildUnifiedCommentBody({ ...base, changedFilesSummary: files });
    expect(body).toContain("Changed files");
    expect(body).toContain("| Source | 2 | +45 | -10 |");
    expect(body).toMatch(/<details><summary><b>Changed files<\/b><\/summary>/);
  });

  it("does NOT add a Changed files section when changedFilesSummary is absent (flag-OFF parity)", () => {
    const body = buildUnifiedCommentBody(base);
    expect(body).not.toContain("Changed files");
  });

  it("does NOT add a Changed files section when changedFilesSummary is empty", () => {
    const body = buildUnifiedCommentBody({ ...base, changedFilesSummary: [] });
    expect(body).not.toContain("Changed files");
  });

  it("preserves pre-existing extraCollapsibles alongside the Changed files section", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      extraCollapsibles: [{ title: "Signal definitions", body: "what each row means" }],
      changedFilesSummary: files,
    });
    expect(body).toContain("Signal definitions");
    expect(body).toContain("Changed files");
  });

  it("coexists with the Visual preview section (both collapsibles render)", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      changedFilesSummary: files,
      beforeAfter: [{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }],
    });
    expect(body).toContain("Changed files");
    expect(body).toContain("Visual preview");
  });
});
