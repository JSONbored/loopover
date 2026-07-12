import { describe, expect, it, vi } from "vitest";

// src/mcp/local-write-tools.ts is now a thin re-export of packages/gittensory-engine/src/miner/local-write-
// tools.ts (#2337 -- moved to the shared engine so the miner CLI's own driving loop can import it directly with
// no network round-trip). Without this redirect, the package-specifier re-export resolves through the engine's
// published dist/ output, not its .ts source, so v8 coverage cannot attribute hits back to the source file --
// same fix as miner-coding-agent-house-rules.test.ts / miner-harness-submission-trigger.test.ts already apply.
vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  LOCAL_WRITE_BOUNDARY,
  buildApplyLabelsSpec,
  buildClosePrSpec,
  buildCreateBranchSpec,
  buildDeleteBranchSpec,
  buildFileIssueSpec,
  buildFollowUpIssueSpec,
  buildOpenPrSpec,
  buildPostEligibilityCommentSpec,
  buildTestGenSpec,
} from "../../src/mcp/local-write-tools";

describe("local write-tool specs (#780)", () => {
  it("open_pr builds a shell-safe gh command and carries the local-execution boundary", () => {
    const s = buildOpenPrSpec({ repoFullName: "o/r", base: "main", head: "feat/x", title: "Add thing", body: "Body", draft: false });
    expect(s.action).toBe("open_pr");
    expect(s.command).toBe("gh pr create --repo 'o/r' --base 'main' --head 'feat/x' --title 'Add thing' --body 'Body'");
    expect(s.boundary).toBe(LOCAL_WRITE_BOUNDARY);
    expect(s.inputs).toMatchObject({ repoFullName: "o/r", draft: false });
  });

  it("open_pr appends --draft and POSIX-escapes embedded single quotes", () => {
    const s = buildOpenPrSpec({ repoFullName: "o/r", base: "main", head: "h", title: "it's a fix", body: "x", draft: true });
    expect(s.command).toContain("--title 'it'\\''s a fix'");
    expect(s.command.endsWith("--draft")).toBe(true);
  });

  it("close_pr closes with a preceding comment when one is supplied", () => {
    const s = buildClosePrSpec({ repoFullName: "o/r", number: 7, comment: "Closing: lost the claim to #5" });
    expect(s.action).toBe("close_pr");
    expect(s.command).toBe("gh pr comment 7 --repo 'o/r' --body 'Closing: lost the claim to #5' && gh pr close 7 --repo 'o/r'");
    expect(s.boundary).toBe(LOCAL_WRITE_BOUNDARY);
    expect(s.inputs).toEqual({ repoFullName: "o/r", number: 7, comment: "Closing: lost the claim to #5" });
  });

  it("close_pr omits the comment step entirely when no comment is supplied", () => {
    const s = buildClosePrSpec({ repoFullName: "o/r", number: 7 });
    expect(s.command).toBe("gh pr close 7 --repo 'o/r'");
    expect(s.inputs).toEqual({ repoFullName: "o/r", number: 7 });
  });

  it("file_issue includes each label as a --label arg, and omits them when none", () => {
    expect(buildFileIssueSpec({ repoFullName: "o/r", title: "T", body: "B", labels: ["bug", "good first issue"] }).command).toBe(
      "gh issue create --repo 'o/r' --title 'T' --body 'B' --label 'bug' --label 'good first issue'",
    );
    expect(buildFileIssueSpec({ repoFullName: "o/r", title: "T", body: "B" }).command).toBe("gh issue create --repo 'o/r' --title 'T' --body 'B'");
  });

  it("apply_labels targets the number with --add-label", () => {
    expect(buildApplyLabelsSpec({ repoFullName: "o/r", number: 7, labels: ["x", "y"] }).command).toBe("gh issue edit 7 --repo 'o/r' --add-label 'x' --add-label 'y'");
  });

  it("post_eligibility_comment posts on the target number", () => {
    const s = buildPostEligibilityCommentSpec({ repoFullName: "o/r", number: 7, body: "context" });
    expect(s.action).toBe("post_eligibility_comment");
    expect(s.command).toBe("gh issue comment 7 --repo 'o/r' --body 'context'");
  });

  it("create_branch works with and without a base", () => {
    expect(buildCreateBranchSpec({ branch: "feat/x" }).command).toBe("git switch -c 'feat/x'");
    expect(buildCreateBranchSpec({ branch: "feat/x", base: "main" }).command).toBe("git switch -c 'feat/x' 'main'");
  });

  it("delete_branch is local-only by default, remote-deleting when asked", () => {
    expect(buildDeleteBranchSpec({ branch: "feat/x" }).command).toBe("git branch -D 'feat/x'");
    expect(buildDeleteBranchSpec({ branch: "feat/x", remote: true }).command).toBe("git branch -D 'feat/x' && git push origin --delete 'feat/x'");
  });
});

