import { describe, expect, it } from "vitest";
import {
  buildBoundaryTestGenerationFinding,
  buildBoundaryTestGenerationSpec,
  detectBoundaryTouches,
} from "../../src/signals/boundary-test-generation";

describe("detectBoundaryTouches", () => {
  it("detects an array/index bounds pattern in an added line", () => {
    const touches = detectBoundaryTouches([{ path: "src/list.ts", patch: "@@ -1,2 +1,3 @@\n-const first = list[0];\n+const last = list[list.length - 1];\n" }]);
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ path: "src/list.ts", kind: "array_index_bounds" });
  });

  it("detects a null/undefined branch pattern in an added line", () => {
    const touches = detectBoundaryTouches([{ path: "src/user.ts", patch: "@@ -1,1 +1,2 @@\n+if (user === null) return defaultUser;\n" }]);
    expect(touches).toHaveLength(1);
    expect(touches[0]?.kind).toBe("null_or_undefined_branch");
  });

  it("detects the nullish-coalescing and optional-chaining forms of the null/undefined pattern", () => {
    expect(detectBoundaryTouches([{ path: "src/a.ts", patch: "+const count = row.count ?? 0;\n" }])).toHaveLength(1);
    expect(detectBoundaryTouches([{ path: "src/b.ts", patch: "+const name = user?.profile?.name;\n" }])).toHaveLength(1);
  });

  it("detects an empty-collection check pattern in an added line", () => {
    const touches = detectBoundaryTouches([{ path: "src/queue.ts", patch: "+if (items.length === 0) return null;\n" }]);
    expect(touches).toHaveLength(1);
    expect(touches[0]?.kind).toBe("empty_collection_check");
  });

  it("detects the isEmpty()-style empty-collection convention", () => {
    const touches = detectBoundaryTouches([{ path: "src/queue.py", patch: "+if collection.isEmpty():\n" }]);
    expect(touches).toHaveLength(1);
    expect(touches[0]?.kind).toBe("empty_collection_check");
  });

  it("only matches a single pattern per line even when multiple patterns could apply", () => {
    // This line matches BOTH the null/undefined pattern (?.) and would also match empty-collection if scanned
    // twice — the `break` after the first match must stop a double-count.
    const touches = detectBoundaryTouches([{ path: "src/mixed.ts", patch: "+if (list?.length === 0) return [];\n" }]);
    expect(touches).toHaveLength(1);
  });

  it("ignores context lines and removed lines, only matching genuinely added lines", () => {
    const patch = "@@ -1,3 +1,3 @@\n context line unrelated\n-const x = list[list.length - 1];\n context line two\n";
    expect(detectBoundaryTouches([{ path: "src/list.ts", patch }])).toHaveLength(0);
  });

  it("ignores the `+++ b/file` patch header line (double-plus), not a real added line", () => {
    const patch = "+++ b/src/list.ts\n+const ok = 1;\n";
    expect(detectBoundaryTouches([{ path: "src/list.ts", patch }])).toHaveLength(0);
  });

  it("skips a file with no patch text (fail-safe: absence of patch data is never boundary evidence)", () => {
    expect(detectBoundaryTouches([{ path: "src/list.ts" }])).toHaveLength(0);
    expect(detectBoundaryTouches([{ path: "src/list.ts", patch: null }])).toHaveLength(0);
    expect(detectBoundaryTouches([{ path: "src/list.ts", patch: "" }])).toHaveLength(0);
  });

  it("skips a non-code path (docs/config) even with a matching-looking pattern", () => {
    const touches = detectBoundaryTouches([{ path: "README.md", patch: "+if (x === null) return;\n" }]);
    expect(touches).toHaveLength(0);
  });

  it("skips a path with no path at all", () => {
    expect(detectBoundaryTouches([{ path: "", patch: "+if (x === null) return;\n" }])).toHaveLength(0);
  });

  it("skips a test file even if it touches a boundary-looking pattern (the finding is about SOURCE lacking tests)", () => {
    const touches = detectBoundaryTouches([{ path: "test/unit/list.test.ts", patch: "+expect(list[list.length - 1]).toBe(3);\n" }]);
    expect(touches).toHaveLength(0);
  });

  it("skips a line that matches no boundary pattern", () => {
    const touches = detectBoundaryTouches([{ path: "src/util.ts", patch: "+export const greeting = 'hello';\n" }]);
    expect(touches).toHaveLength(0);
  });

  it("caps at MAX_TOUCHES (20) even when far more boundary lines are present", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `+if (arr[${i}] === null) return;`).join("\n");
    const touches = detectBoundaryTouches([{ path: "src/big.ts", patch: lines }]);
    expect(touches.length).toBe(20);
  });

  it("returns only path and kind metadata, never matched source snippets", () => {
    const touches = detectBoundaryTouches([{ path: "src/long.ts", patch: "+if (x === null) return secretValue;" }]);
    expect(touches[0]).toEqual({ path: "src/long.ts", kind: "null_or_undefined_branch" });
    expect(touches[0] as Record<string, unknown>).not.toHaveProperty("snippet");
  });

  it("scans multiple files and aggregates touches across them", () => {
    const touches = detectBoundaryTouches([
      { path: "src/a.ts", patch: "+if (a === null) return;\n" },
      { path: "src/b.ts", patch: "+if (items.length === 0) return;\n" },
    ]);
    expect(touches).toHaveLength(2);
    expect(touches.map((t) => t.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns an empty array for an empty file list", () => {
    expect(detectBoundaryTouches([])).toEqual([]);
  });
});

