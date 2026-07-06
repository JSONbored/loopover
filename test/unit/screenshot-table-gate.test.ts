import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREENSHOT_CONTRACT_MESSAGE,
  DEFAULT_SCREENSHOT_TABLE_GATE,
  evaluateScreenshotTableGate,
  hasCommittedImageFile,
  hasImageBearingMarkdownTable,
  hasImageOutsideTable,
  isScreenshotTableGateAction,
  isScreenshotTableGateInScope,
  normalizeScreenshotTableGateConfig,
} from "../../src/review/screenshot-table-gate";
import type { ScreenshotTableGateConfig } from "../../src/types";

function config(overrides: Partial<ScreenshotTableGateConfig> = {}): ScreenshotTableGateConfig {
  return { ...DEFAULT_SCREENSHOT_TABLE_GATE, whenLabels: [], whenPaths: [], ...overrides };
}

const TABLE_BODY = ["| Before | After |", "| --- | --- |", "| ![before](https://x/before.png) | ![after](https://x/after.png) |"].join("\n");

describe("isScreenshotTableGateAction", () => {
  it("accepts every valid action", () => {
    expect(isScreenshotTableGateAction("close")).toBe(true);
    expect(isScreenshotTableGateAction("request_changes")).toBe(true);
    expect(isScreenshotTableGateAction("comment")).toBe(true);
  });

  it("rejects a non-string or unknown value", () => {
    expect(isScreenshotTableGateAction("hold")).toBe(false);
    expect(isScreenshotTableGateAction(123)).toBe(false);
    expect(isScreenshotTableGateAction(undefined)).toBe(false);
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
      { enabled: true, whenLabels: ["frontend", "visual"], whenPaths: ["apps/ui/**"], action: "comment", message: "custom text" },
      [],
    );
    expect(result).toEqual({ enabled: true, whenLabels: ["frontend", "visual"], whenPaths: ["apps/ui/**"], action: "comment", message: "custom text" });
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

  it("handles a null/undefined PR body without throwing (treated as no table)", () => {
    expect(evaluateScreenshotTableGate({ config: config({ enabled: true }), prBody: null, prLabels: [], changedFiles: [] }).violated).toBe(true);
    expect(evaluateScreenshotTableGate({ config: config({ enabled: true }), prBody: undefined, prLabels: [], changedFiles: [] }).violated).toBe(true);
  });
});
