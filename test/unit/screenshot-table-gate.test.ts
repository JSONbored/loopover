import { describe, expect, it } from "vitest";
import {
  buildScreenshotMatrixMessage,
  DEFAULT_SCREENSHOT_CONTRACT_MESSAGE,
  DEFAULT_SCREENSHOT_TABLE_GATE,
  evaluateScreenshotTableGate,
  extractTableRowImageUrls,
  extractTableRows,
  hasCommittedImageFile,
  hasImageBearingMarkdownTable,
  hasImageOutsideTable,
  isScreenshotTableGateAction,
  isScreenshotTableGateInScope,
  missingScreenshotMatrixPairs,
  normalizeScreenshotTableGateConfig,
  requiredScreenshotMatrixPairs,
  CAPTURE_UNOBTAINABLE_REASON,
  type ScreenshotMatrixPair,
} from "../../src/review/screenshot-table-gate";
import type { ScreenshotTableGateConfig } from "../../src/types";

function config(overrides: Partial<ScreenshotTableGateConfig> = {}): ScreenshotTableGateConfig {
  return { ...DEFAULT_SCREENSHOT_TABLE_GATE, whenLabels: [], whenPaths: [], ...overrides };
}

const TABLE_BODY = ["| Before | After |", "| --- | --- |", "| ![before](https://x/before.png) | ![after](https://x/after.png) |"].join("\n");

describe("isScreenshotTableGateAction", () => {
  it("accepts both valid actions", () => {
    expect(isScreenshotTableGateAction("close")).toBe(true);
    expect(isScreenshotTableGateAction("advisory")).toBe(true);
  });

  it("rejects a non-string or unknown value", () => {
    expect(isScreenshotTableGateAction("hold")).toBe(false);
    expect(isScreenshotTableGateAction(123)).toBe(false);
    expect(isScreenshotTableGateAction(undefined)).toBe(false);
  });

  it("rejects request_changes/comment (#4110 removed as dead config surface)", () => {
    expect(isScreenshotTableGateAction("request_changes")).toBe(false);
    expect(isScreenshotTableGateAction("comment")).toBe(false);
  });
});

describe("hasImageBearingMarkdownTable", () => {
  it("detects a markdown table with image cells (before/after markup)", () => {
    expect(hasImageBearingMarkdownTable(TABLE_BODY)).toBe(true);
  });

  it("detects an <img> tag inside a table cell too", () => {
    const body = ["| Before | After |", "| --- | --- |", '| <img src="a.png"> | <img src="b.png"> |'].join("\n");
    expect(hasImageBearingMarkdownTable(body)).toBe(true);
  });

  it("returns false for a table with no image markup in any row", () => {
    const body = ["| Before | After |", "| --- | --- |", "| looks the same | looks the same |"].join("\n");
    expect(hasImageBearingMarkdownTable(body)).toBe(false);
  });

  it("returns false when there is no table at all", () => {
    expect(hasImageBearingMarkdownTable("Just a plain description, no table here.")).toBe(false);
  });

  it("returns false for a header row with no valid separator row beneath it", () => {
    const body = ["| Before | After |", "not a separator", "| ![a](x.png) | ![b](y.png) |"].join("\n");
    expect(hasImageBearingMarkdownTable(body)).toBe(false);
  });

  it("returns false for null/undefined/empty body", () => {
    expect(hasImageBearingMarkdownTable(null)).toBe(false);
    expect(hasImageBearingMarkdownTable(undefined)).toBe(false);
    expect(hasImageBearingMarkdownTable("")).toBe(false);
  });

  it("supports an aligned separator row (:---:, ---:, etc.)", () => {
    const body = ["| Before | After |", "|:---:|:---:|", "| ![a](x.png) | ![b](y.png) |"].join("\n");
    expect(hasImageBearingMarkdownTable(body)).toBe(true);
  });

  it("rejects long whitespace-only separator candidates without hanging", () => {
    const whitespace = " ".repeat(8_000);
    const body = ["| Before | After |", whitespace, "| ![a](x.png) | ![b](y.png) |"].join("\n");
    const started = performance.now();
    expect(hasImageBearingMarkdownTable(body)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("rejects a separator candidate that has dashes but a non-separator cell", () => {
    const body = ["| Before | After |", "| --- | notasep |", "| ![a](x.png) | ![b](y.png) |"].join("\n");
    expect(hasImageBearingMarkdownTable(body)).toBe(false);
  });
});

describe("hasImageOutsideTable", () => {
  it("detects a bare inline image outside any table", () => {
    expect(hasImageOutsideTable("Here is my before screenshot: ![before](https://x/before.png)")).toBe(true);
  });

  it("returns false when the only image markup is inside a table row", () => {
    expect(hasImageOutsideTable(TABLE_BODY)).toBe(false);
  });

  it("returns false for a body with no image markup at all", () => {
    expect(hasImageOutsideTable("No images here.")).toBe(false);
  });

  it("returns false for null/undefined/empty body", () => {
    expect(hasImageOutsideTable(null)).toBe(false);
    expect(hasImageOutsideTable(undefined)).toBe(false);
    expect(hasImageOutsideTable("")).toBe(false);
  });
});

describe("hasCommittedImageFile", () => {
  it("flags a committed image file under a scoped path", () => {
    expect(hasCommittedImageFile(["apps/ui/src/screenshot.png"], ["apps/ui/**"])).toBe(true);
  });

  it("does not flag an image file OUTSIDE the scoped paths", () => {
    expect(hasCommittedImageFile(["docs/logo.png"], ["apps/ui/**"])).toBe(false);
  });

  it("checks every changed path when scopedPaths is empty", () => {
    expect(hasCommittedImageFile(["random/screenshot.jpg"], [])).toBe(true);
  });

  it("does not flag a non-image file", () => {
    expect(hasCommittedImageFile(["apps/ui/src/component.tsx"], ["apps/ui/**"])).toBe(false);
  });

  it("never flags a committed SVG (excluded from the image-extension set)", () => {
    expect(hasCommittedImageFile(["apps/ui/src/icon.svg"], [])).toBe(false);
  });

  it("matches every accepted raster extension case-insensitively", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".PNG"]) {
      expect(hasCommittedImageFile([`apps/ui/shot${ext}`], [])).toBe(true);
    }
  });
});

