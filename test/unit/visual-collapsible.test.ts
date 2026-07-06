import { describe, expect, it } from "vitest";
import { buildBeforeAfterCollapsible, buildUnifiedCommentBody } from "../../src/review/unified-comment-bridge";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
import type { PublicPrPanelSignalRow } from "../../src/signals/engine";
import type { CaptureRoute } from "../../src/review/visual/capture";

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

  it("renders a dash in the Diff column and the plain caption when no route has a diff image (#3674, e.g. hosted builds)", () => {
    const c = buildBeforeAfterCollapsible(routes);
    expect(c?.body).toContain("| Route | Viewport | Before (production) | After (this PR's preview) | Diff |");
    expect(c?.body).toContain("| `/app/analytics` | desktop | <a href=\"https://api.example.dev/gittensory/shot?key=gittensory/shots/abc.png\"");
    expect(c?.body).toMatch(/\| — \|\s*$/m);
    expect(c?.body).not.toContain("Diff highlights exactly what changed");
  });

  it("renders a clickable Diff thumbnail and the diff-aware caption when a route has a diff image (#3674, self-host only)", () => {
    const c = buildBeforeAfterCollapsible([
      {
        path: "/app/analytics",
        beforeUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/abc.png",
        afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/def.png",
        diffUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/abc-diff.png",
      },
    ]);
    expect(c?.body).toContain('<a href="https://api.example.dev/gittensory/shot?key=gittensory/shots/abc-diff.png"');
    expect(c?.body).toContain('alt="diff /app/analytics"');
    expect(c?.body).toContain("Diff highlights exactly what changed");
  });

  it("renders a diffUrlMobile thumbnail on the mobile row independently of the desktop diff cell", () => {
    const c = buildBeforeAfterCollapsible([
      {
        path: "/app/analytics",
        beforeUrlMobile: "https://api.example.dev/gittensory/shot?key=gittensory/shots/abc-m.png",
        afterUrlMobile: "https://api.example.dev/gittensory/shot?key=gittensory/shots/def-m.png",
        diffUrlMobile: "https://api.example.dev/gittensory/shot?key=gittensory/shots/abc-diff-m.png",
      },
    ]);
    expect(c?.body).toContain("| `/app/analytics` | mobile |");
    expect(c?.body).toContain('<a href="https://api.example.dev/gittensory/shot?key=gittensory/shots/abc-diff-m.png"');
    expect(c?.body).toContain('alt="diff /app/analytics (mobile)"');
  });

  it("labels the viewport column with the theme when a route has one (#3678)", () => {
    const c = buildBeforeAfterCollapsible([
      {
        path: "/app/analytics",
        theme: "dark",
        beforeUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/abc.png",
        afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/def.png",
      },
    ]);
    expect(c?.body).toContain("| `/app/analytics` | desktop (dark) |");
    expect(c?.body).toContain('alt="before /app/analytics (dark)"');
    expect(c?.body).toContain('alt="after /app/analytics (dark)"');
  });

  it("leaves the viewport column unlabeled when a route has no theme — byte-identical to pre-#3678", () => {
    const c = buildBeforeAfterCollapsible(routes);
    expect(c?.body).toContain("| `/app/analytics` | desktop |");
    expect(c?.body).not.toContain("desktop (");
  });

  it("combines the theme and mobile labels on the mobile row", () => {
    const c = buildBeforeAfterCollapsible([
      {
        path: "/app/analytics",
        theme: "dark",
        beforeUrlMobile: "https://api.example.dev/gittensory/shot?key=gittensory/shots/abc-m.png",
        afterUrlMobile: "https://api.example.dev/gittensory/shot?key=gittensory/shots/def-m.png",
      },
    ]);
    expect(c?.body).toContain("| `/app/analytics` | mobile (dark) |");
    expect(c?.body).toContain('alt="before /app/analytics (mobile) (dark)"');
  });

  it("renders one row set per theme when the same route appears twice with different themes", () => {
    const c = buildBeforeAfterCollapsible([
      { path: "/", theme: "light", beforeUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/light.png" },
      { path: "/", theme: "dark", beforeUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/dark.png" },
    ]);
    expect(c?.body).toContain("| `/` | desktop (light) |");
    expect(c?.body).toContain("| `/` | desktop (dark) |");
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