describe("buildBoundaryTestGenerationFinding", () => {
  it("returns null when there are no boundary touches", () => {
    expect(
      buildBoundaryTestGenerationFinding({
        files: [{ path: "src/util.ts", patch: "+export const greeting = 'hello';\n" }],
      }),
    ).toBeNull();
  });

  it("returns null when boundary touches exist but test evidence is already present via testFiles", () => {
    expect(
      buildBoundaryTestGenerationFinding({
        files: [{ path: "src/list.ts", patch: "+if (items.length === 0) return null;\n" }],
        testFiles: ["test/unit/list.test.ts"],
      }),
    ).toBeNull();
  });

  it("returns null when boundary touches exist but test evidence is already present via tests", () => {
    expect(
      buildBoundaryTestGenerationFinding({
        files: [{ path: "src/list.ts", patch: "+if (items.length === 0) return null;\n" }],
        tests: ["npm run test:ci"],
      }),
    ).toBeNull();
  });

  it("returns a warning finding when boundary touches exist with no test evidence at all", () => {
    const finding = buildBoundaryTestGenerationFinding({
      files: [{ path: "src/list.ts", patch: "+if (items.length === 0) return null;\n" }],
    });
    expect(finding).not.toBeNull();
    expect(finding?.code).toBe("boundary_test_generation_available");
    expect(finding?.severity).toBe("warning");
    expect(finding?.detail).toContain("empty-collection check");
    expect(finding?.detail).toContain("src/list.ts");
    expect(finding?.publicText).toBe(finding?.detail);
  });

  it("deduplicates pattern kinds and truncates the listed path count past 5 in the detail text", () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ path: `src/file${i}.ts`, patch: "+if (x === null) return;\n" }));
    const finding = buildBoundaryTestGenerationFinding({ files });
    expect(finding?.detail).toContain("null/undefined branch");
    expect(finding?.detail).not.toContain("null/undefined branch, null/undefined branch");
    expect(finding?.detail).toContain("…");
  });

  it("builds from precomputed source-free touches when supplied", () => {
    const finding = buildBoundaryTestGenerationFinding({
      touches: [{ path: "src/list.ts", kind: "array_index_bounds" }],
    });
    expect(finding?.detail).toContain("array/index bounds");
    expect(finding?.detail).toContain("src/list.ts");
  });

  it("handles undefined tests/testFiles (absent input) the same as an empty list", () => {
    const finding = buildBoundaryTestGenerationFinding({
      files: [{ path: "src/list.ts", patch: "+if (items.length === 0) return null;\n" }],
      tests: undefined,
      testFiles: undefined,
    });
    expect(finding).not.toBeNull();
  });
});

describe("buildBoundaryTestGenerationSpec", () => {
  it("returns null for an empty touch list", () => {
    expect(buildBoundaryTestGenerationSpec([])).toBeNull();
  });

  it("builds a scaffold-tests spec with one hint per distinct pattern kind", () => {
    const spec = buildBoundaryTestGenerationSpec([
      { path: "src/list.ts", kind: "array_index_bounds" },
      { path: "src/user.ts", kind: "null_or_undefined_branch" },
    ]);
    expect(spec).not.toBeNull();
    expect(spec?.action).toBe("scaffold_boundary_tests");
    expect(spec?.hints).toHaveLength(2);
    expect(spec?.touches).toHaveLength(2);
    expect(spec?.boundary).toContain("never writes or executes test code");
  });

  it("deduplicates hints when multiple touches share the same pattern kind", () => {
    const spec = buildBoundaryTestGenerationSpec([
      { path: "src/a.ts", kind: "empty_collection_check" },
      { path: "src/b.ts", kind: "empty_collection_check" },
    ]);
    expect(spec?.hints).toHaveLength(1);
    expect(spec?.touches).toHaveLength(2);
  });
});