describe("isScreenshotTableGateInScope", () => {
  it("is in scope for every PR when both whenLabels and whenPaths are empty", () => {
    expect(isScreenshotTableGateInScope(config(), [], [])).toBe(true);
  });

  it("matches on label (case-insensitive)", () => {
    expect(isScreenshotTableGateInScope(config({ whenLabels: ["Frontend"] }), ["frontend"], [])).toBe(true);
  });

  it("matches on path glob", () => {
    expect(isScreenshotTableGateInScope(config({ whenPaths: ["apps/ui/**"] }), [], ["apps/ui/src/App.tsx"])).toBe(true);
  });

  it("is out of scope when neither labels nor paths match (both configured)", () => {
    expect(isScreenshotTableGateInScope(config({ whenLabels: ["frontend"], whenPaths: ["apps/ui/**"] }), ["backend"], ["src/api/routes.ts"])).toBe(false);
  });

  it("label match alone is sufficient even when whenPaths is also configured and doesn't match", () => {
    expect(isScreenshotTableGateInScope(config({ whenLabels: ["frontend"], whenPaths: ["apps/ui/**"] }), ["frontend"], ["src/api/routes.ts"])).toBe(true);
  });

  it("path match alone is sufficient even when whenLabels is also configured and doesn't match", () => {
    expect(isScreenshotTableGateInScope(config({ whenLabels: ["frontend"], whenPaths: ["apps/ui/**"] }), ["backend"], ["apps/ui/src/App.tsx"])).toBe(true);
  });

  it("only whenLabels configured (whenPaths empty) -- scope decided purely by label", () => {
    expect(isScreenshotTableGateInScope(config({ whenLabels: ["frontend"] }), ["backend"], ["apps/ui/src/App.tsx"])).toBe(false);
  });

  it("only whenPaths configured (whenLabels empty) -- scope decided purely by path", () => {
    expect(isScreenshotTableGateInScope(config({ whenPaths: ["apps/ui/**"] }), ["frontend"], ["src/api/routes.ts"])).toBe(false);
  });
});

