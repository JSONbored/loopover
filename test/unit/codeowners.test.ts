import { describe, expect, it } from "vitest";
import { matchCodeowners, parseCodeowners, type CodeownersRule } from "../../src/github/codeowners";

describe("parseCodeowners", () => {
  it("skips blank lines and comments while preserving rule order", () => {
    const content = ["# comment", "", "   # indented", "* @global", "/src @core @backup", "docs/ @docs"].join("\n");
    expect(parseCodeowners(content)).toEqual<CodeownersRule[]>([
      { pattern: "*", owners: ["@global"] },
      { pattern: "/src", owners: ["@core", "@backup"] },
      { pattern: "docs/", owners: ["@docs"] },
    ]);
  });

  it("keeps patterns with no owners", () => {
    expect(parseCodeowners("/vendor/")).toEqual<CodeownersRule[]>([{ pattern: "/vendor/", owners: [] }]);
  });

  it("keeps non-comment owner-like tokens as patterns", () => {
    expect(parseCodeowners("@docs-owner")).toEqual<CodeownersRule[]>([{ pattern: "@docs-owner", owners: [] }]);
  });

  it("keeps escaped whitespace inside a pattern token", () => {
    expect(parseCodeowners("docs/Random\\ Stuff/ @docs")).toEqual<CodeownersRule[]>([{ pattern: "docs/Random\\ Stuff/", owners: ["@docs"] }]);
  });

  it("keeps a trailing escape in the final token", () => {
    expect(parseCodeowners("docs/escaped\\")).toEqual<CodeownersRule[]>([{ pattern: "docs/escaped\\", owners: [] }]);
  });
});

describe("matchCodeowners", () => {
  it("applies last-match-wins", () => {
    const rules = parseCodeowners(["* @global", "/src @src-team", "/src/api @api-team"].join("\n"));
    expect(matchCodeowners(rules, "src/api/handler.ts")).toEqual(["@api-team"]);
    expect(matchCodeowners(rules, "src/util.ts")).toEqual(["@src-team"]);
    expect(matchCodeowners(rules, "package.json")).toEqual(["@global"]);
  });

  it("supports anchored, directory, wildcard, and recursive rules", () => {
    expect(matchCodeowners(parseCodeowners("/build/ @builders"), "build/output.js")).toEqual(["@builders"]);
    expect(matchCodeowners(parseCodeowners("/build/ @builders"), "packages/app/build/output.js")).toEqual([]);
    expect(matchCodeowners(parseCodeowners("docs/ @docs"), "docs/guide/intro.md")).toEqual(["@docs"]);
    expect(matchCodeowners(parseCodeowners("*.ts @ts"), "src/index.ts")).toEqual(["@ts"]);
    expect(matchCodeowners(parseCodeowners("foo?.ts @single-char"), "foo1.ts")).toEqual(["@single-char"]);
    expect(matchCodeowners(parseCodeowners("/apps/**/config.yml @platform"), "apps/web/deep/config.yml")).toEqual(["@platform"]);
  });

  it("keeps shallow wildcard rules from matching nested files", () => {
    const owners = parseCodeowners("docs/* docs@example.com");
    expect(matchCodeowners(owners, "docs/getting-started.md")).toEqual(["docs@example.com"]);
    expect(matchCodeowners(owners, "docs/build-app/troubleshooting.md")).toEqual([]);
  });

  it("matches directory names anywhere when the rule is an unanchored directory", () => {
    const owners = parseCodeowners("apps/ @octocat");
    expect(matchCodeowners(owners, "apps/index.ts")).toEqual(["@octocat"]);
    expect(matchCodeowners(owners, "packages/web/apps/index.ts")).toEqual(["@octocat"]);
    expect(matchCodeowners(owners, "apps")).toEqual([]);
  });

  it("matches terminal literal patterns as directory prefixes", () => {
    const owners = parseCodeowners(["**/logs @octocat", "/apps/github @doctocat"].join("\n"));
    expect(matchCodeowners(owners, "build/logs/debug.txt")).toEqual(["@octocat"]);
    expect(matchCodeowners(owners, "apps/github/service.ts")).toEqual(["@doctocat"]);
  });

  it("normalizes paths and handles root-only patterns", () => {
    expect(matchCodeowners(parseCodeowners("/ @root"), "./src\\worker.ts")).toEqual(["@root"]);
    expect(matchCodeowners(parseCodeowners("/* @root"), "/README.md")).toEqual(["@root"]);
    expect(matchCodeowners(parseCodeowners("   /   @root"), "docs/guide.md")).toEqual(["@root"]);
    expect(matchCodeowners(parseCodeowners("* @global"), "")).toEqual([]);
  });

  it("ignores blank rules and supports slash-stripped and recursive-star patterns", () => {
    expect(matchCodeowners([{ pattern: "   ", owners: ["@nobody"] }], "src/index.ts")).toEqual([]);
    expect(matchCodeowners([{ pattern: "///", owners: ["@root"] }], "docs/guide.md")).toEqual(["@root"]);
    expect(matchCodeowners(parseCodeowners("**.ts @typescript"), "deep/nested/file.ts")).toEqual(["@typescript"]);
  });

  it("respects escaped literals and escaped whitespace in patterns", () => {
    expect(matchCodeowners(parseCodeowners("docs/Random\\ Stuff/ @docs"), "docs/Random Stuff/guide.md")).toEqual(["@docs"]);
    expect(matchCodeowners(parseCodeowners("foo\\*bar @literal-star"), "foo*bar")).toEqual(["@literal-star"]);
    expect(matchCodeowners(parseCodeowners("foo\\?bar @literal-question"), "foo?bar")).toEqual(["@literal-question"]);
    expect(matchCodeowners(parseCodeowners("foo\\?bar @literal-question"), "fooxbar")).toEqual([]);
  });

  it("rejects oversized patterns and non-matching recursive patterns", () => {
    expect(matchCodeowners([{ pattern: `${"a".repeat(513)}`, owners: ["@nobody"] }], "src/index.ts")).toEqual([]);
    expect(matchCodeowners(parseCodeowners("/src/**/config.yml @config"), "src/api/README.md")).toEqual([]);
  });

  it("matches repeated wildcard states without backtracking-sensitive regexes", () => {
    expect(matchCodeowners(parseCodeowners("a*a*a @owner"), "src/aaa")).toEqual(["@owner"]);
    expect(matchCodeowners(parseCodeowners("a*a*a @owner"), "src/bbb")).toEqual([]);
  });

  it("memoizes recursive directory and segment wildcard states", () => {
    expect(matchCodeowners(parseCodeowners("**/**/target.ts @owner"), "src/deep/target.ts")).toEqual(["@owner"]);
    expect(matchCodeowners(parseCodeowners("*a*a*a* @owner"), "src/aaaa")).toEqual(["@owner"]);
    expect(matchCodeowners(parseCodeowners("**/**/**/target.ts @owner"), "src/deep/deeper/target.ts")).toEqual(["@owner"]);
    expect(matchCodeowners(parseCodeowners("a/a/**/**/a @owner"), "a/a/b")).toEqual([]);
    expect(matchCodeowners(parseCodeowners("*a*a*a* @owner"), "aa")).toEqual([]);
    expect(matchCodeowners(parseCodeowners("*a*a*a*a* @owner"), "src/bbbb")).toEqual([]);
  });
});
