import { describe, expect, it } from "vitest";
import { addedLineCount, buildUnifiedReviewDiff, diffFilePriority, keepHighSignalHunks } from "../../src/review/review-diff";

describe("diffFilePriority — source survives, noise drops first", () => {
  it("ranks source(0) < tests(1) < docs(2) < lockfiles/generated(4)", () => {
    expect(diffFilePriority("src/a.ts")).toBe(0);
    expect(diffFilePriority("src/a.test.ts")).toBe(1);
    expect(diffFilePriority("README.md")).toBe(2);
    expect(diffFilePriority("package-lock.json")).toBe(4);
    expect(diffFilePriority("dist/bundle.js")).toBe(4);
    expect(diffFilePriority("app.min.css")).toBe(4);
  });

  it("ranks long-form doc spellings as docs(2), matching rag.ts and path-matchers", () => {
    for (const path of ["GUIDE.markdown", "docs/spec.asciidoc", "notes.ADOC"]) {
      expect(diffFilePriority(path)).toBe(2);
      expect(diffFilePriority(path)).toBeGreaterThan(diffFilePriority("src/a.ts"));
    }
  });

  it("ranks every path-matchers lockfile as noise(4), not source(0)", () => {
    for (const path of ["bun.lock", "uv.lock", "deno.lock", "flake.lock", "mix.lock", "chart.lock"]) {
      expect(diffFilePriority(path)).toBe(4);
      expect(diffFilePriority(path)).toBeGreaterThan(diffFilePriority("src/a.ts"));
    }
  });

  it("ranks every canonical test convention as tests(1), not source(0)", () => {
    // These are all tests; before delegating to isTestPath the inline regex missed them and ranked
    // them SOURCE(0), so on a tight budget they could displace real source (the opposite of the goal).
    for (const path of [
      "e2e/checkout.cy.ts", // Cypress
      "e2e/flow.e2e.mjs", // Playwright/e2e, module extension
      "pkg/server/handler_test.go", // Go suffix
      "app/services/cleanup_test.py", // pytest suffix
      "tests/test_utils.py", // pytest prefix (would be a test dir too, but bare test_*.py must also count)
      "models/user_spec.rb", // RSpec suffix
      "spec/models/account.rb", // bare spec/ directory
      "src/test/fixtures.ts", // src/test convention
      "components/__snapshots__/Card.tsx", // snapshot dir (non-.snap file)
    ]) {
      expect(diffFilePriority(path)).toBe(1);
    }
  });

  it("still treats plain production sources as source(0)", () => {
    expect(diffFilePriority("src/review/review-diff.ts")).toBe(0);
    expect(diffFilePriority("packages/api/handler.py")).toBe(0);
  });
});

describe("addedLineCount — counts +lines, ignores +++ header", () => {
  it("counts only substantive added lines", () => {
    expect(addedLineCount("@@\n+a\n+b\n-c\n d")).toBe(2);
    expect(addedLineCount("+++ b/file.ts\n+real")).toBe(1);
    expect(addedLineCount(undefined)).toBe(0);
  });
});

describe("buildUnifiedReviewDiff — the #1528 fix: never silently drop the file defining a symbol", () => {
  it("orders SOURCE before a lockfile, so under a tight budget source survives and the lockfile drops", () => {
    const bigLock = `@@\n${"+x\n".repeat(400)}`; // large, low-priority
    const source = "@@\n+export function loadArtifactData() { return 1; }";
    const diff = buildUnifiedReviewDiff(
      [
        { path: "package-lock.json", patch: bigLock, status: "modified", additions: 400, deletions: 0 },
        { path: "src/mcp-server.mjs", patch: source, status: "modified", additions: 1, deletions: 0 },
      ],
      300, // tight budget — only one file fits
    );
    expect(diff).toContain("src/mcp-server.mjs"); // source kept
    expect(diff).toContain("loadArtifactData"); // the symbol-defining hunk survives
    expect(diff).toContain("…diff truncated"); // the lockfile was dropped, and that is announced
  });

  it("lists a patch-less (binary/too-large) file with its counts instead of making it invisible", () => {
    const diff = buildUnifiedReviewDiff([{ path: "logo.png", patch: undefined, status: "added", additions: 0, deletions: 0 }]);
    expect(diff).toContain("logo.png (added)");
    expect(diff).toContain("no inline patch");
  });

  it("reduces an oversized single file hunk-aware (keeps the highest-signal hunk) rather than head-slicing", () => {
    const lowSignal = `@@ -1,2 +1,2 @@\n context\n context`;
    const highSignal = `@@ -10,1 +10,5 @@\n+critical1\n+critical2\n+critical3\n+critical4`;
    const reduced = keepHighSignalHunks(`${lowSignal}\n${highSignal}`, 70); // room for the high-signal hunk only
    expect(reduced).toContain("critical1"); // the high-signal hunk is kept
    expect(reduced).not.toContain("context"); // the low-signal hunk is dropped
    expect(reduced).toContain("dropped"); // and the drop is announced
  });

  it("keeps every hunk when they fit exactly (the join uses N-1 separators, not N)", () => {
    // Two 10-char hunks joined with one "\n" = 21 chars, exactly the budget. Charging a separator for
    // BOTH hunks over-counts by one and wrongly drops the second even though it fits.
    const patch = "@@ a\n+x\n+y\n@@ b\n+p\n+q";
    expect(patch.length).toBe(21);
    expect(keepHighSignalHunks(patch, 21)).toBe(patch); // no hunk dropped
    // One char short → the second hunk genuinely does not fit and is announced as dropped.
    expect(keepHighSignalHunks(patch, 20)).toContain("dropped");
  });
});