// #2188 (boundary-safe test-generation slice of #1972).
describe("buildTestGenSpec (#2188)", () => {
  it("returns a generate_tests spec naming the target files, framework, testDir, and criteria", () => {
    const s = buildTestGenSpec({
      repoFullName: "o/r",
      targetFiles: ["src/widget.ts"],
      framework: "vitest",
      testDir: "test/unit/",
      criteria: ["cover the null branch"],
    });
    expect(s.action).toBe("generate_tests");
    expect(s.boundary).toBe(LOCAL_WRITE_BOUNDARY);
    expect(s.description).toContain("vitest");
    expect(s.description).toContain("src/widget.ts");
    expect(s.description).toContain("under test/unit/");
    expect(s.description).toContain("cover the null branch");
    expect(s.inputs).toEqual({
      repoFullName: "o/r",
      targetFiles: ["src/widget.ts"],
      framework: "vitest",
      testDir: "test/unit/",
      criteria: ["cover the null branch"],
    });
    expect(s.command).toBe(`echo '${s.description}'`);
  });

  it("omits testDir language and defaults criteria to empty when neither is supplied (co-located convention)", () => {
    const s = buildTestGenSpec({ repoFullName: "o/r", targetFiles: ["pkg/foo.go"], framework: "go-test" });
    expect(s.description).toContain("co-located with the source it covers");
    expect(s.description).not.toContain("Boundary-safe criteria");
    expect(s.inputs).toEqual({ repoFullName: "o/r", targetFiles: ["pkg/foo.go"], framework: "go-test", testDir: null, criteria: [] });
  });

  it("lists multiple target files and POSIX-escapes an embedded single quote in the command", () => {
    const s = buildTestGenSpec({ repoFullName: "o/r", targetFiles: ["src/a.ts", "src/b.ts"], framework: "vitest", criteria: ["handle it's edge case"] });
    expect(s.description).toContain("src/a.ts, src/b.ts");
    expect(s.command).toContain("it'\\''s edge case");
  });
});

// #2177 (follow-up-issue slice of #1962).
describe("buildFollowUpIssueSpec (#2177)", () => {
  it("delegates to the file_issue spec shape, composing a bounded title/body from the finding", () => {
    const s = buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", line: 42, finding: "Null check missing before dereference." });
    expect(s.action).toBe("file_issue"); // reuses buildFileIssueSpec's exact spec shape — no new write path
    expect(s.boundary).toBe(LOCAL_WRITE_BOUNDARY);
    expect(s.command).toContain("gh issue create");
    expect(s.command).toContain("Follow up: src/a.ts:42");
    expect(s.command).toContain("Null check missing before dereference.");
  });

  it("wires the supplied label as a --label arg (point-bearing label branch)", () => {
    const s = buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", line: 1, finding: "x", label: "gittensor:bug" });
    expect(s.command).toContain("--label 'gittensor:bug'");
    expect(s.inputs.labels).toEqual(["gittensor:bug"]);
  });

  it("omits --label entirely when no label is supplied (empty-label branch)", () => {
    const s = buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", line: 1, finding: "x" });
    expect(s.command).not.toContain("--label");
    expect(s.inputs.labels).toEqual([]);
  });

  it("falls back to the bare path when no line is supplied (path-only branch)", () => {
    const s = buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", finding: "x" });
    expect(s.command).toContain("Follow up: src/a.ts'");
    expect(s.command).not.toContain("src/a.ts:");
  });

  it("falls back to the bare path when line is 0 or negative (no commentable line, mirrors fix-handoff's sentinel)", () => {
    expect(buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", line: 0, finding: "x" }).command).toContain("Follow up: src/a.ts'");
    expect(buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", line: -1, finding: "x" }).command).toContain("Follow up: src/a.ts'");
  });

  it("strips an embedded HTML-comment marker and fenced block before composing the body (public-safe)", () => {
    const finding = "<!-- gittensory:fix-handoff -->\n**Fix handoff — Blocker at `src/a.ts:42`**\nNull check missing.\n\n```suggestion\nif (!x) return null;\n```";
    const s = buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", line: 42, finding });
    expect(s.command).not.toContain("<!--");
    expect(s.command).not.toContain("```");
    expect(s.command).toContain("Null check missing.");
  });

  it("strips embedded HTML-comment markers from the path before composing public issue content", () => {
    const s = buildFollowUpIssueSpec({
      repoFullName: "o/r",
      path: "src/a<!-- hidden path payload -->.ts",
      line: 42,
      finding: "Null check missing.",
    });
    expect(s.command).not.toContain("<!--");
    expect(s.inputs.title).toBe("Follow up: src/a.ts:42");
    expect(s.inputs.body).toContain("Deferred review finding at `src/a.ts:42`");
  });

  it("POSIX-escapes an embedded single quote in the composed title/body", () => {
    const s = buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", line: 1, finding: "it's broken" });
    expect(s.command).toContain("it'\\''s broken");
  });

  it("bounds an unreasonably long finding to a fixed maximum body length", () => {
    const s = buildFollowUpIssueSpec({ repoFullName: "o/r", path: "src/a.ts", line: 1, finding: "x".repeat(10000) });
    expect(s.inputs.body).toBeDefined();
    expect((s.inputs.body as string).length).toBeLessThanOrEqual(4000);
  });
});