describe("normalizeScreenshotTableGateConfig", () => {
  it("returns the disabled default for undefined/null input", () => {
    expect(normalizeScreenshotTableGateConfig(undefined, [])).toEqual(config());
    expect(normalizeScreenshotTableGateConfig(null, [])).toEqual(config());
  });

  it("warns and falls back to default for a non-object input", () => {
    const warnings: string[] = [];
    expect(normalizeScreenshotTableGateConfig("nope", warnings)).toEqual(config());
    expect(warnings).toEqual(["settings.requireScreenshotTable must be an object; using the default (disabled)."]);
  });

  it("warns and falls back to default for an array input", () => {
    const warnings: string[] = [];
    expect(normalizeScreenshotTableGateConfig([], warnings)).toEqual(config());
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("parses a fully valid object", () => {
    const result = normalizeScreenshotTableGateConfig(
      { enabled: true, whenLabels: ["frontend", "visual"], whenPaths: ["apps/ui/**"], action: "close", message: "custom text" },
      [],
    );
    expect(result).toEqual({ enabled: true, whenLabels: ["frontend", "visual"], whenPaths: ["apps/ui/**"], action: "close", requireViewports: [], requireThemes: [], message: "custom text" });
  });

  it("rejects a non-boolean enabled with a warning, falling back to false", () => {
    const warnings: string[] = [];
    expect(normalizeScreenshotTableGateConfig({ enabled: "yes" }, warnings).enabled).toBe(false);
    expect(warnings.some((w) => w.includes("enabled"))).toBe(true);
  });

  it("rejects an invalid action with a warning, falling back to close", () => {
    const warnings: string[] = [];
    expect(normalizeScreenshotTableGateConfig({ action: "delete" }, warnings).action).toBe("close");
    expect(warnings.some((w) => w.includes("action"))).toBe(true);
  });

  it("rejects the removed request_changes/comment values (#4110), falling back to close", () => {
    const warnings: string[] = [];
    expect(normalizeScreenshotTableGateConfig({ action: "request_changes" }, warnings).action).toBe("close");
    expect(normalizeScreenshotTableGateConfig({ action: "comment" }, []).action).toBe("close");
    expect(warnings.some((w) => w.includes("action"))).toBe(true);
  });

  it("#9996: the invalid-action warning names all three valid tiers, including block", () => {
    const warnings: string[] = [];
    const result = normalizeScreenshotTableGateConfig({ enabled: true, action: "blok" }, warnings);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("block");
    expect(result.action).toBe("close");
  });

  it("#9996: an absent action still pushes no warning", () => {
    const warnings: string[] = [];
    normalizeScreenshotTableGateConfig({ enabled: true }, warnings);
    expect(warnings.length).toBe(0);
  });

  it("#9996: a valid block action resolves with no warning", () => {
    const warnings: string[] = [];
    const result = normalizeScreenshotTableGateConfig({ enabled: true, action: "block" }, warnings);
    expect(result.action).toBe("block");
    expect(warnings.length).toBe(0);
  });

  it("rejects a non-string/empty message with a warning, falling back to undefined", () => {
    const warnings: string[] = [];
    const result = normalizeScreenshotTableGateConfig({ message: "   " }, warnings);
    expect(result.message).toBeUndefined();
    expect(warnings.some((w) => w.includes("message"))).toBe(true);
  });

  it("accepts a valid non-empty message and trims it", () => {
    expect(normalizeScreenshotTableGateConfig({ message: "  hi  " }, []).message).toBe("hi");
  });

  it("rejects a non-array whenLabels/whenPaths with a warning, falling back to []", () => {
    const warnings: string[] = [];
    const result = normalizeScreenshotTableGateConfig({ whenLabels: "frontend", whenPaths: "apps/ui" }, warnings);
    expect(result.whenLabels).toEqual([]);
    expect(result.whenPaths).toEqual([]);
    expect(warnings.length).toBe(2);
  });

  it("drops non-string/empty entries within whenLabels/whenPaths with a warning per entry", () => {
    const warnings: string[] = [];
    const result = normalizeScreenshotTableGateConfig({ whenLabels: ["frontend", "", 5, "  "], whenPaths: [42] }, warnings);
    expect(result.whenLabels).toEqual(["frontend"]);
    expect(result.whenPaths).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("caps whenLabels/whenPaths at their max entry count", () => {
    const warnings: string[] = [];
    const many = Array.from({ length: 60 }, (_, i) => `label-${i}`);
    const result = normalizeScreenshotTableGateConfig({ whenLabels: many }, warnings);
    expect(result.whenLabels.length).toBe(50);
    expect(warnings.some((w) => w.includes("capped"))).toBe(true);
  });

  it("accepts the new advisory action", () => {
    expect(normalizeScreenshotTableGateConfig({ action: "advisory" }, []).action).toBe("advisory");
  });

  it("parses requireViewports/requireThemes, trimming and defaulting to empty (#4535)", () => {
    expect(normalizeScreenshotTableGateConfig({}, []).requireViewports).toEqual([]);
    expect(normalizeScreenshotTableGateConfig({}, []).requireThemes).toEqual([]);
    const result = normalizeScreenshotTableGateConfig({ requireViewports: [" Desktop ", "Tablet", "Mobile"], requireThemes: [" Light ", "Dark"] }, []);
    expect(result.requireViewports).toEqual(["Desktop", "Tablet", "Mobile"]);
    expect(result.requireThemes).toEqual(["Light", "Dark"]);
  });

  it("rejects a non-array requireViewports/requireThemes with a warning, falling back to []", () => {
    const warnings: string[] = [];
    const result = normalizeScreenshotTableGateConfig({ requireViewports: "desktop", requireThemes: "light" }, warnings);
    expect(result.requireViewports).toEqual([]);
    expect(result.requireThemes).toEqual([]);
    expect(warnings.length).toBe(2);
  });

  it("caps requireViewports/requireThemes at their max entry count", () => {
    const warnings: string[] = [];
    const many = Array.from({ length: 20 }, (_, i) => `viewport-${i}`);
    const result = normalizeScreenshotTableGateConfig({ requireViewports: many }, warnings);
    expect(result.requireViewports.length).toBe(12);
    expect(warnings.some((w) => w.includes("capped"))).toBe(true);
  });

  it("accepts a valid skillFileUrl and trims it (#4540 follow-up)", () => {
    const url = "  https://github.com/JSONbored/metagraphed/blob/main/.claude/skills/metagraphed/SKILL.md  ";
    expect(normalizeScreenshotTableGateConfig({ skillFileUrl: url }, []).skillFileUrl).toBe(url.trim());
  });

  it("defaults skillFileUrl to undefined when unset", () => {
    expect(normalizeScreenshotTableGateConfig({}, []).skillFileUrl).toBeUndefined();
  });

  it("rejects a non-string/empty/overlong skillFileUrl with a warning, falling back to undefined", () => {
    const warnings: string[] = [];
    expect(normalizeScreenshotTableGateConfig({ skillFileUrl: "   " }, warnings).skillFileUrl).toBeUndefined();
    expect(normalizeScreenshotTableGateConfig({ skillFileUrl: 42 }, []).skillFileUrl).toBeUndefined();
    expect(normalizeScreenshotTableGateConfig({ skillFileUrl: "x".repeat(301) }, []).skillFileUrl).toBeUndefined();
    expect(warnings.some((w) => w.includes("skillFileUrl"))).toBe(true);
  });
});

describe("requiredScreenshotMatrixPairs (#4535)", () => {
  it("returns [] (matrix mode off) when requireViewports is empty, regardless of requireThemes", () => {
    expect(requiredScreenshotMatrixPairs(config({ requireViewports: [], requireThemes: ["light", "dark"] }))).toEqual([]);
    expect(requiredScreenshotMatrixPairs(config())).toEqual([]);
  });

  it("returns one theme:null pair per viewport when requireThemes is empty (viewport-only mode)", () => {
    expect(requiredScreenshotMatrixPairs(config({ requireViewports: ["Desktop", "Mobile"], requireThemes: [] }))).toEqual([
      { viewport: "Desktop", theme: null },
      { viewport: "Mobile", theme: null },
    ]);
  });

  it("returns the full cartesian product when both dimensions are configured", () => {
    expect(requiredScreenshotMatrixPairs(config({ requireViewports: ["Desktop", "Mobile"], requireThemes: ["Light", "Dark"] }))).toEqual([
      { viewport: "Desktop", theme: "Light" },
      { viewport: "Desktop", theme: "Dark" },
      { viewport: "Mobile", theme: "Light" },
      { viewport: "Mobile", theme: "Dark" },
    ]);
  });
});

describe("extractTableRows", () => {
  it("extracts a crafted separator-only table once instead of duplicating overlapping regions", () => {
    const body = Array.from({ length: 40 }, () => "| --- |").join("\n");

    expect(extractTableRows(body)).toHaveLength(38);
  });
});

describe("missingScreenshotMatrixPairs (#4535)", () => {
  const FULL_MATRIX_BODY = [
    "| Viewport · Theme | Before | After |",
    "| --- | --- | --- |",
    "| Desktop · Light | ![b](x.png) | ![a](y.png) |",
    "| Desktop · Dark | ![b](x.png) | ![a](y.png) |",
    "| Mobile · Light | ![b](x.png) | ![a](y.png) |",
    "| Mobile · Dark | ![b](x.png) | ![a](y.png) |",
  ].join("\n");

  it("returns [] when pairs is empty, without scanning the body", () => {
    expect(missingScreenshotMatrixPairs("anything", [])).toEqual([]);
  });

  it("returns [] when every required pair has a satisfying labeled row", () => {
    const pairs: ScreenshotMatrixPair[] = [
      { viewport: "Desktop", theme: "Light" },
      { viewport: "Mobile", theme: "Dark" },
    ];
    expect(missingScreenshotMatrixPairs(FULL_MATRIX_BODY, pairs)).toEqual([]);
  });

  it("matches viewport/theme case-insensitively and tolerates any separator between them", () => {
    const body = ["| Row | Before | After |", "| --- | --- | --- |", "| tablet - light | ![b](x.png) | ![a](y.png) |"].join("\n");
    expect(missingScreenshotMatrixPairs(body, [{ viewport: "Tablet", theme: "Light" }])).toEqual([]);
  });

  it("reports a pair missing when no row's label mentions the viewport at all", () => {
    const pairs: ScreenshotMatrixPair[] = [{ viewport: "Tablet", theme: "Light" }];
    expect(missingScreenshotMatrixPairs(FULL_MATRIX_BODY, pairs)).toEqual(pairs);
  });

  it("reports a pair missing when the row matches the viewport but not the theme", () => {
    const body = ["| Row | Before | After |", "| --- | --- | --- |", "| Desktop · Light | ![b](x.png) | ![a](y.png) |"].join("\n");
    expect(missingScreenshotMatrixPairs(body, [{ viewport: "Desktop", theme: "Dark" }])).toEqual([{ viewport: "Desktop", theme: "Dark" }]);
  });

  it("reports a pair missing when the labeled row only has ONE image cell (before, no after)", () => {
    const body = ["| Row | Before | After |", "| --- | --- | --- |", "| Desktop · Light | ![b](x.png) | no image here |"].join("\n");
    expect(missingScreenshotMatrixPairs(body, [{ viewport: "Desktop", theme: "Light" }])).toEqual([{ viewport: "Desktop", theme: "Light" }]);
  });

  it("REGRESSION (PR #4661 shape): desktop-only 2x2 table is missing every tablet/mobile pair", () => {
    const body = [
      "| Theme | Before | After |",
      "| --- | --- | --- |",
      "| Dark | ![before dark](x.png) | ![after dark](y.png) |",
      "| Light | ![before light](x.png) | ![after light](y.png) |",
    ].join("\n");
    const pairs = requiredScreenshotMatrixPairs(config({ requireViewports: ["Desktop", "Tablet", "Mobile"], requireThemes: ["Light", "Dark"] }));
    const missing = missingScreenshotMatrixPairs(body, pairs);
    // Desktop rows never mention "Desktop" in their label (just "Dark"/"Light"), so ALL SIX pairs are
    // missing -- the row-label contract requires naming the viewport, not just the theme.
    expect(missing).toEqual(pairs);
  });

  it("a viewport:null-theme pair (viewport-only mode) is satisfied by any theme label, or none at all", () => {
    const body = ["| Row | Before | After |", "| --- | --- | --- |", "| Desktop | ![b](x.png) | ![a](y.png) |"].join("\n");
    expect(missingScreenshotMatrixPairs(body, [{ viewport: "Desktop", theme: null }])).toEqual([]);
  });

  it("handles a null/undefined body (no rows at all) -- every pair is missing", () => {
    const pairs: ScreenshotMatrixPair[] = [{ viewport: "Desktop", theme: "Light" }];
    expect(missingScreenshotMatrixPairs(null, pairs)).toEqual(pairs);
    expect(missingScreenshotMatrixPairs(undefined, pairs)).toEqual(pairs);
  });
});

describe("buildScreenshotMatrixMessage (#4535)", () => {
  it("names the missing viewport x theme pairs and uses the 'viewport × theme' dimension label", () => {
    const message = buildScreenshotMatrixMessage([
      { viewport: "Tablet", theme: "Light" },
      { viewport: "Mobile", theme: "Dark" },
    ]);
    expect(message).toContain("Tablet · Light");
    expect(message).toContain("Mobile · Dark");
    expect(message).toContain("viewport × theme");
  });

  it("uses the plain 'viewport' dimension label when no missing pair has a theme", () => {
    const message = buildScreenshotMatrixMessage([{ viewport: "Tablet", theme: null }]);
    expect(message).toContain("Tablet");
    expect(message).not.toContain("Tablet · ");
    expect(message).toContain("viewport combination");
    expect(message).not.toContain("viewport × theme");
  });
});

describe("evaluateScreenshotTableGate", () => {
  it("no violation when the gate is disabled, regardless of everything else", () => {
    const result = evaluateScreenshotTableGate({
      config: config({ enabled: false, whenLabels: ["frontend"] }),
      prBody: "no table here",
      prLabels: ["frontend"],
      changedFiles: ["apps/ui/src/App.tsx"],
    });
    expect(result).toEqual({ violated: false, reason: null });
  });

  it("no violation when enabled but the PR is out of scope", () => {
    const result = evaluateScreenshotTableGate({
      config: config({ enabled: true, whenLabels: ["frontend"] }),
      prBody: "no table here",
      prLabels: ["backend"],
      changedFiles: [],
    });
    expect(result).toEqual({ violated: false, reason: null });
  });

  it("no violation when in scope AND a valid table is present (no stray images, no committed image)", () => {
    const result = evaluateScreenshotTableGate({
      config: config({ enabled: true }),
      prBody: TABLE_BODY,
      prLabels: [],
      changedFiles: ["apps/ui/src/App.tsx"],
    });
    expect(result).toEqual({ violated: false, reason: null });
  });

  it("violates when in scope and there is no table at all", () => {
    const result = evaluateScreenshotTableGate({
      config: config({ enabled: true }),
      prBody: "Just changed some CSS, trust me.",
      prLabels: [],
      changedFiles: [],
    });
    expect(result.violated).toBe(true);
    expect(result.reason).toBe(DEFAULT_SCREENSHOT_CONTRACT_MESSAGE);
  });

  it("violates when a valid table exists but an image is ALSO pasted outside it", () => {
    const bodyWithStray = `${TABLE_BODY}\n\nAlso here's a bonus shot: ![bonus](https://x/bonus.png)`;
    const result = evaluateScreenshotTableGate({ config: config({ enabled: true }), prBody: bodyWithStray, prLabels: [], changedFiles: [] });
    expect(result.violated).toBe(true);
  });

  it("violates when a valid table exists but a screenshot was committed to the repo under a scoped path", () => {
    const result = evaluateScreenshotTableGate({
      config: config({ enabled: true, whenPaths: ["apps/ui/**"] }),
      prBody: TABLE_BODY,
      prLabels: [],
      changedFiles: ["apps/ui/src/App.tsx", "apps/ui/public/screenshot.png"],
    });
    expect(result.violated).toBe(true);
  });

  it("uses the repo-configured message override instead of the default", () => {
    const result = evaluateScreenshotTableGate({
      config: config({ enabled: true, message: "Please add screenshots, thanks!" }),
      prBody: "no table",
      prLabels: [],
      changedFiles: [],
    });
    expect(result.reason).toBe("Please add screenshots, thanks!");
  });

  describe("skillFileUrl (#4540 follow-up)", () => {
    it("appends the skill-file link to the auto-generated presence-mode message", () => {
      const result = evaluateScreenshotTableGate({
        config: config({ enabled: true, skillFileUrl: "https://github.com/acme/widget/blob/main/SKILL.md" }),
        prBody: "no table",
        prLabels: [],
        changedFiles: [],
      });
      expect(result.reason).toContain(DEFAULT_SCREENSHOT_CONTRACT_MESSAGE);
      expect(result.reason).toContain("https://github.com/acme/widget/blob/main/SKILL.md");
    });

    it("does not append anything when skillFileUrl is unset (byte-identical to the plain default)", () => {
      const result = evaluateScreenshotTableGate({ config: config({ enabled: true }), prBody: "no table", prLabels: [], changedFiles: [] });
      expect(result.reason).toBe(DEFAULT_SCREENSHOT_CONTRACT_MESSAGE);
    });

    it("a custom message override wins entirely -- skillFileUrl is ignored, never appended", () => {
      const result = evaluateScreenshotTableGate({
        config: config({ enabled: true, message: "Custom text", skillFileUrl: "https://github.com/acme/widget/blob/main/SKILL.md" }),
        prBody: "no table",
        prLabels: [],
        changedFiles: [],
      });
      expect(result.reason).toBe("Custom text");
    });
  });

  it("handles a null/undefined PR body without throwing (treated as no table)", () => {
    expect(evaluateScreenshotTableGate({ config: config({ enabled: true }), prBody: null, prLabels: [], changedFiles: [] }).violated).toBe(true);
    expect(evaluateScreenshotTableGate({ config: config({ enabled: true }), prBody: undefined, prLabels: [], changedFiles: [] }).violated).toBe(true);
  });

  describe("botCaptureSatisfied (#4110)", () => {
    it("no violation when the bot's own capture already succeeded, even with no body table at all", () => {
      const result = evaluateScreenshotTableGate({
        config: config({ enabled: true }),
        prBody: "Just changed some CSS, trust me.",
        prLabels: [],
        changedFiles: [],
        botCaptureSatisfied: true,
      });
      expect(result).toEqual({ violated: false, reason: null });
    });

    it("satisfies the gate even when the body would otherwise fail the anti-gaming checks (image outside table + committed image)", () => {
      const gamedBody = `${TABLE_BODY}\n\nAlso here's a bonus shot: ![bonus](https://x/bonus.png)`;
      const result = evaluateScreenshotTableGate({
        config: config({ enabled: true, whenPaths: ["apps/ui/**"] }),
        prBody: gamedBody,
        prLabels: [],
        changedFiles: ["apps/ui/public/screenshot.png"],
        botCaptureSatisfied: true,
      });
      expect(result).toEqual({ violated: false, reason: null });
    });

    it("still violates when botCaptureSatisfied is explicitly false and there is no table", () => {
      const result = evaluateScreenshotTableGate({
        config: config({ enabled: true }),
        prBody: "no table here",
        prLabels: [],
        changedFiles: [],
        botCaptureSatisfied: false,
      });
      expect(result.violated).toBe(true);
    });

    it("does not put an out-of-scope PR into scope just because the bot captured something", () => {
      const result = evaluateScreenshotTableGate({
        config: config({ enabled: true, whenLabels: ["frontend"] }),
        prBody: "no table here",
        prLabels: ["backend"],
        changedFiles: [],
        botCaptureSatisfied: true,
      });
      expect(result).toEqual({ violated: false, reason: null });
    });
  });

  describe("matrix mode (#4535, requireViewports/requireThemes)", () => {
    const FULL_MATRIX_BODY = [
      "| Viewport · Theme | Before | After |",
      "| --- | --- | --- |",
      "| Desktop · Light | ![b](x.png) | ![a](y.png) |",
      "| Desktop · Dark | ![b](x.png) | ![a](y.png) |",
      "| Tablet · Light | ![b](x.png) | ![a](y.png) |",
      "| Tablet · Dark | ![b](x.png) | ![a](y.png) |",
      "| Mobile · Light | ![b](x.png) | ![a](y.png) |",
      "| Mobile · Dark | ![b](x.png) | ![a](y.png) |",
    ].join("\n");

    function matrixConfig(overrides: Partial<ScreenshotTableGateConfig> = {}) {
      return config({ enabled: true, requireViewports: ["Desktop", "Tablet", "Mobile"], requireThemes: ["Light", "Dark"], ...overrides });
    }

    it("no violation when every required viewport x theme pair has a labeled before/after row", () => {
      const result = evaluateScreenshotTableGate({ config: matrixConfig(), prBody: FULL_MATRIX_BODY, prLabels: [], changedFiles: [] });
      expect(result).toEqual({ violated: false, reason: null });
    });

    it("REGRESSION (#8866): a complete matrix that passed for head A is stale on head B when the body never changed", () => {
      const passOnPush1 = evaluateScreenshotTableGate({
        config: matrixConfig(),
        prBody: FULL_MATRIX_BODY,
        prLabels: [],
        changedFiles: [],
        headSha: "matrix-push-1",
      });
      expect(passOnPush1).toEqual({
        violated: false,
        reason: null,
        presenceModeSatisfiedState: {
          headSha: "matrix-push-1",
          evidenceFingerprint: expect.any(String),
        },
      });
      const staleOnPush2 = evaluateScreenshotTableGate({
        config: matrixConfig(),
        prBody: FULL_MATRIX_BODY,
        prLabels: [],
        changedFiles: [],
        headSha: "matrix-push-2",
        presenceModeSatisfied: passOnPush1.presenceModeSatisfiedState,
      });
      expect(staleOnPush2.violated).toBe(true);
      expect(staleOnPush2.presenceModeSatisfiedState).toBeUndefined();
    });

    it("matrix mode is not stale when the contributor re-affirms with different image URLs on the new head (#8866)", () => {
      const push1Body = FULL_MATRIX_BODY;
      const push1 = evaluateScreenshotTableGate({
        config: matrixConfig(),
        prBody: push1Body,
        prLabels: [],
        changedFiles: [],
        headSha: "matrix-push-1",
      });
      const reaffirmedBody = FULL_MATRIX_BODY.replaceAll("x.png", "x-v2.png").replaceAll("y.png", "y-v2.png");
      const push2 = evaluateScreenshotTableGate({
        config: matrixConfig(),
        prBody: reaffirmedBody,
        prLabels: [],
        changedFiles: [],
        headSha: "matrix-push-2",
        presenceModeSatisfied: push1.presenceModeSatisfiedState,
      });
      expect(push2.violated).toBe(false);
      expect(push2.presenceModeSatisfiedState?.headSha).toBe("matrix-push-2");
    });

    it("matrix mode without a headSha stays byte-identical to pre-#8866 (no checkpoint, no staleness)", () => {
      const result = evaluateScreenshotTableGate({
        config: matrixConfig(),
        prBody: FULL_MATRIX_BODY,
        prLabels: [],
        changedFiles: [],
        presenceModeSatisfied: { headSha: "old", evidenceFingerprint: "anything" },
      });
      expect(result).toEqual({ violated: false, reason: null });
    });

    it("REGRESSION (metagraphed PR #4661 shape): desktop-only before/after (4/12 images) still violates matrix mode", () => {
      const desktopOnlyBody = [
        "| Theme | Before | After |",
        "| --- | --- | --- |",
        "| Dark | ![before dark](x.png) | ![after dark](y.png) |",
        "| Light | ![before light](x.png) | ![after light](y.png) |",
      ].join("\n");
      const result = evaluateScreenshotTableGate({ config: matrixConfig(), prBody: desktopOnlyBody, prLabels: [], changedFiles: [] });
      expect(result.violated).toBe(true);
      expect(result.reason).toContain("Desktop · Light");
      expect(result.reason).toContain("Tablet · Light");
      expect(result.reason).toContain("Mobile · Dark");
    });

    it("violates and names only the still-missing pairs when some (not all) rows are present", () => {
      const partialBody = [
        "| Viewport · Theme | Before | After |",
        "| --- | --- | --- |",
        "| Desktop · Light | ![b](x.png) | ![a](y.png) |",
        "| Desktop · Dark | ![b](x.png) | ![a](y.png) |",
      ].join("\n");
      const result = evaluateScreenshotTableGate({ config: matrixConfig(), prBody: partialBody, prLabels: [], changedFiles: [] });
      expect(result.violated).toBe(true);
      const missingList = (result.reason ?? "").split("Still missing: ")[1] ?? "";
      expect(missingList).not.toContain("Desktop · Light");
      expect(missingList).toContain("Tablet · Light");
      expect(missingList).toContain("Mobile · Dark");
    });

    it("viewport-only matrix mode (requireThemes empty) is satisfied by one before/after row per viewport", () => {
      const body = [
        "| Viewport | Before | After |",
        "| --- | --- | --- |",
        "| Desktop | ![b](x.png) | ![a](y.png) |",
        "| Mobile | ![b](x.png) | ![a](y.png) |",
      ].join("\n");
      const result = evaluateScreenshotTableGate({ config: matrixConfig({ requireViewports: ["Desktop", "Mobile"], requireThemes: [] }), prBody: body, prLabels: [], changedFiles: [] });
      expect(result).toEqual({ violated: false, reason: null });
    });

    it("a configured message override still wins over the auto-generated matrix message", () => {
      const result = evaluateScreenshotTableGate({ config: matrixConfig({ message: "Custom matrix rejection text" }), prBody: "no table", prLabels: [], changedFiles: [] });
      expect(result.reason).toBe("Custom matrix rejection text");
    });

    it("appends the skill-file link to the auto-generated matrix message, keeping the specific missing-pairs list (#4540 follow-up)", () => {
      const result = evaluateScreenshotTableGate({
        config: matrixConfig({ skillFileUrl: "https://github.com/JSONbored/metagraphed/blob/main/.claude/skills/metagraphed/SKILL.md" }),
        prBody: "no table",
        prLabels: [],
        changedFiles: [],
      });
      expect(result.reason).toContain("Still missing:");
      expect(result.reason).toContain("Desktop · Light");
      expect(result.reason).toContain("https://github.com/JSONbored/metagraphed/blob/main/.claude/skills/metagraphed/SKILL.md");
    });

    it("a message override in matrix mode also ignores skillFileUrl entirely", () => {
      const result = evaluateScreenshotTableGate({
        config: matrixConfig({ message: "Custom matrix rejection text", skillFileUrl: "https://github.com/JSONbored/metagraphed/blob/main/.claude/skills/metagraphed/SKILL.md" }),
        prBody: "no table",
        prLabels: [],
        changedFiles: [],
      });
      expect(result.reason).toBe("Custom matrix rejection text");
    });

    it("botCaptureSatisfied short-circuits matrix mode too, even with zero rows", () => {
      const result = evaluateScreenshotTableGate({ config: matrixConfig(), prBody: "no table at all", prLabels: [], changedFiles: [], botCaptureSatisfied: true });
      expect(result).toEqual({ violated: false, reason: null });
    });

    it("an out-of-scope PR is never violated by matrix mode either", () => {
      const result = evaluateScreenshotTableGate({
        config: matrixConfig({ whenLabels: ["frontend"] }),
        prBody: "no table",
        prLabels: ["backend"],
        changedFiles: [],
      });
      expect(result).toEqual({ violated: false, reason: null });
    });

    it("falls through to presence-only mode (unchanged #2006 behavior) when requireViewports is empty", () => {
      const result = evaluateScreenshotTableGate({ config: config({ enabled: true, requireViewports: [] }), prBody: TABLE_BODY, prLabels: [], changedFiles: [] });
      expect(result).toEqual({ violated: false, reason: null });
    });
  });
});

describe("extractTableRowImageUrls (#4366)", () => {
  it("extracts the before/after URL pair from a markdown-image table row", () => {
    expect(extractTableRowImageUrls(TABLE_BODY)).toEqual([["https://x/before.png", "https://x/after.png"]]);
  });

  it("extracts the URL from an <img src> tag, mixed with markdown syntax in the same row", () => {
    const body = ['| Before | After |', '| --- | --- |', '| <img src="https://x/before.png"> | ![after](https://x/after.png) |'].join("\n");
    expect(extractTableRowImageUrls(body)).toEqual([["https://x/before.png", "https://x/after.png"]]);
  });

  it("extracts the INNER image URL from a clickable-thumbnail cell ([![alt](img-url)](link-url)), not the outer link", () => {
    const body = ['| Before | After |', '| --- | --- |', '| [![before](https://x/before.png)](https://x/before.png) | [![after](https://x/after.png)](https://x/after.png) |'].join("\n");
    expect(extractTableRowImageUrls(body)).toEqual([["https://x/before.png", "https://x/after.png"]]);
  });

  it("strips a trailing markdown title from an image URL (![alt](url \"title\"))", () => {
    const body = ['| Before | After |', '| --- | --- |', '| ![before](https://x/before.png "Before") | ![after](https://x/after.png "After") |'].join("\n");
    expect(extractTableRowImageUrls(body)).toEqual([["https://x/before.png", "https://x/after.png"]]);
  });

  it("drops a row with only ONE image cell (not a real before/after pair)", () => {
    const body = ['| Before | After |', '| --- | --- |', '| ![before](https://x/before.png) | no image here |'].join("\n");
    expect(extractTableRowImageUrls(body)).toEqual([]);
  });

  it("keeps every image URL on a row with more than two (e.g. a desktop+mobile matrix row)", () => {
    const body = [
      '| Viewport | Before | After |',
      '| --- | --- | --- |',
      '| Desktop | ![before](https://x/d-before.png) | ![after](https://x/d-after.png) |',
    ].join("\n");
    expect(extractTableRowImageUrls(body)).toEqual([["https://x/d-before.png", "https://x/d-after.png"]]);
  });

  it("returns [] for a table with no image markup at all, and for an empty/missing body", () => {
    const body = ["| Before | After |", "| --- | --- |", "| nothing | here |"].join("\n");
    expect(extractTableRowImageUrls(body)).toEqual([]);
    expect(extractTableRowImageUrls("")).toEqual([]);
    expect(extractTableRowImageUrls(null)).toEqual([]);
    expect(extractTableRowImageUrls(undefined)).toEqual([]);
  });

  it("extracts a pair from EACH qualifying row when the table has multiple rows", () => {
    const body = [
      "| Before | After |",
      "| --- | --- |",
      "| ![before](https://x/1-before.png) | ![after](https://x/1-after.png) |",
      "| ![before](https://x/2-before.png) | ![after](https://x/2-after.png) |",
    ].join("\n");
    expect(extractTableRowImageUrls(body)).toEqual([
      ["https://x/1-before.png", "https://x/1-after.png"],
      ["https://x/2-before.png", "https://x/2-after.png"],
    ]);
  });
});

// #9434: the same exclusion behaviour asserted in screenshot-table-gate-engine.test.ts, but reached through
// the `src/review/screenshot-table-gate` re-export shim rather than the engine source path.
//
// Not redundant: the two import paths are DISTINCT coverage identities (the shim is its own real file), and
// CI sharding means a given shard may run only one of the two suites. Exercising the exclusion from both
// sides keeps these lines attributed under either identity in whichever shard picks them up — the
// misattribution class vitest.config.ts's own coverage-include comment documents from the 2026-07-24
// codecov/patch incident.
describe("whenPaths exclusions via the src re-export (#9434)", () => {
  const scoped = ["apps/ui/public/**", "!apps/ui/public/openapi.json"];

  it("carves a generated file out of an otherwise-in-scope directory", () => {
    expect(isScreenshotTableGateInScope(config({ whenPaths: scoped }), [], ["apps/ui/public/openapi.json"])).toBe(false);
    expect(isScreenshotTableGateInScope(config({ whenPaths: scoped }), [], ["apps/ui/public/hero.png"])).toBe(true);
  });

  it("applies the SAME exclusion to the committed-image check, so the two cannot disagree on what is scoped", () => {
    // A path excluded from gate scope must not still count as a stray committed image — that disagreement is
    // exactly what sharing one matcher prevents.
    expect(hasCommittedImageFile(["apps/ui/public/openapi.json"], scoped)).toBe(false);
    expect(hasCommittedImageFile(["apps/ui/public/hero.png"], scoped)).toBe(true);
  });

  it("INVARIANT: a plain whenPaths list with no exclusions behaves exactly as before", () => {
    expect(isScreenshotTableGateInScope(config({ whenPaths: ["apps/ui/**"] }), [], ["apps/ui/src/App.tsx"])).toBe(true);
    expect(hasCommittedImageFile(["apps/ui/src/logo.png"], ["apps/ui/**"])).toBe(true);
    expect(hasCommittedImageFile(["docs/logo.png"], ["apps/ui/**"])).toBe(false);
  });
});

// Mirrored from the engine suite so BOTH import identities own these branches: CI shards the coverage run and
// merges by flag, so a branch proven only through one identity can read as uncovered on the other.
describe("extractTableRows rejects non-table line pairs", () => {
  it("INVARIANT: a line pair that is not header+separator is skipped, so prose and pipe-bearing text are never rows", () => {
    expect(extractTableRows("just prose\nmore prose")).toEqual([]); // neither line is pipe-delimited
    expect(extractTableRows("| a | b |\nnot a separator\n| 1 | 2 |")).toEqual([]); // header, but no separator under it
    expect(extractTableRows("intro text\n| --- | --- |\n| 1 | 2 |")).toEqual([]); // separator with no header above it
    expect(extractTableRows("run `cat x | grep y` to check\nand then rerun it")).toEqual([]); // a pipe inside prose
    expect(extractTableRows("some intro prose\n\n| before | after |\n| --- | --- |\n| a.png | b.png |")).toEqual([
      ["a.png", "b.png"],
    ]);
  });
});

// Presence mode is the DEFAULT gate shape (any image-bearing table passes), and its staleness correlation ran
// through a separate return site from matrix mode's — one that had no headSha test at all. Untested, a stale
// -evidence miss means one table pasted on push #1 holds the gate green for every later push.
describe("evaluateScreenshotTableGate presence-mode staleness (#stale-screenshot-table-fix)", () => {
  const satisfying = { config: config({ enabled: true }), prBody: TABLE_BODY, prLabels: [] as string[], changedFiles: ["apps/ui/src/App.tsx"] };

  it("issues a head-keyed checkpoint on the first satisfying push", () => {
    const push1 = evaluateScreenshotTableGate({ ...satisfying, headSha: "presence-push-1" });
    expect(push1.violated).toBe(false);
    expect(push1.presenceModeSatisfiedState?.headSha).toBe("presence-push-1");
    expect(push1.presenceModeSatisfiedState?.evidenceFingerprint).toEqual(expect.any(String));
  });

  it("REGRESSION: the SAME table on a new head is stale — it must not keep passing the gate across pushes", () => {
    const push1 = evaluateScreenshotTableGate({ ...satisfying, headSha: "presence-push-1" });
    const stale = evaluateScreenshotTableGate({
      ...satisfying, // byte-identical body: no re-affirmation
      headSha: "presence-push-2",
      presenceModeSatisfied: push1.presenceModeSatisfiedState,
    });
    expect(stale.violated).toBe(true);
    expect(stale.reason).toContain(DEFAULT_SCREENSHOT_CONTRACT_MESSAGE);
    // No checkpoint on a stale result — re-issuing one would let push #3 compare against push #2 and read as
    // fresh, laundering the staleness away after a single extra push.
    expect(stale.presenceModeSatisfiedState).toBeUndefined();
  });

  it("a re-affirmed table (fresh image URLs) on the new head is NOT stale, and re-checkpoints to that head", () => {
    const push1 = evaluateScreenshotTableGate({ ...satisfying, headSha: "presence-push-1" });
    const push2 = evaluateScreenshotTableGate({
      ...satisfying,
      prBody: TABLE_BODY.replaceAll(".png", "-v2.png"), // a fresh upload gets a fresh URL
      headSha: "presence-push-2",
      presenceModeSatisfied: push1.presenceModeSatisfiedState,
    });
    expect(push2.violated).toBe(false);
    expect(push2.presenceModeSatisfiedState?.headSha).toBe("presence-push-2");
  });

  it("a custom config.message wins over the default contract text on the stale path too", () => {
    const push1 = evaluateScreenshotTableGate({ ...satisfying, headSha: "presence-push-1" });
    const stale = evaluateScreenshotTableGate({
      ...satisfying,
      config: config({ enabled: true, message: "custom contract text" }),
      headSha: "presence-push-2",
      presenceModeSatisfied: push1.presenceModeSatisfiedState,
    });
    expect(stale).toEqual({ violated: true, reason: "custom contract text" });
  });

  it("INVARIANT: no headSha ⇒ byte-identical to pre-fix behavior — no checkpoint issued, no staleness possible", () => {
    const result = evaluateScreenshotTableGate({ ...satisfying, presenceModeSatisfied: { headSha: "old", evidenceFingerprint: "anything" } });
    expect(result).toEqual({ violated: false, reason: null });
  });

  it("INVARIANT: the SAME head re-evaluated is never stale — a webhook replay must not flip a passing gate", () => {
    const push1 = evaluateScreenshotTableGate({ ...satisfying, headSha: "presence-push-1" });
    const replay = evaluateScreenshotTableGate({
      ...satisfying,
      headSha: "presence-push-1",
      presenceModeSatisfied: push1.presenceModeSatisfiedState,
    });
    expect(replay.violated).toBe(false);
    expect(replay.presenceModeSatisfiedState?.headSha).toBe("presence-push-1");
  });
});

// #9881: a CLOSE must never rest on evidence the pipeline is structurally unable to produce.
describe("enforcement degrade when capture is unobtainable (#9881)", () => {
  const violatingInput = {
    config: config({ enabled: true, action: "close" as const, whenPaths: ["apps/web/src/**"] }),
    prBody: "no screenshots here",
    prLabels: [],
    changedFiles: ["apps/web/src/routes/home.tsx"],
    headSha: "abc123",
  };

  it("still reports the violation — the PR genuinely lacks visual evidence", () => {
    const result = evaluateScreenshotTableGate({ ...violatingInput, captureUnobtainable: true });
    expect(result.violated, "the finding is not suppressed; only enforcement is").toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it("marks enforcement degraded, and says why in words a contributor can act on", () => {
    const result = evaluateScreenshotTableGate({ ...violatingInput, captureUnobtainable: true });
    expect(result.enforcementDegradedReason).toBe(CAPTURE_UNOBTAINABLE_REASON);
    // The message must name the maintainer-side remedy, since no contributor action can fix this.
    expect(result.enforcementDegradedReason).toMatch(/preview deployment/i);
    expect(result.enforcementDegradedReason).toMatch(/advisory/i);
  });

  it("does NOT degrade when capture is merely absent — that close is legitimate", () => {
    const result = evaluateScreenshotTableGate({ ...violatingInput, captureUnobtainable: false });
    expect(result.violated).toBe(true);
    expect(result.enforcementDegradedReason).toBeUndefined();
  });

  it("omits the degrade entirely when there is no violation to enforce", () => {
    const satisfied = evaluateScreenshotTableGate({ ...violatingInput, botCaptureSatisfied: true, captureUnobtainable: true });
    expect(satisfied.violated).toBe(false);
    expect(satisfied.enforcementDegradedReason).toBeUndefined();
  });

  it("is byte-identical to before when the flag is not passed at all", () => {
    const before = evaluateScreenshotTableGate(violatingInput);
    expect(before.enforcementDegradedReason).toBeUndefined();
    expect(before).toEqual(evaluateScreenshotTableGate({ ...violatingInput, captureUnobtainable: undefined }));
  });
});
