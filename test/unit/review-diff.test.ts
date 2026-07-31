import { describe, expect, it } from "vitest";
import { addedLineCount, buildUnifiedReviewDiff, diffFilePriority, extractAddedLines, keepHighSignalHunks, totalAddedLineCount } from "../../src/review/review-diff";

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

  it("ranks the extended vendored-directory set as noise(4), matching the engine copy (#8648)", () => {
    for (const path of [
      "vendored/lib.js",
      "third_party/x.js",
      "third-party/x.js",
      "bower_components/x.js",
      "jspm_packages/x.js",
    ]) {
      expect(diffFilePriority(path)).toBe(4);
      expect(diffFilePriority(path)).toBeGreaterThan(diffFilePriority("src/a.ts"));
    }
  });
});

describe("addedLineCount — counts +lines, ignores +++ header", () => {
  it("counts only substantive added lines", () => {
    expect(addedLineCount("@@\n+a\n+b\n-c\n d")).toBe(2);
    expect(addedLineCount("+++ b/file.ts\n+real")).toBe(1);
    expect(addedLineCount(undefined)).toBe(0);
  });
});

describe("extractAddedLines — the content-level counterpart to addedLineCount (#1969)", () => {
  it("returns the text of only the substantive added lines, leading + stripped, ignoring the +++ header", () => {
    expect(extractAddedLines("@@\n+a\n+b\n-c\n d")).toEqual(["a", "b"]);
    expect(extractAddedLines("+++ b/file.ts\n+real")).toEqual(["real"]);
  });

  it("returns an empty array for a missing/absent patch", () => {
    expect(extractAddedLines(undefined)).toEqual([]);
  });

  it("returns an empty array when there are no added lines at all", () => {
    expect(extractAddedLines("@@\n-removed\n context")).toEqual([]);
  });

  it("agrees with addedLineCount's count on the same patch (regression: the two must never drift)", () => {
    const patch = "+++ b/file.ts\n@@\n+one\n+two\n-three\n context\n+four";
    expect(extractAddedLines(patch)).toHaveLength(addedLineCount(patch));
  });
});

describe("totalAddedLineCount — sums added lines across PR files (#2065)", () => {
  it("uses GitHub additions metadata for patchless files so oversized diffs cannot bypass caps", () => {
    expect(totalAddedLineCount([
      { patch: "@@\n+a\n+b" },
      { additions: 5, patch: null },
      { payload: { additions: 7 } },
      { payload: { patch: "@@\n+c" } },
      { patch: null },
      { payload: {} },
      {},
    ])).toBe(15);
    expect(totalAddedLineCount([])).toBe(0);
  });

  it("falls back to patches when additions metadata is absent or non-numeric", () => {
    expect(totalAddedLineCount([
      { additions: null, patch: "@@\n+a" },
      { additions: Number.NaN, patch: "@@\n+b" },
      { additions: Number.POSITIVE_INFINITY, patch: "@@\n+c" },
      { payload: { additions: "4", patch: "@@\n+d" } },
      { payload: { additions: null, patch: "@@\n+e" } },
    ])).toBe(5);
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
    // BOTH hunks over-counts by one and wrongly drops the second even though it fits. No hunk is dropped, so
    // no notice is emitted and the exact patch survives.
    const patch = "@@ a\n+x\n+y\n@@ b\n+p\n+q";
    expect(patch.length).toBe(21);
    expect(keepHighSignalHunks(patch, 21)).toBe(patch); // no hunk dropped, no notice
  });

  it("keeps kept-hunks + the dropped notice within budget when a hunk is dropped (#10017)", () => {
    // A high-signal hunk and a bigger low-signal one. The budget fits the high-signal hunk AND the dropped
    // notice, but not both hunks -- the returned string (kept + notice) must stay within budget.
    const highSignal = "@@ hi\n+a\n+b\n+c";
    const lowSignal = `@@ lo\n${" ctx".repeat(30)}`;
    const budget = highSignal.length + 40; // room for the high-signal hunk + the ~35-char notice
    const out = keepHighSignalHunks(`${lowSignal}\n${highSignal}`, budget);
    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out).toContain("+a"); // the high-signal hunk survives
    expect(out).toContain("dropped");
  });
});

