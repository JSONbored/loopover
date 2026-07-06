import { describe, expect, it } from "vitest";
import {
  LOCAL_WRITE_BOUNDARY,
  buildApplyLabelsSpec,
  buildCreateBranchSpec,
  buildDeleteBranchSpec,
  buildFileIssueSpec,
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
