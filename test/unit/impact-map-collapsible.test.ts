import { describe, expect, it } from "vitest";
import { buildImpactMapCollapsible, buildUnifiedCommentBody, type ImpactMapSummaryInput } from "../../src/review/unified-comment-bridge";
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

const entries: ImpactMapSummaryInput[] = [
  { changedModule: "src/review/impact-map.ts", affectedModules: ["src/review/impact-map-wire.ts", "src/queue/processors.ts"], callers: ["computeImpactMap"] },
];

describe("buildImpactMapCollapsible (#2185)", () => {
  it("renders one row per changed module with its symbols and affected modules", () => {
    const c = buildImpactMapCollapsible(entries);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Impact map");
    expect(c?.body).toContain("| Changed module | Symbols | Plausibly affected |");
    expect(c?.body).toContain("`src/review/impact-map.ts`");
    expect(c?.body).toContain("computeImpactMap");
    expect(c?.body).toContain("`src/review/impact-map-wire.ts`");
    expect(c?.body).toContain("`src/queue/processors.ts`");
  });

  it("renders a dash for callers when a row somehow has none", () => {
    const c = buildImpactMapCollapsible([{ changedModule: "src/a.ts", affectedModules: ["src/b.ts"], callers: [] }]);
    expect(c?.body).toContain("| `src/a.ts` | — |");
  });

  it("caps rendered affected modules with a '+N more' overflow line", () => {
    const many = Array.from({ length: 8 }, (_, i) => `src/caller${i}.ts`);
    const c = buildImpactMapCollapsible([{ changedModule: "src/a.ts", affectedModules: many, callers: ["a"] }]);
    const body = c?.body ?? "";
    expect(body).toContain("`src/caller0.ts`");
    expect(body).toContain("`src/caller4.ts`");
    expect(body).not.toContain("`src/caller5.ts`");
    expect(body).toContain("(+3 more)");
  });

  it("does not render an overflow suffix when affected modules are within the cap", () => {
    const c = buildImpactMapCollapsible([{ changedModule: "src/a.ts", affectedModules: ["src/b.ts"], callers: ["a"] }]);
    expect(c?.body).not.toContain("more)");
  });

  it("escapes a hostile-looking path so it can't break out of the table/inline-code span", () => {
    const c = buildImpactMapCollapsible([{ changedModule: "src/`weird|<path>.ts", affectedModules: ["src/b.ts"], callers: ["a"] }]);
    expect(c?.body).toContain("src/\\`weird\\|&lt;path&gt;.ts");
  });

  it("returns null for an empty entry list (no empty table)", () => {
    expect(buildImpactMapCollapsible([])).toBeNull();
  });

  it("is not marked as raw HTML (plain markdown table)", () => {
    expect(buildImpactMapCollapsible(entries)?.rawHtml).toBeUndefined();
  });

  it("includes the deterministic disclaimer note", () => {
    expect(buildImpactMapCollapsible(entries)?.body).toContain("Deterministic — from the codebase index");
  });
});

describe("buildUnifiedCommentBody impactMap wiring (#2185)", () => {
  const base = {
    gate: gate(),
    panelRows,
    readinessTotal: 90,
    changedFiles: 3,
    footerMarkdown: footer,
  };

  it("appends the Impact map section when impactMap is present + non-empty", () => {
    const body = buildUnifiedCommentBody({ ...base, impactMap: entries });
    expect(body).toContain("Impact map");
    expect(body).toContain("computeImpactMap");
    expect(body).toMatch(/<details><summary><b>Impact map<\/b><\/summary>/);
  });

  it("does NOT add an Impact map section when impactMap is absent (flag-OFF parity)", () => {
    const body = buildUnifiedCommentBody(base);
    expect(body).not.toContain("Impact map");
  });

  it("does NOT add an Impact map section when impactMap is empty", () => {
    const body = buildUnifiedCommentBody({ ...base, impactMap: [] });
    expect(body).not.toContain("Impact map");
  });

  it("coexists with the Changed files and Finding categories sections", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      changedFilesSummary: [{ path: "src/app.ts", additions: 10, deletions: 2 }],
      impactMap: entries,
    });
    expect(body).toContain("Changed files");
    expect(body).toContain("Impact map");
  });

  it("coexists with the Visual preview section (both collapsibles render)", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      impactMap: entries,
      beforeAfter: [{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }],
    });
    expect(body).toContain("Impact map");
    expect(body).toContain("Visual preview");
  });

  it("preserves pre-existing extraCollapsibles alongside the Impact map section", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      extraCollapsibles: [{ title: "Signal definitions", body: "what each row means" }],
      impactMap: entries,
    });
    expect(body).toContain("Signal definitions");
    expect(body).toContain("Impact map");
  });
});