describe("keepHighSignalHunks — non-positive budget guard (#5849)", () => {
  it("returns only the truncation marker when the budget is zero", () => {
    expect(keepHighSignalHunks("@@ a\n+x\n+y", 0)).toBe("… (this file's diff truncated)");
  });

  it("returns only the truncation marker when the budget is negative (e.g. a header already overran remaining)", () => {
    expect(keepHighSignalHunks("@@ a\n+x\n+y", -25)).toBe("… (this file's diff truncated)");
  });

  it("head-slices a single oversized hunk rather than dropping it whole, reserving the notice (#10017)", () => {
    // No second "@@" header → hunks.length <= 1, so the single-hunk branch head-slices to fit the budget.
    // The slice reserves the truncation notice's length so slice + notice stays within budget.
    const single = `@@ only\n${"+padding line\n".repeat(20)}`;
    const budget = 120;
    const out = keepHighSignalHunks(single, budget);
    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out.startsWith("@@ only")).toBe(true); // real content, head-sliced
    expect(out).toContain("… (this file's diff truncated)");
  });
});

describe("keepHighSignalHunks never exceeds budget (#10017)", () => {
  it("two hunks, smallest 500 chars, budget 100: returns <= 100 with a char of the higher-signal hunk", () => {
    const highSignal = `@@ hi\n${"+critical\n".repeat(60)}`; // most added lines -> highest signal
    const lowSignal = `@@ lo\n${" context line\n".repeat(40)}`; // >= 500 chars, no added lines
    expect(lowSignal.length).toBeGreaterThanOrEqual(500);
    const out = keepHighSignalHunks(`${lowSignal}\n${highSignal}`, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    // At least one character of the high-signal hunk's added lines survives.
    expect(out).toContain("+critical");
  });

  it("single-hunk path with budget 50 over a 5,000-char patch returns <= 50", () => {
    const single = `@@ only\n${"+padding\n".repeat(600)}`; // > 5,000 chars, one hunk
    expect(single.length).toBeGreaterThan(5000);
    expect(keepHighSignalHunks(single, 50).length).toBeLessThanOrEqual(50);
  });

  it("returns a single hunk unchanged when it already fits the budget", () => {
    const single = "@@ only\n+a\n+b"; // one hunk, well under budget
    expect(keepHighSignalHunks(single, 1000)).toBe(single);
  });

  it("single-hunk path with a budget smaller than the notice returns just the (truncated) notice, still <= budget", () => {
    const single = `@@ only\n${"+padding\n".repeat(50)}`;
    const budget = 10; // < the ~30-char truncation notice, so there is no room for content
    const out = keepHighSignalHunks(single, budget);
    expect(out.length).toBeLessThanOrEqual(budget);
    expect("… (this file's diff truncated)").toContain(out); // a prefix of the notice
  });

  it("holds the invariant across a spread of budgets and hunk counts", () => {
    const hunks = Array.from({ length: 6 }, (_, i) => `@@ h${i}\n${`+line${i}\n`.repeat(i + 1)}`).join("\n");
    for (const budget of [1, 10, 37, 50, 100, 500]) {
      expect(keepHighSignalHunks(hunks, budget).length).toBeLessThanOrEqual(budget);
    }
  });
});

describe("buildUnifiedReviewDiff — header defaults + budget-floor truncation (#5849)", () => {
  it("defaults missing additions/deletions to +0/-0 and a missing status to 'modified'", () => {
    const diff = buildUnifiedReviewDiff([{ path: "src/a.ts", patch: "@@ a\n+x" }]);
    expect(diff).toContain("### src/a.ts (modified) +0/-0");
  });

  it("uses the provided additions/deletions counts when present", () => {
    const diff = buildUnifiedReviewDiff([{ path: "src/a.ts", patch: "@@ a\n+x", status: "added", additions: 3, deletions: 1 }]);
    expect(diff).toContain("### src/a.ts (added) +3/-1");
  });

  it("stops with a truncation notice once the remaining budget falls below the per-file floor", () => {
    const big = `@@ big\n${"+line of added content\n".repeat(30)}`;
    const diff = buildUnifiedReviewDiff(
      [
        { path: "src/a.ts", patch: big, status: "modified", additions: 30, deletions: 0 },
        { path: "src/b.ts", patch: big, status: "modified", additions: 30, deletions: 0 },
      ],
      320,
    );
    expect(diff).toContain("…diff truncated (2 files total)");
  });

  it("lists a patch-less file with its (defaulted) counts instead of dropping it", () => {
    const diff = buildUnifiedReviewDiff([{ path: "logo.bin", patch: undefined, status: "added" }]);
    expect(diff).toContain("### logo.bin (added) +0/-0");
    expect(diff).toContain("(no inline patch — binary or too large)");
  });

  it("never returns a string longer than budget, even with the truncation notice appended (#10017)", () => {
    const big = `@@ big\n${"+line of added content\n".repeat(30)}`;
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts`, patch: big, status: "modified", additions: 30, deletions: 0 }));
    for (const budget of [50, 120, 300, 320, 700, 2000]) {
      expect(buildUnifiedReviewDiff(files, budget).length).toBeLessThanOrEqual(budget);
    }
  });
});
