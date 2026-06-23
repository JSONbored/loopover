import { describe, expect, it } from "vitest";
import { DEFAULT_TYPE_LABELS, deriveKindFromTitle, resolvePrTypeLabel } from "../../src/settings/pr-type-label";

describe("deriveKindFromTitle", () => {
  it("maps feat/feature → feature; everything else → bug", () => {
    expect(deriveKindFromTitle("feat: add X")).toBe("feature");
    expect(deriveKindFromTitle("feature(api): boards")).toBe("feature");
    expect(deriveKindFromTitle("fix: bug")).toBe("bug");
    expect(deriveKindFromTitle("test: add coverage")).toBe("bug");
    expect(deriveKindFromTitle("docs: readme")).toBe("bug");
    expect(deriveKindFromTitle("chore: deps")).toBe("bug");
    expect(deriveKindFromTitle("refactor: cleanup")).toBe("bug");
    expect(deriveKindFromTitle(undefined)).toBe("bug");
    expect(deriveKindFromTitle("")).toBe("bug");
  });
});

describe("resolvePrTypeLabel", () => {
  it("returns the feature/bug label by title when no content globs match", () => {
    expect(resolvePrTypeLabel({ title: "feat: x", changedPaths: ["src/a.ts"], contentGlobs: [] })).toBe(DEFAULT_TYPE_LABELS.feature);
    expect(resolvePrTypeLabel({ title: "fix: y", changedPaths: ["src/a.ts"], contentGlobs: [] })).toBe(DEFAULT_TYPE_LABELS.bug);
  });

  it("returns priority when a changed path matches a content glob (content submission)", () => {
    expect(resolvePrTypeLabel({ title: "feat: add entry", changedPaths: ["content/posts/x.md"], contentGlobs: ["content/**"] })).toBe(DEFAULT_TYPE_LABELS.priority);
    // a non-content feat with content globs configured but no match → feature
    expect(resolvePrTypeLabel({ title: "feat: code", changedPaths: ["src/a.ts"], contentGlobs: ["content/**"] })).toBe(DEFAULT_TYPE_LABELS.feature);
  });
});
