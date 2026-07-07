import { describe, expect, it } from "vitest";
import { githubPrFileDiffAnchor, githubPrFileDiffUrl } from "../../src/review/changed-files-diff-link";

describe("githubPrFileDiffAnchor (#2157)", () => {
  it("returns the SHA-256 hex of the bare repo-relative path", () => {
    expect(githubPrFileDiffAnchor("src/app.ts")).toBe(
      "841254fe75488c1bd4cd7f68f00b4be0e48dcfbc4a16b45847b68295e0e3b27b",
    );
  });

  it("returns null for empty or whitespace-only paths", () => {
    expect(githubPrFileDiffAnchor("")).toBeNull();
    expect(githubPrFileDiffAnchor("   ")).toBeNull();
    expect(githubPrFileDiffAnchor("\0bad")).toBeNull();
  });
});

describe("githubPrFileDiffUrl (#2157)", () => {
  it("builds a public-safe Files-tab URL with the diff anchor", () => {
    expect(githubPrFileDiffUrl("acme/widgets", 42, "src/app.ts")).toBe(
      "https://github.com/acme/widgets/pull/42/files#diff-841254fe75488c1bd4cd7f68f00b4be0e48dcfbc4a16b45847b68295e0e3b27b",
    );
  });

  it("returns null for invalid repo, PR number, or path", () => {
    expect(githubPrFileDiffUrl("not-a-repo", 1, "src/a.ts")).toBeNull();
    expect(githubPrFileDiffUrl("acme/widgets", 0, "src/a.ts")).toBeNull();
    expect(githubPrFileDiffUrl("acme/widgets", 1.5, "src/a.ts")).toBeNull();
    expect(githubPrFileDiffUrl("acme/widgets", 1, "")).toBeNull();
  });
});
