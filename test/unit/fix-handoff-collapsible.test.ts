import { describe, expect, it } from "vitest";
import { buildFixHandoffCollapsible, buildUnifiedCommentBody, type ImpactMapSummaryInput } from "../../src/review/unified-comment-bridge";
import { buildFixHandoffBlocks } from "../../src/review/fix-handoff-render";
import { LOCAL_WRITE_BOUNDARY } from "../../src/mcp/local-write-tools";
import type { InlineFinding } from "../../src/services/ai-review";
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

// A blocker WITH a suggested change (line-anchored) and a nit WITHOUT one (path-only, line 0) — exercises both
// arms of buildFixHandoffBlock's suggestion + line rendering, which flow through the collapsible verbatim.
const findings: InlineFinding[] = [
  { path: "src/a.ts", line: 10, severity: "blocker", body: "Possible null dereference on the fetched record.", suggestion: "if (record) return record.value;" },
  { path: "src/b.ts", line: 0, severity: "nit", body: "Rename this helper for clarity." },
];
const blocks = buildFixHandoffBlocks(findings);

describe("buildFixHandoffCollapsible (#1962)", () => {
  it("renders one block per finding under a single Fix handoff collapsible", () => {
    const c = buildFixHandoffCollapsible(blocks);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Fix handoff");
    expect(c?.body).toContain("<!-- gittensory:fix-handoff -->");
    expect(c?.body).toContain("`src/a.ts:10`");
    expect(c?.body).toContain("Possible null dereference on the fetched record.");
    expect(c?.body).toContain("Suggested change:");
    // the path-only (no commentable line) block still identifies WHERE to look
    expect(c?.body).toContain("`src/b.ts (no specific line)`");
  });

  it("escapes adversarial paths before rendering inline-code locations", () => {
    const [block] = buildFixHandoffBlocks([
      {
        path: "src/x` [Review required](https://evil.example/phish) | <tag>",
        line: 7,
        severity: "blocker",
        body: "Check the suspicious path rendering.",
      },
    ]);

    expect(block?.path).toBe("src/x` [Review required](https://evil.example/phish) | <tag>");
    expect(block?.body).toContain("`src/x\\` [Review required](https://evil.example/phish) \\| &lt;tag&gt;:7`");
    expect(block?.body).not.toContain("`src/x` [Review required](https://evil.example/phish) | <tag>:7`");
  });

  it("carries the no-server-side-write local-execution boundary on every block", () => {
    expect(buildFixHandoffCollapsible(blocks)?.body).toContain(LOCAL_WRITE_BOUNDARY);
  });

  it("returns null for an empty block list (no empty section)", () => {
    expect(buildFixHandoffCollapsible([])).toBeNull();
  });

  it("is not marked as raw HTML (plain markdown body)", () => {
    expect(buildFixHandoffCollapsible(blocks)?.rawHtml).toBeUndefined();
  });
});

describe("buildUnifiedCommentBody fixHandoff wiring (#1962)", () => {
  const base = {
    gate: gate(),
    panelRows,
    readinessTotal: 90,
    changedFiles: 2,
    footerMarkdown: footer,
  };
  const impactEntries: ImpactMapSummaryInput[] = [
    { changedModule: "src/a.ts", affectedModules: ["src/b.ts"], callers: ["doThing"] },
  ];

  it("appends the Fix handoff section when fixHandoffBlocks is present + non-empty", () => {
    const body = buildUnifiedCommentBody({ ...base, fixHandoffBlocks: blocks });
    expect(body).toContain("Fix handoff");
    expect(body).toMatch(/<details><summary><b>Fix handoff<\/b><\/summary>/);
    expect(body).toContain("Possible null dereference");
  });

  it("does NOT add a Fix handoff section when fixHandoffBlocks is absent (flag-OFF parity)", () => {
    expect(buildUnifiedCommentBody(base)).not.toContain("Fix handoff");
  });

  it("does NOT add a Fix handoff section when fixHandoffBlocks is empty", () => {
    expect(buildUnifiedCommentBody({ ...base, fixHandoffBlocks: [] })).not.toContain("Fix handoff");
  });

  it("coexists with the Impact map and Visual preview sections (all render together)", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      impactMap: impactEntries,
      fixHandoffBlocks: blocks,
      beforeAfter: [{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }],
    });
    expect(body).toContain("Impact map");
    expect(body).toContain("Fix handoff");
    expect(body).toContain("Visual preview");
  });

  it("passes the fix-handoff chain through untouched when only a Visual preview is present (no fix-handoff blocks)", () => {
    // Exercises the withVisual chain's `withFixHandoff ?? []` arm: no blocks ⇒ withFixHandoff is undefined, yet a
    // Visual preview still renders — the fix-handoff link in the collapsible chain must not drop it.
    const body = buildUnifiedCommentBody({
      ...base,
      beforeAfter: [{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }],
    });
    expect(body).toContain("Visual preview");
    expect(body).not.toContain("Fix handoff");
  });

  it("preserves pre-existing extraCollapsibles alongside the Fix handoff section", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      extraCollapsibles: [{ title: "Signal definitions", body: "what each row means" }],
      fixHandoffBlocks: blocks,
    });
    expect(body).toContain("Signal definitions");
    expect(body).toContain("Fix handoff");
  });
});
