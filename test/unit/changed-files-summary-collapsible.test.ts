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

describe("buildChangedFilesSummaryCollapsible per-file diff links (#2157)", () => {
  const context = { repoFullName: "acme/widgets", pullNumber: 42 };

  it("renders one row per file with a View diff link when context is provided", () => {
    const c = buildChangedFilesSummaryCollapsible(files, context);
    expect(c).not.toBeNull();
    expect(c?.body).toContain("| File | Added | Removed | |");
    expect(c?.body).toContain(
      "| `src/app.ts` | +40 | -10 | [View diff](https://github.com/acme/widgets/pull/42/files#diff-",
    );
    expect(c?.body).not.toContain("| Source | 2 | +45 | -10 |");
  });

  it("sorts same-category files by path when context is provided", () => {
    const c = buildChangedFilesSummaryCollapsible(
      [
        { path: "src/z.ts", additions: 1, deletions: 0 },
        { path: "src/a.ts", additions: 2, deletions: 0 },
      ],
      context,
    );
    const body = c?.body ?? "";
    expect(body.indexOf("src/a.ts")).toBeLessThan(body.indexOf("src/z.ts"));
  });

  it("escapes adversarial path characters in per-file rows", () => {
    const c = buildChangedFilesSummaryCollapsible(
      [{ path: "src/weird\\path|`file<1>.ts", additions: 1, deletions: 0 }],
      context,
    );
    expect(c?.body).toContain("&lt;1&gt;");
    expect(c?.body).toContain("\\`");
    expect(c?.body).toContain("\\|");
    expect(c?.body).toContain("\\\\");
  });

  it("omits the View diff link when the path or repo context cannot be anchored", () => {
    const unanchored = buildChangedFilesSummaryCollapsible([{ path: "   ", additions: 1, deletions: 0 }], context);
    expect(unanchored?.body).toContain("| `   ` | +1 | -0 | — |");

    const badRepo = buildChangedFilesSummaryCollapsible(
      [{ path: "src/a.ts", additions: 1, deletions: 0 }],
      { repoFullName: "not-a-repo", pullNumber: 1 },
    );
    expect(badRepo?.body).toContain("| `src/a.ts` | +1 | -0 | — |");
  });

  it("orders per-file rows source-first across categories when context is provided", () => {
    const c = buildChangedFilesSummaryCollapsible(
      [
        { path: "docs/readme.md", additions: 1, deletions: 0 },
        { path: "src/app.ts", additions: 2, deletions: 0 },
      ],
      context,
    );
    const body = c?.body ?? "";
    expect(body.indexOf("src/app.ts")).toBeLessThan(body.indexOf("docs/readme.md"));
  });

  it("escapes a greater-than character in per-file paths", () => {
    const c = buildChangedFilesSummaryCollapsible([{ path: "src/file>name.ts", additions: 1, deletions: 0 }], context);
    expect(c?.body).toContain("&gt;");
  });

  it("keeps collapsed category rows without links when context is omitted", () => {
    const c = buildChangedFilesSummaryCollapsible(files);
    expect(c?.body).toContain("| Source | 2 | +45 | -10 |");
    expect(c?.body).not.toContain("[View diff]");
  });
});

describe("buildChangedFilesSummaryCollapsible (#2145)", () => {
  it("groups changed files by category with file counts and +/- totals", () => {
    const c = buildChangedFilesSummaryCollapsible(files);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Changed files");
    expect(c?.body).toContain("| Category | Files | Added | Removed |");
    expect(c?.body).toContain("| Source | 2 | +45 | -10 |");
    expect(c?.body).toContain("| Test | 1 | +20 | -2 |");
    expect(c?.body).toContain("| Docs | 1 | +3 | -1 |");
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

  it("appends per-file View diff links when changedFilesSummaryContext is present (#2157)", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      changedFilesSummary: files,
      changedFilesSummaryContext: { repoFullName: "acme/widgets", pullNumber: 42 },
    });
    expect(body).toContain("Changed files");
    expect(body).toContain("[View diff](https://github.com/acme/widgets/pull/42/files#diff-");
    expect(body).not.toContain("| Source | 2 | +45 | -10 |");
  });

  it("appends the grouped Changed files section when changedFilesSummary is present without context (#2145)", () => {
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
