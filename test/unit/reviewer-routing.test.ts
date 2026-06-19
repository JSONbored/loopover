import { describe, expect, it } from "vitest";
import { buildReviewerRouting, parseCodeowners } from "../../src/signals/reviewer-routing";

const SIMPLE_CODEOWNERS = `
# Global owner
* @globalowner

# Source files
/src/ @srcowner

# TypeScript specifically
*.ts @tsowner

# Docs
/docs/ @docowner
`;

describe("parseCodeowners", () => {
  it("parses a simple CODEOWNERS file", () => {
    const rules = parseCodeowners(SIMPLE_CODEOWNERS);
    expect(rules.length).toBeGreaterThan(0);
    // Comments and blank lines are excluded
    expect(rules.every((r) => !r.pattern.startsWith("#"))).toBe(true);
  });

  it("excludes team entries (@org/team)", () => {
    const content = `
* @alice @org/team-a
/src/ @bob @my-org/developers
`;
    const rules = parseCodeowners(content);
    expect(rules[0]?.logins).toEqual(["alice"]);
    expect(rules[1]?.logins).toEqual(["bob"]);
  });

  it("returns empty array for empty/comment-only CODEOWNERS", () => {
    expect(parseCodeowners("")).toEqual([]);
    expect(parseCodeowners("# Just a comment\n\n# Another")).toEqual([]);
  });

  it("normalises logins to lowercase", () => {
    const content = "* @Alice @BOB";
    const [rule] = parseCodeowners(content);
    expect(rule?.logins).toEqual(["alice", "bob"]);
  });

  it("skips entries that start with @ but have no name", () => {
    const content = "* @ @valid";
    const [rule] = parseCodeowners(content);
    expect(rule?.logins).toEqual(["valid"]);
  });

  it("skips owner tokens that are not @-prefixed handles", () => {
    // Bare words and email-style addresses are not GitHub handles, so they must be ignored —
    // only the @-prefixed user login is kept.
    const content = "* alice@example.com @real bareword\n";
    const [rule] = parseCodeowners(content);
    expect(rule?.logins).toEqual(["real"]);
  });

  it("skips rules with no user owners", () => {
    const content = "* @org/team-only\n/src/ @real-user";
    const rules = parseCodeowners(content);
    expect(rules.length).toBe(1);
    expect(rules[0]?.pattern).toBe("/src/");
  });
});

describe("buildReviewerRouting", () => {
  it("returns empty suggestions when CODEOWNERS is blank", () => {
    const result = buildReviewerRouting(["src/index.ts"], "");
    expect(result.suggestions).toEqual([]);
  });

  it("returns empty suggestions when no files are changed", () => {
    const result = buildReviewerRouting([], SIMPLE_CODEOWNERS);
    expect(result.suggestions).toEqual([]);
  });

  it("matches the global catch-all rule", () => {
    const codeowners = "* @globalowner\n";
    const result = buildReviewerRouting(["src/index.ts", "README.md"], codeowners);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.login).toBe("globalowner");
    expect(result.suggestions[0]?.fileCount).toBe(2);
  });

  it("later rules override earlier rules for the same file (GitHub semantics)", () => {
    const codeowners = `
* @globalowner
*.ts @tsowner
`;
    const result = buildReviewerRouting(["src/main.ts"], codeowners);
    // *.ts overrides * for .ts files
    expect(result.suggestions[0]?.login).toBe("tsowner");
    expect(result.suggestions[0]?.fileCount).toBe(1);
  });

  it("ranks reviewers by number of files they own (descending)", () => {
    const codeowners = `
/src/ @srcowner
/docs/ @docowner
`;
    const result = buildReviewerRouting(["src/a.ts", "src/b.ts", "docs/readme.md"], codeowners);
    expect(result.suggestions[0]?.login).toBe("srcowner");
    expect(result.suggestions[0]?.fileCount).toBe(2);
    expect(result.suggestions[1]?.login).toBe("docowner");
    expect(result.suggestions[1]?.fileCount).toBe(1);
  });

  it("matches anchored directory pattern for files in that directory", () => {
    const codeowners = "/src/ @srcowner\n";
    expect(buildReviewerRouting(["src/index.ts"], codeowners).suggestions[0]?.login).toBe("srcowner");
    expect(buildReviewerRouting(["src/utils/helper.ts"], codeowners).suggestions[0]?.login).toBe("srcowner");
    expect(buildReviewerRouting(["test/src/index.ts"], codeowners).suggestions).toEqual([]);
  });

  it("matches unanchored glob across any directory depth", () => {
    const codeowners = "*.ts @tsowner\n";
    expect(buildReviewerRouting(["src/foo.ts"], codeowners).suggestions[0]?.login).toBe("tsowner");
    expect(buildReviewerRouting(["deep/nested/dir/bar.ts"], codeowners).suggestions[0]?.login).toBe("tsowner");
    expect(buildReviewerRouting(["src/foo.js"], codeowners).suggestions).toEqual([]);
  });

  it("accumulates file count correctly when one reviewer owns multiple files", () => {
    const codeowners = "* @owner\n";
    const result = buildReviewerRouting(["a.ts", "b.ts", "c.ts"], codeowners);
    expect(result.suggestions[0]?.fileCount).toBe(3);
  });

  it("handles multiple owners on a single rule", () => {
    const codeowners = "* @alice @bob\n";
    const result = buildReviewerRouting(["index.ts"], codeowners);
    expect(result.suggestions.map((s) => s.login).sort()).toEqual(["alice", "bob"]);
    expect(result.suggestions.every((s) => s.fileCount === 1)).toBe(true);
  });
});

