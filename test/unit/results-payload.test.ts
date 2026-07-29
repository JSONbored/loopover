import { describe, expect, it } from "vitest";
import { buildResultsPayload, MAX_DIFF_PREVIEW_FILES, type IterationResult } from "../../packages/loopover-engine/src/results-payload";

describe("buildResultsPayload — packages a completed loop iteration (#4801)", () => {
  it("builds a PR link, plain-language summary, and diff preview for a completed PR", () => {
    const r: IterationResult = {
      repoFullName: "acme/widgets",
      prNumber: 12,
      title: "Uploads should retry on 5xx",
      changedFiles: [
        { path: "src/upload.ts", additions: 30, deletions: 4 },
        { path: "test/upload.test.ts", additions: 10, deletions: 1 },
      ],
      status: "merged",
    };
    const p = buildResultsPayload(r);
    expect(p.prLink).toBe("https://github.com/acme/widgets/pull/12");
    expect(p.summary).toBe("Opened PR #12 in acme/widgets: Uploads should retry on 5xx. 2 files changed (+40 / -5). Status: merged.");
    expect(p.diffPreview).toEqual([
      { path: "src/upload.ts", additions: 30, deletions: 4 },
      { path: "test/upload.test.ts", additions: 10, deletions: 1 },
    ]);
    expect(p.totals).toEqual({ files: 2, additions: 40, deletions: 5 });
  });

  it("reports no PR (and defaults status to open) when prNumber is null", () => {
    const p = buildResultsPayload({ repoFullName: "acme/widgets", prNumber: null, title: "Attempted change", changedFiles: [{ path: "a.ts" }] });
    expect(p.prLink).toBeNull();
    expect(p.summary).toBe("No pull request was opened for acme/widgets: Attempted change. 1 file changed (+0 / -0). Status: open.");
  });

  it("treats an omitted prNumber the same as null", () => {
    const p = buildResultsPayload({ repoFullName: "acme/widgets", title: "No PR", changedFiles: [] });
    expect(p.prLink).toBeNull();
    // omitted changedFiles + empty array both yield "no file changes"
    expect(p.summary).toBe("No pull request was opened for acme/widgets: No PR. no file changes. Status: open.");
  });

  it("says 'no file changes' when changedFiles is omitted entirely", () => {
    const p = buildResultsPayload({ repoFullName: "o/r", prNumber: 3, title: "Docs" });
    expect(p.totals).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(p.diffPreview).toEqual([]);
    expect(p.summary).toContain("no file changes");
  });

  it("defaults missing per-file additions/deletions to zero", () => {
    const p = buildResultsPayload({ repoFullName: "o/r", prNumber: 1, title: "t", changedFiles: [{ path: "x.ts" }] });
    expect(p.diffPreview).toEqual([{ path: "x.ts", additions: 0, deletions: 0 }]);
  });

  it("caps the diff preview at MAX_DIFF_PREVIEW_FILES while totals still count every file", () => {
    const files = Array.from({ length: MAX_DIFF_PREVIEW_FILES + 3 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 1 }));
    const p = buildResultsPayload({ repoFullName: "o/r", prNumber: 9, title: "Big change", changedFiles: files });
    expect(p.diffPreview).toHaveLength(MAX_DIFF_PREVIEW_FILES);
    expect(p.totals.files).toBe(MAX_DIFF_PREVIEW_FILES + 3);
    expect(p.summary).toContain(`${MAX_DIFF_PREVIEW_FILES + 3} files changed`); // plural
  });

  it("redacts a secret-shaped title before splicing it into the public-safe summary (#7249)", () => {
    const p = buildResultsPayload({
      repoFullName: "acme/widgets",
      prNumber: 7,
      title: "Rotate leaked key sk-ABCDEFGHIJKLMNOP123456 in config",
      changedFiles: [{ path: "src/config.ts", additions: 1, deletions: 1 }],
      status: "open",
    });
    expect(p.summary).not.toContain("sk-ABCDEFGHIJKLMNOP123456");
    expect(p.summary).toBe("Opened PR #7 in acme/widgets: Rotate leaked key [redacted] in config. 1 file changed (+1 / -1). Status: open.");
  });

  it("leaves a benign title byte-for-byte unchanged (no regression for the common case, #7249)", () => {
    const title = "Uploads should retry on 5xx";
    const p = buildResultsPayload({ repoFullName: "acme/widgets", prNumber: 12, title, changedFiles: [] });
    expect(p.summary).toBe(`Opened PR #12 in acme/widgets: ${title}. no file changes. Status: open.`);
  });

  it("#9611: a path-traversal repoFullName yields no link and an 'unknown repository' summary", () => {
    const p = buildResultsPayload({ repoFullName: "acme/widgets/../../evil", prNumber: 1, title: "t", changedFiles: [] });
    expect(p.prLink).toBeNull();
    expect(p.summary).toContain("unknown repository");
    expect(p.summary).not.toContain("../");
  });

  it("#9611: a non-positive or non-integer prNumber takes the no-PR branch (link null, valid repo still named)", () => {
    for (const prNumber of [0, -3, 2.5]) {
      const p = buildResultsPayload({ repoFullName: "acme/widgets", prNumber, title: "t", changedFiles: [] });
      expect(p.prLink).toBeNull();
      expect(p.summary).toContain("No pull request was opened for acme/widgets");
    }
  });

  it("#9611: negative/fractional additions and deletions normalize to non-negative integers", () => {
    const p = buildResultsPayload({ repoFullName: "acme/widgets", prNumber: 1, title: "t", changedFiles: [{ path: "a", additions: -5, deletions: 2.7 }] });
    expect(p.diffPreview[0]).toEqual({ path: "a", additions: 0, deletions: 2 });
    expect(p.totals).toEqual({ files: 1, additions: 0, deletions: 2 });
  });

  it("#9611: a valid repo + positive integer PR still produces the canonical link", () => {
    const p = buildResultsPayload({ repoFullName: "acme/widgets", prNumber: 42, title: "t", changedFiles: [] });
    expect(p.prLink).toBe("https://github.com/acme/widgets/pull/42");
  });
});
