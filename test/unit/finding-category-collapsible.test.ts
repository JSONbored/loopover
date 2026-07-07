import { describe, expect, it } from "vitest";
import { buildFindingCategoryCollapsible, buildUnifiedCommentBody, type FindingCategoryInput } from "../../src/review/unified-comment-bridge";
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

const findings: FindingCategoryInput[] = [
  { path: "src/db.ts", body: "This is vulnerable to SQL injection.", category: "security" },
  { path: "src/util.ts", body: "This will throw on an empty array." }, // no category — falls back to classifyFindingCategory
  { path: "src/app.test.ts", body: "Assert the right value here." },
];

describe("buildFindingCategoryCollapsible (#1958)", () => {
  it("counts findings by category, using the finding's own category when present", () => {
    const c = buildFindingCategoryCollapsible(findings);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Finding categories");
    expect(c?.body).toContain("| Category | Findings |");
    expect(c?.body).toContain("| Security | 1 |");
  });

  it("falls back to classifyFindingCategory for a finding missing its own category (never dropped)", () => {
    const c = buildFindingCategoryCollapsible(findings);
    // src/util.ts's body matches no keyword bucket and isn't a test path → correctness.
    expect(c?.body).toContain("| Correctness | 1 |");
    // src/app.test.ts is a test path → tests, regardless of its body wording.
    expect(c?.body).toContain("| Tests | 1 |");
  });

  it("collapses multiple findings of the same category into one row with a summed count", () => {
    const c = buildFindingCategoryCollapsible([
      { path: "src/a.ts", body: "Fix this bug.", category: "correctness" },
      { path: "src/b.ts", body: "Fix that bug too.", category: "correctness" },
    ]);
    expect(c?.body).toContain("| Correctness | 2 |");
  });

  it("orders rows security-first, matching the fixed FINDING_CATEGORIES order", () => {
    const c = buildFindingCategoryCollapsible([
      { path: "src/a.ts", body: "style nit: naming", category: "style" },
      { path: "src/b.ts", body: "sql injection risk", category: "security" },
    ]);
    const body = c?.body ?? "";
    expect(body.indexOf("| Security")).toBeLessThan(body.indexOf("| Style"));
  });

  it("omits a category with no findings (no zero rows)", () => {
    const c = buildFindingCategoryCollapsible([{ path: "src/a.ts", body: "Fix this.", category: "correctness" }]);
    expect(c?.body).toContain("| Correctness | 1 |");
    expect(c?.body).not.toContain("Security");
    expect(c?.body).not.toContain("Performance");
  });

  it("returns null for an empty finding list (no empty table)", () => {
    expect(buildFindingCategoryCollapsible([])).toBeNull();
  });

  it("is not marked as raw HTML (plain markdown table)", () => {
    const c = buildFindingCategoryCollapsible(findings);
    expect(c?.rawHtml).toBeUndefined();
  });
});

describe("buildUnifiedCommentBody findingCategories wiring (#1958)", () => {
  const base = {
    gate: gate(),
    panelRows,
    readinessTotal: 90,
    changedFiles: 3,
    footerMarkdown: footer,
  };

  it("appends both category summaries when findingCategories is present + non-empty", () => {
    const body = buildUnifiedCommentBody({ ...base, findingCategories: findings });
    expect(body).toContain("**Findings by category:** 1 security");
    expect(body).toContain("Finding categories");
    expect(body).toContain("| Security | 1 |");
  });

  it("does NOT add category summaries when findingCategories is absent (flag-OFF parity)", () => {
    const body = buildUnifiedCommentBody(base);
    expect(body).not.toContain("Findings by category");
    expect(body).not.toContain("Finding categories");
  });

  it("does NOT add category summaries when findingCategories is empty", () => {
    const body = buildUnifiedCommentBody({ ...base, findingCategories: [] });
    expect(body).not.toContain("Findings by category");
    expect(body).not.toContain("Finding categories");
  });

  it("preserves pre-existing extraCollapsibles alongside the Finding categories section", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      extraCollapsibles: [{ title: "Signal definitions", body: "what each row means" }],
      findingCategories: findings,
    });
    expect(body).toContain("Signal definitions");
    expect(body).toContain("Finding categories");
  });

  it("coexists with the Changed files section (both collapsibles render, in order)", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      changedFilesSummary: [{ path: "src/app.ts", additions: 5, deletions: 1 }],
      findingCategories: findings,
    });
    expect(body).toContain("Changed files");
    expect(body).toContain("Finding categories");
    expect(body.indexOf("Changed files")).toBeLessThan(body.indexOf("Finding categories"));
  });
});