describe("buildReviewerRouting — matchesCodeownersPattern branch coverage", () => {
  it("anchored non-directory pattern matches only from repo root", () => {
    const codeowners = "/Makefile @infra\n";
    expect(buildReviewerRouting(["Makefile"], codeowners).suggestions[0]?.login).toBe("infra");
    expect(buildReviewerRouting(["src/Makefile"], codeowners).suggestions).toEqual([]);
  });

  it("unanchored directory pattern matches at any depth", () => {
    const codeowners = "docs/ @docowner\n";
    expect(buildReviewerRouting(["docs/guide.md"], codeowners).suggestions[0]?.login).toBe("docowner");
    expect(buildReviewerRouting(["nested/docs/guide.md"], codeowners).suggestions[0]?.login).toBe("docowner");
    expect(buildReviewerRouting(["src/main.ts"], codeowners).suggestions).toEqual([]);
  });

  it("double-star glob matches across any number of path segments", () => {
    const codeowners = "src/**/*.ts @tsowner\n";
    expect(buildReviewerRouting(["src/signals/foo.ts"], codeowners).suggestions[0]?.login).toBe("tsowner");
    expect(buildReviewerRouting(["src/deep/nested/dir/bar.ts"], codeowners).suggestions[0]?.login).toBe("tsowner");
    expect(buildReviewerRouting(["src/main.js"], codeowners).suggestions).toEqual([]);
  });
});

describe("buildReviewerRouting — newcomer-guard integration invariant", () => {
  it("returns suggestions that the caller can filter to exclude the PR author", () => {
    const codeowners = "* @alice @bob\n";
    const result = buildReviewerRouting(["index.ts"], codeowners);
    // Simulate: PR author is alice — caller should skip alice
    const authorLogin = "alice";
    const alreadyRequested = new Set<string>();
    const candidate = result.suggestions.find((s) => s.login !== authorLogin && !alreadyRequested.has(s.login));
    expect(candidate?.login).toBe("bob");
  });

  it("returns no candidate when all suggestions are the author or already-requested", () => {
    const codeowners = "* @alice\n";
    const result = buildReviewerRouting(["index.ts"], codeowners);
    const candidate = result.suggestions.find((s) => s.login !== "alice" && !new Set<string>().has(s.login));
    expect(candidate).toBeUndefined();
  });

  it("respects already-requested set (idempotency guard)", () => {
    const codeowners = "* @alice @bob\n";
    const result = buildReviewerRouting(["index.ts"], codeowners);
    const alreadyRequested = new Set(["alice"]);
    const candidate = result.suggestions.find((s) => s.login !== "carol" && !alreadyRequested.has(s.login));
    expect(candidate?.login).toBe("bob");
  });
});
