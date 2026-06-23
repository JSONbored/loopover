import { describe, expect, it } from "vitest";
import { buildBeforeAfterCollapsible, buildUnifiedCommentBody } from "../../src/review/unified-comment-bridge";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
import type { PublicPrPanelSignalRow } from "../../src/signals/engine";
import type { CaptureRoute } from "../../src/review/visual/capture";

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

const panelRows: PublicPrPanelSignalRow[] = [
  { key: "gateResult", cells: ["Gate result", "✅ Passing", "No configured blocker found.", "No action."] },
];
const footer = "💰 Earn for open-source contributions. Checked by Gittensory.";

const routes: CaptureRoute[] = [
  {
    path: "/app/analytics",
    beforeUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/abc.png",
    afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/def.png",
  },
];

describe("buildBeforeAfterCollapsible", () => {
  it("renders a 'Visual preview' table of clickable-thumbnail cells pointing at the public shot URLs", () => {
    const c = buildBeforeAfterCollapsible(routes);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Visual preview");
    // Trusted raw HTML so the <a>/<img> survive (not angle-escaped).
    expect(c?.rawHtml).toBe(true);
    expect(c?.body).toContain("| Route | Viewport | Before (production) | After (this PR's preview) |");
    expect(c?.body).toContain("`/app/analytics`");
    // Clickable thumbnail: a small <img> wrapped in an <a href> to the SAME full-resolution shot.
    expect(c?.body).toContain('<a href="https://api.example.dev/gittensory/shot?key=gittensory/shots/abc.png"');
    expect(c?.body).toContain('<img width="360"');
    expect(c?.body).toContain("https://api.example.dev/gittensory/shot?key=gittensory/shots/def.png");
    expect(c?.body).not.toContain("![preview]");
  });

  it("renders a dash for a missing slot", () => {
    const c = buildBeforeAfterCollapsible([{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }]);
    expect(c?.body).toContain("| `/` | desktop | — | <a href=");
  });

  it("returns null when no route has any shot URL (no empty table)", () => {
    expect(buildBeforeAfterCollapsible([])).toBeNull();
    expect(buildBeforeAfterCollapsible([{ path: "/" }])).toBeNull();
  });

  it("escapes a pipe in the route path so it can't break the markdown table", () => {
    const c = buildBeforeAfterCollapsible([{ path: "/a|b", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }]);
    expect(c?.body).toContain("`/a\\|b`");
  });

  it("escapes route captions before embedding them in the trusted raw HTML table", () => {
    const c = buildBeforeAfterCollapsible([
      {
        path: "/p`<h2>✅ FORGED APPROVAL</h2><a href=x>maintainer click here</a>",
        afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png",
      },
    ]);
    expect(c?.body).toContain("`/p\\`&lt;h2&gt;✅ FORGED APPROVAL&lt;/h2&gt;&lt;a href=x&gt;maintainer click here&lt;/a&gt;`");
    expect(c?.body).not.toContain("<h2>✅ FORGED APPROVAL</h2>");
    expect(c?.body).not.toContain("<a href=x>maintainer click here</a>");
  });
});

describe("buildUnifiedCommentBody beforeAfter wiring", () => {
  const base = {
    gate: gate(),
    panelRows,
    readinessTotal: 90,
    changedFiles: 3,
    footerMarkdown: footer,
  };

  it("appends the Visual preview section when beforeAfter is present + non-empty", () => {
    const body = buildUnifiedCommentBody({ ...base, beforeAfter: routes });
    expect(body).toContain("Visual preview");
    expect(body).toContain("`/app/analytics`");
    // The shot URL survives the renderer's escaping intact (markdown image syntax, no angle brackets).
    expect(body).toContain("https://api.example.dev/gittensory/shot?key=gittensory/shots/abc.png");
    expect(body).not.toContain("&lt;img");
  });

  it("does NOT add a Visual preview section when beforeAfter is absent (flag-OFF parity)", () => {
    const body = buildUnifiedCommentBody(base);
    expect(body).not.toContain("Visual preview");
  });

  it("does NOT add a Visual preview section when beforeAfter is empty", () => {
    const body = buildUnifiedCommentBody({ ...base, beforeAfter: [] });
    expect(body).not.toContain("Visual preview");
  });

  it("preserves pre-existing extraCollapsibles alongside the Visual preview section", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      extraCollapsibles: [{ title: "Signal definitions", body: "what each row means" }],
      beforeAfter: routes,
    });
    expect(body).toContain("Signal definitions");
    expect(body).toContain("Visual preview");
  });
});
